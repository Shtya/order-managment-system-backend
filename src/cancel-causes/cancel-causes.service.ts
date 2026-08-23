import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import {
  DataSource,
  EntityManager,
  IsNull,
  Not,
  Repository,
  SelectQueryBuilder,
} from "typeorm";
import {
  CancelCauseEntity,
  CancelCauseReviewStatus,
  CancelCauseSource,
  OrderCancelCauseEntity,
} from "entities/cancel-cause.entity";
import { OrderEntity, slugify } from "entities/order.entity";
import {
  CreateCancelCauseDto,
  ReviewCancelCauseDto,
  UpdateCancelCauseDto,
} from "dto/cancel-cause.dto";
import { ChangeOrderStatusDto } from "dto/order.dto";
import { tenantId } from "src/category/category.service";
import { CRUD } from "common/crud.service";
import { DateFilterUtil } from "common/date-filter.util";
import { calculatePreviousRange } from "common/healpers";
import { TranslationService } from "common/translation.service";
import * as ExcelJS from "exceljs";
import { endOfDay, startOfMonth, subDays } from "date-fns";

const SORT_WHITELIST = ["sortOrder", "created_at", "name", "updated_at"];

export type ResolvedCancelCause = {
  cause: CancelCauseEntity;
  snapshotName: string;
  isCustomSubmission: boolean;
};

@Injectable()
export class CancelCausesService {
  constructor(
    @InjectRepository(CancelCauseEntity)
    private causeRepo: Repository<CancelCauseEntity>,
    @InjectRepository(OrderCancelCauseEntity)
    private eventRepo: Repository<OrderCancelCauseEntity>,
    @InjectRepository(OrderEntity)
    private orderRepo: Repository<OrderEntity>,
    private readonly dataSource: DataSource,
    private readonly translations: TranslationService,
  ) {}

  normalizeName(name: string): string {
    return String(name || "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  }


  private pageParams(q?: any) {
    const page = Math.max(1, Number(q?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q?.limit) || 10));
    return { page, limit, skip: (page - 1) * limit };
  }

  private async findDuplicate(
    adminId: string,
    normalizedName: string,
    excludeId?: string,
    manager?: EntityManager,
  ) {
    const repo = manager
      ? manager.getRepository(CancelCauseEntity)
      : this.causeRepo;
    const qb = repo
      .createQueryBuilder("cause")
      .where("cause.adminId = :adminId", { adminId })
      .andWhere("cause.normalizedName = :normalizedName", { normalizedName })
      .andWhere("cause.reviewStatus IN (:...statuses)", {
        statuses: [
          CancelCauseReviewStatus.APPROVED,
          CancelCauseReviewStatus.PENDING,
        ],
      });
    if (excludeId) {
      qb.andWhere("cause.id != :excludeId", { excludeId });
    }
    return qb.getOne();
  }

  private applyUsageCountSelect(qb: SelectQueryBuilder<any>, q?: any) {
    const employeeId = q?.employeeId;
    const { start, end } = DateFilterUtil.getBoundaries(q?.startDate, q?.endDate);
    let expr = `SELECT COUNT(occ.id)::int FROM order_cancel_causes occ WHERE occ."cancelCauseId" = cause.id`;
    if (employeeId) {
      expr += ` AND occ."submittedByEmployeeId" = :usageEmployeeId`;
      qb.setParameter("usageEmployeeId", employeeId);
    }
    if (start) {
      expr += ` AND occ.created_at >= :usageStart`;
      qb.setParameter("usageStart", start);
    }
    if (end) {
      expr += ` AND occ.created_at <= :usageEnd`;
      qb.setParameter("usageEnd", end);
    }
    qb.addSelect(`(${expr})`, "usageCount");
  }

  async list(me: any, q?: any) {
    const adminId = tenantId(me);
    const { page, limit, skip } = this.pageParams(q);
    const sortBy = SORT_WHITELIST.includes(q?.sortBy) ? q.sortBy : "sortOrder";
    const sortOrder =
      String(q?.sortOrder || "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC";

    const qb = this.causeRepo
      .createQueryBuilder("cause")
      .leftJoin("cause.submittedByEmployee", "submitter")
      .where("cause.adminId = :adminId", { adminId })
      .addSelect("submitter.id", "submitterId")
      .addSelect("submitter.name", "submitterName");

    this.applyUsageCountSelect(qb, q);

    if (q?.search) {
      qb.andWhere(
        "(cause.name ILIKE :search OR cause.code ILIKE :search)",
        { search: `%${q.search}%` },
      );
    }
    if (q?.reviewStatus) {
      qb.andWhere("cause.reviewStatus = :reviewStatus", {
        reviewStatus: q.reviewStatus,
      });
    }
    if (q?.isActive === true || q?.isActive === "true") {
      qb.andWhere("cause.isActive = true");
    } else if (q?.isActive === false || q?.isActive === "false") {
      qb.andWhere("cause.isActive = false");
    }
    if (q?.source) {
      qb.andWhere("cause.source = :source", { source: q.source });
    }
    if (q?.submittedByEmployeeId) {
      qb.andWhere("cause.submittedByEmployeeId = :submittedByEmployeeId", {
        submittedByEmployeeId: q.submittedByEmployeeId,
      });
    }
    if (q?.employeeId) {
      const { start, end } = DateFilterUtil.getBoundaries(
        q?.startDate,
        q?.endDate,
      );
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM order_cancel_causes occ
          WHERE occ."cancelCauseId" = cause.id
            AND occ."submittedByEmployeeId" = :employeeId
            ${start ? "AND occ.created_at >= :usageStart" : ""}
            ${end ? "AND occ.created_at <= :usageEnd" : ""}
        )`,
        { employeeId: q.employeeId },
      );
    }

    const total = await qb.clone().getCount();
    const rows = await qb
      .orderBy(`cause.${sortBy}`, sortOrder as "ASC" | "DESC")
      .addOrderBy("cause.created_at", "DESC")
      .skip(skip)
      .take(limit)
      .getRawAndEntities();

    const records = rows.entities.map((cause, i) => {
      const raw = rows.raw[i];
      return {
        ...cause,
        usageCount: Number(raw?.usageCount || 0),
        submittedByEmployee: raw?.submitterId
          ? { id: raw.submitterId, name: raw.submitterName }
          : cause.submittedByEmployeeId
            ? { id: cause.submittedByEmployeeId, name: null }
            : null,
      };
    });

    return {
      total_records: total,
      current_page: page,
      per_page: limit,
      records,
    };
  }

  async listSelectable(me: any, q?: any) {
    const adminId = tenantId(me);
    const limit = Math.min(200, Math.max(1, Number(q?.limit) || 200));
    const qb = this.causeRepo
      .createQueryBuilder("cause")
      .where("cause.adminId = :adminId", { adminId })
      .andWhere("cause.reviewStatus = :status", {
        status: CancelCauseReviewStatus.APPROVED,
      })
      .andWhere("cause.isActive = true")
      .andWhere("cause.mergedIntoCauseId IS NULL")
      .orderBy("cause.sortOrder", "ASC")
      .addOrderBy("cause.name", "ASC")
      .take(limit)
      .select([
        "cause.id",
        "cause.name",
        "cause.code",
        "cause.sortOrder",
      ]);

    if (q?.search) {
      qb.andWhere(
        "(cause.name ILIKE :search OR cause.code ILIKE :search)",
        { search: `%${q.search}%` },
      );
    }

    const records = await qb.getMany();
    return { records };
  }

  async listOrderHistory(me: any, orderId: string, q?: any) {
    const adminId = tenantId(me);
    const order = await this.orderRepo.findOne({
      where: { id: orderId, adminId },
      select: ["id"],
    });
    if (!order) {
      throw new NotFoundException(
        this.translations.t("domains.orders.order_not_found"),
      );
    }

    const { page, limit, skip } = this.pageParams({
      ...q,
      limit: q?.limit || 50,
    });

    const qb = this.eventRepo
      .createQueryBuilder("occ")
      .leftJoinAndSelect("occ.submittedByEmployee", "employee")
      .leftJoinAndSelect("occ.toStatus", "toStatus")
      .where("occ.orderId = :orderId", { orderId })
      .andWhere("occ.adminId = :adminId", { adminId })
      .orderBy("occ.created_at", "DESC");

    const total = await qb.clone().getCount();
    const records = await qb.skip(skip).take(limit).getMany();

    return {
      total_records: total,
      current_page: page,
      per_page: limit,
      records,
    };
  }

  async getProductCauseBreakdown(me: any, productId: string, q?: any) {
    const adminId = tenantId(me);
    const { page, limit, skip } = this.pageParams({
      ...q,
      limit: q?.limit || 50,
    });

    const qb = this.eventsQb(adminId, { ...q, productId })
      .innerJoin("o.items", "oi")
      .innerJoin("oi.variant", "pv")
      .andWhere(`pv."productId" = :productIdJoin`, { productIdJoin: productId })
      .select(this.catalogIdExpr(), "causeId")
      .addSelect('MAX(occ."causeNameSnapshot")', "name")
      .addSelect("MAX(cause.code)", "code")
      .addSelect("MAX(cause.description)", "description")
      .addSelect('MAX(cause."reviewStatus")', "reviewStatus")
      .addSelect(`BOOL_OR(cause."isActive")`, "isActive")
      .addSelect("COUNT(DISTINCT occ.id)::int", "count")
      .addSelect('COUNT(DISTINCT occ."orderId")::int', "orderCount")
      .addSelect("COALESCE(SUM(oi.quantity), 0)::int", "quantity")
      .addSelect(
        `COUNT(DISTINCT occ.id) FILTER (WHERE occ."isCustomSubmission" = true)::int`,
        "customCount",
      )
      .addSelect("MAX(occ.created_at)", "lastOccurredAt")
      .groupBy(this.catalogIdExpr());

    const raw = await qb
      .orderBy("COUNT(DISTINCT occ.id)", "DESC")
      .offset(skip)
      .limit(limit)
      .getRawMany();

    const totalRow = await this.eventsQb(adminId, { ...q, productId })
      .select("COUNT(occ.id)::int", "total")
      .getRawOne();
    const total = this.rawNum(totalRow, "total");

    const groups = await this.eventsQb(adminId, { ...q, productId })
      .select(`COUNT(DISTINCT ${this.catalogIdExpr()})::int`, "c")
      .getRawOne();

    return {
      total,
      total_records: this.rawNum(groups, "c"),
      current_page: page,
      per_page: limit,
      records: raw.map((r) => ({
        causeId: r.causeId || r.causeid || null,
        name: r.name,
        code: r.code,
        description: r.description,
        reviewStatus: r.reviewStatus || r.reviewstatus || null,
        isActive: Boolean(r.isActive ?? r.isactive),
        count: this.rawNum(r, "count"),
        orderCount: this.rawNum(r, "orderCount", "ordercount"),
        quantity: this.rawNum(r, "quantity"),
        customCount: this.rawNum(r, "customCount", "customcount"),
        lastOccurredAt: r.lastOccurredAt || r.lastoccurredat || null,
        percent:
          total === 0
            ? 0
            : parseFloat(((this.rawNum(r, "count") / total) * 100).toFixed(2)),
      })),
    };
  }

  async listPending(me: any, q?: any) {
    return this.list(me, { ...q, reviewStatus: CancelCauseReviewStatus.PENDING });
  }

  async get(me: any, id: string) {
    const adminId = tenantId(me);
    const cause = await this.causeRepo.findOne({
      where: { id, adminId },
      relations: ["submittedByEmployee", "reviewedBy", "mergedIntoCause"],
    });
    if (!cause) {
      throw new NotFoundException(
        this.translations.t("domains.cancel_causes.not_found"),
      );
    }
    const usageCount = await this.eventRepo.count({
      where: { cancelCauseId: id },
    });
    return { ...cause, usageCount };
  }

  async create(me: any, dto: CreateCancelCauseDto) {
    const adminId = tenantId(me);
    const name = dto.name.trim();
    const normalizedName = this.normalizeName(name);
    const duplicate = await this.findDuplicate(adminId, normalizedName);
    if (duplicate) {
      throw new BadRequestException(
        this.translations.t("domains.cancel_causes.name_exists"),
      );
    }

    const cause = this.causeRepo.create({
      adminId,
      name,
      normalizedName,
      code: slugify(name).slice(0, 200),
      description: dto.description?.trim() || null,
      sortOrder: dto.sortOrder ?? 0,
      isActive: dto.isActive ?? true,
      source: CancelCauseSource.ADMIN,
      reviewStatus: CancelCauseReviewStatus.APPROVED,
    });
    return this.causeRepo.save(cause);
  }

  async update(me: any, id: string, dto: UpdateCancelCauseDto) {
    const adminId = tenantId(me);
    const cause = await this.causeRepo.findOne({ where: { id, adminId } });
    if (!cause) {
      throw new NotFoundException(
        this.translations.t("domains.cancel_causes.not_found"),
      );
    }

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      const normalizedName = this.normalizeName(name);
      const duplicate = await this.findDuplicate(
        adminId,
        normalizedName,
        cause.id,
      );
      if (duplicate) {
        throw new BadRequestException(
          this.translations.t("domains.cancel_causes.name_exists"),
        );
      }
      cause.name = name;
      cause.normalizedName = normalizedName;
      cause.code = slugify(name).slice(0, 200);
    }
    if (dto.description !== undefined) {
      cause.description = dto.description?.trim() || null;
    }
    if (dto.sortOrder !== undefined) cause.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined) cause.isActive = dto.isActive;

    return this.causeRepo.save(cause);
  }

  async remove(me: any, id: string) {
    const adminId = tenantId(me);
    const cause = await this.causeRepo.findOne({ where: { id, adminId } });
    if (!cause) {
      throw new NotFoundException(
        this.translations.t("domains.cancel_causes.not_found"),
      );
    }
    if (cause.reviewStatus === CancelCauseReviewStatus.PENDING) {
      throw new BadRequestException(
        this.translations.t("domains.cancel_causes.reject_instead_of_delete"),
      );
    }
    const usageCount = await this.eventRepo.count({
      where: { cancelCauseId: id },
    });
    if (usageCount > 0) {
      cause.isActive = false;
      await this.causeRepo.save(cause);
      return {
        message: this.translations.t("domains.cancel_causes.disabled_in_use"),
        disabled: true,
      };
    }
    return CRUD.delete(this.causeRepo, "cancel_causes", id);
  }

  async accept(me: any, id: string, dto: ReviewCancelCauseDto) {
    const adminId = tenantId(me);
    const cause = await this.causeRepo.findOne({ where: { id, adminId } });
    if (!cause) {
      throw new NotFoundException(
        this.translations.t("domains.cancel_causes.not_found"),
      );
    }
    if (cause.reviewStatus !== CancelCauseReviewStatus.PENDING) {
      throw new BadRequestException(
        this.translations.t("domains.cancel_causes.not_pending"),
      );
    }

    if (dto.name?.trim()) {
      const name = dto.name.trim();
      cause.name = name;
      cause.normalizedName = this.normalizeName(name);
      cause.code = slugify(name).slice(0, 200);
    }
    if (dto.description !== undefined) {
      cause.description = dto.description?.trim() || null;
    }

    const duplicate = await this.causeRepo.findOne({
      where: {
        adminId,
        normalizedName: cause.normalizedName,
        reviewStatus: CancelCauseReviewStatus.APPROVED,
        id: Not(cause.id),
      },
    });

    cause.reviewStatus = CancelCauseReviewStatus.APPROVED;
    cause.reviewedById = me?.id || null;
    cause.reviewedAt = new Date();
    cause.reviewNote = dto.reviewNote?.trim() || null;

    if (duplicate) {
      cause.mergedIntoCauseId = duplicate.id;
      cause.isActive = false;
    } else {
      cause.mergedIntoCauseId = null;
      cause.isActive = true;
    }

    return this.causeRepo.save(cause);
  }

  async reject(me: any, id: string, dto: ReviewCancelCauseDto) {
    const adminId = tenantId(me);
    const cause = await this.causeRepo.findOne({ where: { id, adminId } });
    if (!cause) {
      throw new NotFoundException(
        this.translations.t("domains.cancel_causes.not_found"),
      );
    }
    if (cause.reviewStatus !== CancelCauseReviewStatus.PENDING) {
      throw new BadRequestException(
        this.translations.t("domains.cancel_causes.not_pending"),
      );
    }
    cause.reviewStatus = CancelCauseReviewStatus.REJECTED;
    cause.isActive = false;
    cause.reviewedById = me?.id || null;
    cause.reviewedAt = new Date();
    cause.reviewNote = dto.reviewNote?.trim() || null;
    if (dto.description !== undefined) {
      cause.description = dto.description?.trim() || null;
    }
    return this.causeRepo.save(cause);
  }

  async export(me: any, q?: any) {
    const all = await this.list(me, { ...q, page: 1, limit: 1000 });
  
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(
      this.translations.t("domains.cancel_causes.excel_sheet"),
    );
    worksheet.columns = [
      { header: "Name", key: "name", width: 30 },
      { header: "Description", key: "description", width: 30 },
      { header: "Code", key: "code", width: 24 },
      { header: "Status", key: "reviewStatus", width: 14 },
      { header: "Source", key: "source", width: 12 },
      { header: "Active", key: "isActive", width: 10 },
      { header: "Usage", key: "usageCount", width: 10 },
    ];
    all.records.forEach((row: any) => {
      worksheet.addRow({
        name: row.name,
        description: row.description,
        code: row.code,
        reviewStatus: row.reviewStatus,
        source: row.source,
        isActive: row.isActive,
        usageCount: row.usageCount,
      });
    });
    return workbook.xlsx.writeBuffer();
  }

  private parseCauseFields(dto: ChangeOrderStatusDto) {
    const cancelCauseId = dto.cancelCauseId?.trim() || "";
    const customCauseName = dto.customCauseName?.trim() || "";
    return { cancelCauseId, customCauseName };
  }

  async resolveCancellationCause(
    manager: EntityManager,
    params: {
      adminId: string;
      employeeId?: string;
      dto: ChangeOrderStatusDto;
      required: boolean;
    },
  ): Promise<ResolvedCancelCause | null> {
    const { cancelCauseId, customCauseName } = this.parseCauseFields(params.dto);
    const hasId = !!cancelCauseId;
    const hasCustom = !!customCauseName;

    if (!hasId && !hasCustom) {
      if (params.required) {
        throw new BadRequestException(
          this.translations.t("domains.orders.cancel_cause_required"),
        );
      }
      return null;
    }
    if (hasId && hasCustom) {
      throw new BadRequestException(
        this.translations.t("domains.orders.cancel_cause_xor"),
      );
    }

    const repo = manager.getRepository(CancelCauseEntity);

    if (hasId) {
      let cause = await repo.findOne({
        where: { id: cancelCauseId, adminId: params.adminId },
      });
      if (!cause) {
        throw new BadRequestException(
          this.translations.t("domains.orders.cancel_cause_invalid"),
        );
      }

      const MAX_MERGE_DEPTH = 10;
      const seen = new Set<string>([cause.id]);
      let depth = 0;
      
      while (cause.mergedIntoCauseId && depth < MAX_MERGE_DEPTH) {
        if (seen.has(cause.mergedIntoCauseId)) break;
      
        seen.add(cause.mergedIntoCauseId);
      
        const main = await repo.findOne({
          where: {
            id: cause.mergedIntoCauseId,
            adminId: params.adminId,
          },
        });
      
        if (!main) break;
      
        cause = main;
        depth++;
      }

      if (
        cause.reviewStatus !== CancelCauseReviewStatus.APPROVED ||
        !cause.isActive ||
        cause.mergedIntoCauseId
      ) {
        throw new BadRequestException(
          this.translations.t("domains.orders.cancel_cause_invalid"),
        );
      }
      return {
        cause,
        snapshotName: cause.name,
        isCustomSubmission: false,
      };
    }

    const normalizedName = this.normalizeName(customCauseName);
    const approved = await repo.findOne({
      where: {
        adminId: params.adminId,
        normalizedName,
        reviewStatus: CancelCauseReviewStatus.APPROVED,
        isActive: true,
        mergedIntoCauseId: IsNull(),
      },
    });
    if (approved) {
      return {
        cause: approved,
        snapshotName: customCauseName,
        isCustomSubmission: false,
      };
    }

    const pending = await repo.findOne({
      where: {
        adminId: params.adminId,
        normalizedName,
        reviewStatus: CancelCauseReviewStatus.PENDING,
      },
    });
    if (pending) {
      return {
        cause: pending,
        snapshotName: customCauseName,
        isCustomSubmission: true,
      };
    }

    const created = repo.create({
      adminId: params.adminId,
      name: customCauseName,
      normalizedName,
      code: slugify(customCauseName).slice(0, 200),
      source: CancelCauseSource.EMPLOYEE,
      reviewStatus: CancelCauseReviewStatus.PENDING,
      isActive: false,
      submittedByEmployeeId: params.employeeId || null,
      sortOrder: 0,
    });
    const cause = await repo.save(created);
    return {
      cause,
      snapshotName: customCauseName,
      isCustomSubmission: true,
    };
  }

  async applyCancellationCause(
    manager: EntityManager,
    params: {
      adminId: string;
      order: OrderEntity;
      employeeId?: string;
      resolved: ResolvedCancelCause;
      historyId?: string | null;
      toStatusId: string;
    },
  ) {
    const eventRepo = manager.getRepository(OrderCancelCauseEntity);
    const orderRepo = manager.getRepository(OrderEntity);
    const now = new Date();

    const event = eventRepo.create({
      adminId: params.adminId,
      orderId: params.order.id,
      cancelCauseId: params.resolved.cause.id,
      causeNameSnapshot: params.resolved.snapshotName,
      causeCodeSnapshot: params.resolved.cause.code || null,
      isCustomSubmission: params.resolved.isCustomSubmission,
      submittedByEmployeeId: params.employeeId || null,
      statusHistoryId: params.historyId || null,
      toStatusId: params.toStatusId,
      cancelledAfterShipping: this.orderHasShippedOut(params.order),
    });
    await eventRepo.save(event);

    params.order.lastCancelCauseId = params.resolved.cause.id;
    params.order.lastCancelCauseText = params.resolved.snapshotName;
    params.order.cancelledAt = now;
    await orderRepo.save(params.order);

    return event;
  }

  composeHistoryNotes(
    snapshotName: string,
    notes?: string | null,
  ): string {
    const extra = notes?.trim();
    return extra ? `${snapshotName} — ${extra}` : snapshotName;
  }

  private rawNum(row: any, ...keys: string[]): number {
    if (!row) return 0;
    for (const key of keys) {
      const value = row[key];
      if (value !== undefined && value !== null && value !== "") {
        return Number(value);
      }
    }
    return 0;
  }

  private eventDateBounds(
    q?: any,
    dateQ?: { startDate?: string | Date; endDate?: string | Date },
  ) {
    const src = dateQ || q;
    return DateFilterUtil.getBoundaries(src?.startDate, src?.endDate);
  }

  private hasFilterValue(value?: string) {
    return Boolean(value) && value !== "all";
  }

  private hasShippedOutSql(orderAlias = "o") {
    return `(${orderAlias}."shippedAt" IS NOT NULL)`;
  }

  private afterShippingExpr(occAlias = "occ", orderAlias = "o") {
    return `COALESCE(${occAlias}."cancelledAfterShipping", ${this.hasShippedOutSql(orderAlias)})`;
  }

  private applyShippingTimingFilter(
    qb: SelectQueryBuilder<any>,
    q?: any,
    occAlias = "occ",
    orderAlias = "o",
  ) {
    const timing = String(q?.shippingTiming || "both");
    if (timing === "after") {
      qb.andWhere(`${this.afterShippingExpr(occAlias, orderAlias)} = true`);
    } else if (timing === "before") {
      qb.andWhere(`${this.afterShippingExpr(occAlias, orderAlias)} = false`);
    }
  }

  private shippingTimingSql(q?: any, occAlias = "occ", orderAlias = "o") {
    const timing = String(q?.shippingTiming || "both");
    if (timing === "after") {
      return ` AND ${this.afterShippingExpr(occAlias, orderAlias)} = true`;
    }
    if (timing === "before") {
      return ` AND ${this.afterShippingExpr(occAlias, orderAlias)} = false`;
    }
    return "";
  }

  private orderHasShippedOut(order: OrderEntity): boolean {
    return Boolean(order?.shippedAt);
  }

  private productExistsSql(orderIdExpr: string, productParam: string) {
    return `EXISTS (
      SELECT 1
      FROM order_items oi
      INNER JOIN product_variants pv ON pv.id = oi."variantId"
      WHERE oi."orderId" = ${orderIdExpr}
        AND pv."productId" = ${productParam}
    )`;
  }

  private applyOrderDimensionFilters(
    qb: SelectQueryBuilder<any>,
    q?: any,
    orderAlias = "o",
  ) {
    if (this.hasFilterValue(q?.storeId)) {
      if (q.storeId === "none") {
        qb.andWhere(`${orderAlias}.storeId IS NULL`);
      } else {
        qb.andWhere(`${orderAlias}.storeId = :storeId`, { storeId: q.storeId });
      }
    }
    if (this.hasFilterValue(q?.cityId)) {
      if (q.cityId === "none") {
        qb.andWhere(`${orderAlias}.cityId IS NULL`);
      } else {
        qb.andWhere(`${orderAlias}.cityId = :cityId`, { cityId: q.cityId });
      }
    }
    if (this.hasFilterValue(q?.shippingCompanyId)) {
      if (q.shippingCompanyId === "none") {
        qb.andWhere(`${orderAlias}.shippingCompanyId IS NULL`);
      } else {
        qb.andWhere(`${orderAlias}.shippingCompanyId = :shippingCompanyId`, {
          shippingCompanyId: q.shippingCompanyId,
        });
      }
    }
    if (this.hasFilterValue(q?.productId)) {
      qb.andWhere(this.productExistsSql(`${orderAlias}.id`, ":productId"), {
        productId: q.productId,
      });
    }
  }

  private eventsQb(
    adminId: string,
    q?: any,
    dateQ?: { startDate?: string | Date; endDate?: string | Date },
  ): SelectQueryBuilder<OrderCancelCauseEntity> {
    const qb = this.eventRepo
      .createQueryBuilder("occ")
      .leftJoin("occ.cancelCause", "cause")
      .leftJoin("occ.order", "o")
      .where("occ.adminId = :adminId", { adminId });

    const { start, end } = this.eventDateBounds(q, dateQ);
    DateFilterUtil.applyToQueryBuilder(
      qb,
      "occ.created_at",
      start || undefined,
      end || undefined,
    );

    if (q?.employeeId) {
      qb.andWhere(`occ."submittedByEmployeeId" = :employeeId`, {
        employeeId: q.employeeId,
      });
    }
    this.applyOrderDimensionFilters(qb, q, "o");
    this.applyShippingTimingFilter(qb, q, "occ", "o");
    if (q?.causeId) {
      qb.andWhere(
        `COALESCE(cause."mergedIntoCauseId", occ."cancelCauseId") = :causeId`,
        { causeId: q.causeId },
      );
    }
    return qb;
  }

  private catalogIdExpr() {
    return `COALESCE(cause."mergedIntoCauseId", occ."cancelCauseId")`;
  }

  private async topCauses(
    adminId: string,
    q: any,
    limit: number,
    dateQ?: { startDate?: string | Date; endDate?: string | Date },
  ) {
    const qb = this.eventsQb(adminId, q, dateQ)
      .select(this.catalogIdExpr(), "id")
      .addSelect('MAX(occ."causeNameSnapshot")', "name")
      .addSelect("COUNT(occ.id)::int", "count")
      .groupBy(this.catalogIdExpr())
      .orderBy("COUNT(occ.id)", "DESC")
      .limit(limit);
    const rows = await qb.getRawMany();
    const total = rows.reduce((s, r) => s + this.rawNum(r, "count"), 0);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      count: this.rawNum(r, "count"),
      percent:
        total === 0
          ? 0
          : parseFloat(((this.rawNum(r, "count") / total) * 100).toFixed(2)),
    }));
  }

  private async overviewKpis(
    adminId: string,
    q?: any,
    dateQ?: { startDate?: string | Date; endDate?: string | Date },
  ) {
    const { start, end } = this.eventDateBounds(q, dateQ);
    const stats = await this.eventsQb(adminId, q, dateQ)
      .select("COUNT(occ.id)::int", "totalCancellations")
      .addSelect('COUNT(DISTINCT occ."orderId")::int', "uniqueOrdersCancelled")
      .addSelect(
        `COUNT(occ.id) FILTER (WHERE occ."isCustomSubmission" = false)::int`,
        "predefinedCount",
      )
      .addSelect(
        `COUNT(occ.id) FILTER (WHERE occ."isCustomSubmission" = true)::int`,
        "customSubmissionCount",
      )
      .getRawOne();

    const totalCancellations = this.rawNum(
      stats,
      "totalCancellations",
      "totalcancellations",
    );
    const uniqueOrdersCancelled = this.rawNum(
      stats,
      "uniqueOrdersCancelled",
      "uniqueorderscancelled",
    );
    const predefinedCount = this.rawNum(
      stats,
      "predefinedCount",
      "predefinedcount",
    );
    const customSubmissionCount = this.rawNum(
      stats,
      "customSubmissionCount",
      "customsubmissioncount",
    );

    const ordersQb = this.orderRepo
      .createQueryBuilder("o")
      .where("o.adminId = :adminId", { adminId });
    DateFilterUtil.applyToQueryBuilder(
      ordersQb,
      "o.created_at",
      start || undefined,
      end || undefined,
    );
    this.applyOrderDimensionFilters(ordersQb, q, "o");
    const totalOrdersInPeriod = await ordersQb.getCount();
    const cancellationRate =
      totalOrdersInPeriod === 0
        ? 0
        : parseFloat(
            ((totalCancellations / totalOrdersInPeriod) * 100).toFixed(2),
          );

    const afterShippingStats = await this.eventsQb(
      adminId,
      { ...q, shippingTiming: "after" },
      dateQ,
    )
      .select("COUNT(occ.id)::int", "afterShippingCancellations")
      .addSelect(
        'COUNT(DISTINCT occ."orderId")::int',
        "uniqueOrdersCancelledAfterShipping",
      )
      .getRawOne();
    const afterShippingCancellations = this.rawNum(
      afterShippingStats,
      "afterShippingCancellations",
      "aftershippingcancellations",
    );
    const uniqueOrdersCancelledAfterShipping = this.rawNum(
      afterShippingStats,
      "uniqueOrdersCancelledAfterShipping",
      "uniqueorderscancelledaftershipping",
    );

    const beforeShippingStats = await this.eventsQb(
      adminId,
      { ...q, shippingTiming: "before" },
      dateQ,
    )
      .select("COUNT(occ.id)::int", "beforeShippingCancellations")
      .addSelect(
        'COUNT(DISTINCT occ."orderId")::int',
        "uniqueOrdersCancelledBeforeShipping",
      )
      .getRawOne();
    const beforeShippingCancellations = this.rawNum(
      beforeShippingStats,
      "beforeShippingCancellations",
      "beforeshippingcancellations",
    );
    const uniqueOrdersCancelledBeforeShipping = this.rawNum(
      beforeShippingStats,
      "uniqueOrdersCancelledBeforeShipping",
      "uniqueorderscancelledbeforeshipping",
    );

    const shippedOrdersQb = this.orderRepo
      .createQueryBuilder("o")
      .where("o.adminId = :adminId", { adminId })
      .andWhere("o.shippedAt IS NOT NULL");
    DateFilterUtil.applyToQueryBuilder(
      shippedOrdersQb,
      "o.shippedAt",
      start || undefined,
      end || undefined,
    );
    this.applyOrderDimensionFilters(shippedOrdersQb, q, "o");
    const shippedOrdersInPeriod = await shippedOrdersQb.getCount();
    const beforeShippingCancelRate =
      totalOrdersInPeriod === 0
        ? 0
        : parseFloat(
            (
              (uniqueOrdersCancelledBeforeShipping / totalOrdersInPeriod) *
              100
            ).toFixed(2),
          );
    const afterShippingCancelRate =
      totalOrdersInPeriod === 0
        ? 0
        : parseFloat(
            (
              (uniqueOrdersCancelledAfterShipping / totalOrdersInPeriod) *
              100
            ).toFixed(2),
          );
    const afterShippingCancelRateOfShipped =
      shippedOrdersInPeriod === 0
        ? 0
        : parseFloat(
            (
              (uniqueOrdersCancelledAfterShipping / shippedOrdersInPeriod) *
              100
            ).toFixed(2),
          );

    const top5 = await this.topCauses(adminId, q, 5, dateQ);

    return {
      totalCancellations,
      uniqueOrdersCancelled,
      predefinedCount,
      customSubmissionCount,
      mostCommonCause: top5[0] || null,
      top5,
      cancellationRate,
      totalOrdersInPeriod,
      shippedOrdersInPeriod,
      beforeShippingCancellations,
      uniqueOrdersCancelledBeforeShipping,
      afterShippingCancellations,
      uniqueOrdersCancelledAfterShipping,
      beforeShippingCancelRate,
      afterShippingCancelRate,
      afterShippingCancelRateOfShipped,
    };
  }

  async getOverviewStatistics(me: any, q?: any) {
    const adminId = tenantId(me);
    const { start, end } = DateFilterUtil.getBoundaries(q?.startDate, q?.endDate);
    const prev = calculatePreviousRange(undefined, start || undefined, end || undefined);
    const now = new Date();
    const thisMonth = {
      startDate: startOfMonth(now),
      endDate: endOfDay(now),
    };

    const [
      current,
      top5ThisMonth,
      pendingReviewCount,
      approvedCatalogCount,
      inactiveCatalogCount,
      rejectedCatalogCount,
      comparison,
    ] = await Promise.all([
      this.overviewKpis(adminId, q),
      this.topCauses(adminId, q, 5, thisMonth),
      this.causeRepo.count({
        where: { adminId, reviewStatus: CancelCauseReviewStatus.PENDING },
      }),
      this.causeRepo.count({
        where: {
          adminId,
          reviewStatus: CancelCauseReviewStatus.APPROVED,
          isActive: true,
          mergedIntoCauseId: IsNull(),
        },
      }),
      this.causeRepo.count({
        where: {
          adminId,
          reviewStatus: CancelCauseReviewStatus.APPROVED,
          isActive: false,
          mergedIntoCauseId: IsNull(),
        },
      }),
      this.causeRepo.count({
        where: { adminId, reviewStatus: CancelCauseReviewStatus.REJECTED },
      }),
      prev.start && prev.end
        ? this.overviewKpis(adminId, q, {
            startDate: prev.start,
            endDate: prev.end,
          })
        : Promise.resolve(null),
    ]);

    return {
      ...current,
      pendingReviewCount,
      approvedCatalogCount,
      inactiveCatalogCount,
      rejectedCatalogCount,
      top5ThisMonth,
      comparison,
    };
  }

  async getByCauseStatistics(me: any, q?: any) {
    const adminId = tenantId(me);
    const { page, limit, skip } = this.pageParams(q);
    const groupBy = q?.groupBy === "snapshot" ? "snapshot" : "catalog";

    const qb = this.eventsQb(adminId, q);
    if (groupBy === "snapshot") {
      qb.select('occ."causeNameSnapshot"', "name")
        .addSelect('MIN(occ."cancelCauseId")', "causeId")
        .addSelect("COUNT(occ.id)::int", "count")
        .addSelect(
          `COUNT(occ.id) FILTER (WHERE occ."isCustomSubmission" = true)::int`,
          "customSubmissionCount",
        )
        .addSelect(
          `AVG(EXTRACT(EPOCH FROM (occ.created_at - o.created_at)) / 3600)`,
          "avgHoursToCancel",
        )
        .groupBy('occ."causeNameSnapshot"');
    } else {
      qb.select(this.catalogIdExpr(), "causeId")
        .addSelect('MAX(occ."causeNameSnapshot")', "name")
        .addSelect('MAX(cause."reviewStatus")', "reviewStatus")
        .addSelect("COUNT(occ.id)::int", "count")
        .addSelect(
          `COUNT(occ.id) FILTER (WHERE occ."isCustomSubmission" = true)::int`,
          "customSubmissionCount",
        )
        .addSelect(
          `AVG(EXTRACT(EPOCH FROM (occ.created_at - o.created_at)) / 3600)`,
          "avgHoursToCancel",
        )
        .groupBy(this.catalogIdExpr());
    }

    const raw = await qb
      .orderBy("COUNT(occ.id)", "DESC")
      .offset(skip)
      .limit(limit)
      .getRawMany();

    const totalQb = this.eventsQb(adminId, q);
    const totalRow = await totalQb
      .select("COUNT(occ.id)::int", "total")
      .getRawOne();
    const total = this.rawNum(totalRow, "total");

    const countQb = this.eventsQb(adminId, q);
    if (groupBy === "snapshot") {
      countQb.select('COUNT(DISTINCT occ."causeNameSnapshot")::int', "c");
    } else {
      countQb.select(
        `COUNT(DISTINCT ${this.catalogIdExpr()})::int`,
        "c",
      );
    }
    const groups = await countQb.getRawOne();
    const total_records = this.rawNum(groups, "c");

    const records = raw.map((r) => ({
      causeId: r.causeId || r.causeid || null,
      name: r.name,
      reviewStatus: r.reviewStatus || r.reviewstatus || null,
      count: this.rawNum(r, "count"),
      percent:
        total === 0
          ? 0
          : parseFloat(((this.rawNum(r, "count") / total) * 100).toFixed(2)),
      customSubmissionCount: this.rawNum(
        r,
        "customSubmissionCount",
        "customsubmissioncount",
      ),
      avgHoursToCancel: r.avgHoursToCancel
        ? parseFloat(Number(r.avgHoursToCancel).toFixed(2))
        : 0,
    }));

    return {
      total_records,
      current_page: page,
      per_page: limit,
      records,
    };
  }

  async getTopStatistics(me: any, q?: any) {
    const adminId = tenantId(me);
    const limit = Math.min(20, Math.max(1, Number(q?.limit) || 5));
    return { records: await this.topCauses(adminId, q, limit) };
  }

  async getTopThisMonth(me: any, q?: any) {
    const now = new Date();
    return this.getTopStatistics(me, {
      ...q,
      startDate: startOfMonth(now),
      endDate: endOfDay(now),
      limit: 5,
    });
  }

  async getTopCancelledProducts(me: any, q?: any) {
    const adminId = tenantId(me);
    const limit = Math.min(20, Math.max(1, Number(q?.limit) || 8));

    const rows = await this.eventsQb(adminId, q)
      .innerJoin("o.items", "oi")
      .innerJoin("oi.variant", "pv")
      .leftJoin("pv.product", "p")
      .select(`pv."productId"`, "productId")
      .addSelect("MAX(p.name)", "name")
      .addSelect("COUNT(DISTINCT occ.id)::int", "count")
      .addSelect('COUNT(DISTINCT occ."orderId")::int', "orderCount")
      .addSelect("COALESCE(SUM(oi.quantity), 0)::int", "quantity")
      .groupBy(`pv."productId"`)
      .orderBy("COUNT(DISTINCT occ.id)", "DESC")
      .limit(limit)
      .getRawMany();

    const total = rows.reduce((s, r) => s + this.rawNum(r, "count"), 0);
    return {
      records: rows.map((r) => ({
        productId: r.productId || r.productid || null,
        name: r.name,
        count: this.rawNum(r, "count"),
        orderCount: this.rawNum(r, "orderCount", "ordercount"),
        quantity: this.rawNum(r, "quantity"),
        percent:
          total === 0
            ? 0
            : parseFloat(((this.rawNum(r, "count") / total) * 100).toFixed(2)),
      })),
    };
  }

  async getTrend(me: any, q?: any) {
    const adminId = tenantId(me);
    const interval = ["day", "week", "month"].includes(q?.interval)
      ? q.interval
      : "day";
    const step =
      interval === "month"
        ? "1 month"
        : interval === "week"
          ? "1 week"
          : "1 day";

    const bounds = this.eventDateBounds(q);
    const finalStartDate =
      bounds.start || subDays(new Date(), 30);
    const finalEndDate = bounds.end || new Date();

    const params: any[] = [finalStartDate, finalEndDate, adminId];
    let paramIndex = 4;

    let extraFilters = "";
    if (q?.employeeId) {
      extraFilters += ` AND occ."submittedByEmployeeId" = $${paramIndex++}`;
      params.push(q.employeeId);
    }
    if (this.hasFilterValue(q?.storeId)) {
      if (q.storeId === "none") {
        extraFilters += ` AND o."storeId" IS NULL`;
      } else {
        extraFilters += ` AND o."storeId" = $${paramIndex++}`;
        params.push(q.storeId);
      }
    }
    if (this.hasFilterValue(q?.cityId)) {
      if (q.cityId === "none") {
        extraFilters += ` AND o."cityId" IS NULL`;
      } else {
        extraFilters += ` AND o."cityId" = $${paramIndex++}`;
        params.push(q.cityId);
      }
    }
    if (this.hasFilterValue(q?.shippingCompanyId)) {
      if (q.shippingCompanyId === "none") {
        extraFilters += ` AND o."shippingCompanyId" IS NULL`;
      } else {
        extraFilters += ` AND o."shippingCompanyId" = $${paramIndex++}`;
        params.push(q.shippingCompanyId);
      }
    }
    if (this.hasFilterValue(q?.productId)) {
      extraFilters += ` AND ${this.productExistsSql("o.id", `$${paramIndex++}`)}`;
      params.push(q.productId);
    }
    if (q?.causeId) {
      extraFilters += ` AND COALESCE(cause."mergedIntoCauseId", occ."cancelCauseId") = $${paramIndex++}`;
      params.push(q.causeId);
    }
    extraFilters += this.shippingTimingSql(q, "occ", "o");

    const query = `
      WITH segments AS (
        SELECT
          gs AS seg_start,
          gs + '${step}'::interval AS seg_end
        FROM generate_series(
          date_trunc('${interval}', $1::timestamptz),
          date_trunc('${interval}', $2::timestamptz),
          '${step}'::interval
        ) AS gs
      ),
      events AS (
        SELECT occ.id, occ.created_at, occ."isCustomSubmission"
        FROM order_cancel_causes occ
        LEFT JOIN orders o ON o.id = occ."orderId"
        LEFT JOIN cancel_causes cause ON cause.id = occ."cancelCauseId"
        WHERE occ."adminId" = $3
        ${extraFilters}
      )
      SELECT
        s.seg_start AS "periodStart",
        COUNT(e.id)::int AS total,
        COALESCE(SUM(CASE WHEN e."isCustomSubmission" = true THEN 1 ELSE 0 END), 0)::int AS "customCount",
        COALESCE(SUM(CASE WHEN e."isCustomSubmission" = false THEN 1 ELSE 0 END), 0)::int AS "predefinedCount"
      FROM segments s
      LEFT JOIN events e
        ON e.created_at >= s.seg_start
        AND e.created_at < s.seg_end
      GROUP BY s.seg_start
      ORDER BY s.seg_start ASC
    `;

    const rows = await this.dataSource.query(query, params);

    return {
      buckets: rows.map((r) => ({
        periodStart: r.periodStart || r.periodstart,
        total: this.rawNum(r, "total"),
        customCount: this.rawNum(r, "customCount", "customcount"),
        predefinedCount: this.rawNum(r, "predefinedCount", "predefinedcount"),
      })),
    };
  }

  async getByEmployee(me: any, q?: any) {
    const adminId = tenantId(me);
    const { page, limit, skip } = this.pageParams(q);

    const rows = await this.eventsQb(adminId, q)
      .leftJoin("occ.submittedByEmployee", "emp")
      .select('occ."submittedByEmployeeId"', "employeeId")
      .addSelect("MAX(emp.name)", "employeeName")
      .addSelect("COUNT(occ.id)::int", "count")
      .addSelect(
        `COUNT(occ.id) FILTER (WHERE occ."isCustomSubmission" = true)::int`,
        "customCount",
      )
      .addSelect(
        `(ARRAY_AGG(occ."causeNameSnapshot" ORDER BY occ.created_at DESC))[1]`,
        "topCauseName",
      )
      .groupBy('occ."submittedByEmployeeId"')
      .orderBy("COUNT(occ.id)", "DESC")
      .offset(skip)
      .limit(limit)
      .getRawMany();

    const totalRow = await this.eventsQb(adminId, q)
      .select('COUNT(DISTINCT occ."submittedByEmployeeId")::int', "c")
      .getRawOne();

    return {
      total_records: this.rawNum(totalRow, "c"),
      current_page: page,
      per_page: limit,
      records: rows.map((r) => ({
        employeeId: r.employeeId || r.employeeid || null,
        employeeName: r.employeeName || r.employeename,
        count: this.rawNum(r, "count"),
        customCount: this.rawNum(r, "customCount", "customcount"),
        topCauseName: r.topCauseName || r.topcausename,
      })),
    };
  }

  async getSlaStatistics(me: any, q?: any) {
    const adminId = tenantId(me);
    const slaHours = Math.max(1, Number(q?.slaHours) || 24);

    const hoursExpr = `EXTRACT(EPOCH FROM (occ.created_at - o.created_at)) / 3600`;
    const agg = await this.eventsQb(adminId, q)
      .andWhere("o.created_at IS NOT NULL")
      .select(`AVG(${hoursExpr})`, "avgHoursToCancel")
      .addSelect(
        `percentile_cont(0.5) WITHIN GROUP (ORDER BY ${hoursExpr})`,
        "medianHoursToCancel",
      )
      .addSelect("COUNT(occ.id)::int", "total")
      .addSelect(
        `COUNT(occ.id) FILTER (WHERE ${hoursExpr} < 2)::int`,
        "lt2h",
      )
      .addSelect(
        `COUNT(occ.id) FILTER (WHERE ${hoursExpr} >= 2 AND ${hoursExpr} < 8)::int`,
        "h2to8",
      )
      .addSelect(
        `COUNT(occ.id) FILTER (WHERE ${hoursExpr} >= 8 AND ${hoursExpr} < 24)::int`,
        "h8to24",
      )
      .addSelect(
        `COUNT(occ.id) FILTER (WHERE ${hoursExpr} >= 24 AND ${hoursExpr} < 72)::int`,
        "d1to3",
      )
      .addSelect(
        `COUNT(occ.id) FILTER (WHERE ${hoursExpr} >= 72)::int`,
        "gt3d",
      )
      .addSelect(
        `COUNT(occ.id) FILTER (WHERE ${hoursExpr} > :slaHours)::int`,
        "slaBreachCount",
      )
      .setParameter("slaHours", slaHours)
      .getRawOne();

    const byCause = await this.eventsQb(adminId, q)
      .andWhere("o.created_at IS NOT NULL")
      .select(this.catalogIdExpr(), "causeId")
      .addSelect('MAX(occ."causeNameSnapshot")', "name")
      .addSelect(`AVG(${hoursExpr})`, "avgHoursToCancel")
      .addSelect(
        `percentile_cont(0.5) WITHIN GROUP (ORDER BY ${hoursExpr})`,
        "medianHoursToCancel",
      )
      .addSelect("COUNT(occ.id)::int", "count")
      .groupBy(this.catalogIdExpr())
      .orderBy("COUNT(occ.id)", "DESC")
      .limit(10)
      .getRawMany();

    const total = this.rawNum(agg, "total");
    const slaBreachCount = this.rawNum(
      agg,
      "slaBreachCount",
      "slabreachcount",
    );

    return {
      avgHoursToCancel: agg?.avgHoursToCancel ?? agg?.avghourstocancel
        ? parseFloat(
            Number(agg.avgHoursToCancel ?? agg.avghourstocancel).toFixed(2),
          )
        : 0,
      medianHoursToCancel:
        agg?.medianHoursToCancel ?? agg?.medianhourstocancel
          ? parseFloat(
              Number(
                agg.medianHoursToCancel ?? agg.medianhourstocancel,
              ).toFixed(2),
            )
          : 0,
      buckets: {
        lt2h: this.rawNum(agg, "lt2h"),
        h2to8: this.rawNum(agg, "h2to8"),
        h8to24: this.rawNum(agg, "h8to24"),
        d1to3: this.rawNum(agg, "d1to3"),
        gt3d: this.rawNum(agg, "gt3d"),
      },
      byCause: byCause.map((r) => ({
        causeId: r.causeId || r.causeid,
        name: r.name,
        count: this.rawNum(r, "count"),
        avgHoursToCancel: r.avgHoursToCancel ?? r.avghourstocancel
          ? parseFloat(
              Number(r.avgHoursToCancel ?? r.avghourstocancel).toFixed(2),
            )
          : 0,
        medianHoursToCancel:
          r.medianHoursToCancel ?? r.medianhourstocancel
            ? parseFloat(
                Number(
                  r.medianHoursToCancel ?? r.medianhourstocancel,
                ).toFixed(2),
              )
            : 0,
      })),
      slaBreachCount,
      slaBreachRate:
        total === 0
          ? 0
          : parseFloat(((slaBreachCount / total) * 100).toFixed(2)),
    };
  }

  async getCustomVsPredefined(me: any, q?: any) {
    const adminId = tenantId(me);
    const row = await this.eventsQb(adminId, q)
      .select("COUNT(occ.id)::int", "total")
      .addSelect(
        `COUNT(occ.id) FILTER (WHERE occ."isCustomSubmission" = false)::int`,
        "predefinedCount",
      )
      .addSelect(
        `COUNT(occ.id) FILTER (WHERE occ."isCustomSubmission" = true)::int`,
        "customCount",
      )
      .addSelect(
        `COUNT(occ.id) FILTER (WHERE occ."isCustomSubmission" = true AND cause."reviewStatus" = :approved)::int`,
        "acceptedCustomConverted",
      )
      .addSelect(
        `COUNT(occ.id) FILTER (WHERE occ."isCustomSubmission" = true AND cause."reviewStatus" = :rejected)::int`,
        "rejectedCustomStillOnOrders",
      )
      .setParameter("approved", CancelCauseReviewStatus.APPROVED)
      .setParameter("rejected", CancelCauseReviewStatus.REJECTED)
      .getRawOne();

    const total = this.rawNum(row, "total");
    const predefinedCount = this.rawNum(
      row,
      "predefinedCount",
      "predefinedcount",
    );
    const customCount = this.rawNum(row, "customCount", "customcount");
    return {
      total,
      predefinedCount,
      customCount,
      predefinedPercent:
        total === 0
          ? 0
          : parseFloat(((predefinedCount / total) * 100).toFixed(2)),
      customPercent:
        total === 0 ? 0 : parseFloat(((customCount / total) * 100).toFixed(2)),
      acceptedCustomConverted: this.rawNum(
        row,
        "acceptedCustomConverted",
        "acceptedcustomconverted",
      ),
      rejectedCustomStillOnOrders: this.rawNum(
        row,
        "rejectedCustomStillOnOrders",
        "rejectedcustomstillonorders",
      ),
    };
  }

  async getPendingReviewStats(me: any) {
    const adminId = tenantId(me);
    const row = await this.causeRepo
      .createQueryBuilder("cause")
      .where("cause.adminId = :adminId", { adminId })
      .andWhere("cause.reviewStatus = :status", {
        status: CancelCauseReviewStatus.PENDING,
      })
      .select("COUNT(cause.id)::int", "pendingCount")
      .addSelect("MIN(cause.created_at)", "oldestPendingAt")
      .addSelect(
        `AVG(EXTRACT(EPOCH FROM (NOW() - cause.created_at)) / 3600)`,
        "avgPendingAgeHours",
      )
      .getRawOne();

    const now = new Date();
    const submissionsThisMonthQb = this.causeRepo
      .createQueryBuilder("cause")
      .where("cause.adminId = :adminId", { adminId })
      .andWhere("cause.source = :source", {
        source: CancelCauseSource.EMPLOYEE,
      });
    DateFilterUtil.applyToQueryBuilder(
      submissionsThisMonthQb,
      "cause.created_at",
      startOfMonth(now),
      endOfDay(now),
    );
    const submissionsThisMonthCount = await submissionsThisMonthQb.getCount();

    return {
      pendingCount: Number(row?.pendingCount || 0),
      oldestPendingAt: row?.oldestPendingAt || null,
      avgPendingAgeHours: row?.avgPendingAgeHours
        ? parseFloat(Number(row.avgPendingAgeHours).toFixed(2))
        : 0,
      submissionsThisMonth: submissionsThisMonthCount,
    };
  }
}
