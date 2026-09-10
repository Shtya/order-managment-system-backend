import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Brackets, In, Repository } from "typeorm";
import * as ExcelJS from "exceljs";
import { DateFilterUtil } from "common/date-filter.util";
import { TranslationService } from "common/translation.service";
import { tenantId } from "src/category/category.service";
import {
  AssigningCondition,
  ShippingAssigningRuleEntity,
  ShippingAssigningRuleType,
} from "entities/shipping-assigning.entity";
import { ShippingCompanyEntity } from "entities/shipping.entity";
import { StoreEntity } from "entities/stores.entity";
import { CityEntity } from "entities/cities.entity";
import { ShippingService } from "src/shipping/shipping.service";
import { StoresService } from "src/stores/stores.service";
import { CitiesService } from "src/cities/cities.service";
import {
  CreateAssigningRuleDto,
  PreviewAssigningDto,
  ResolveAssigningDto,
  UpdateAssigningRuleDto,
} from "dto/shipping-assigning.dto";

export type ResolveResult = {
  companyId: string | null;
  companyName?: string | null;
  ruleId?: string;
  ruleName?: string;
  reason?: string;
};

const T = "domains.shipping_assigning";

@Injectable()
export class ShippingAssigningService {
  constructor(
    @InjectRepository(ShippingAssigningRuleEntity)
    private readonly ruleRepo: Repository<ShippingAssigningRuleEntity>,
    @InjectRepository(ShippingCompanyEntity)
    private readonly companyRepo: Repository<ShippingCompanyEntity>,
    @InjectRepository(StoreEntity)
    private readonly storeRepo: Repository<StoreEntity>,
    @InjectRepository(CityEntity)
    private readonly cityRepo: Repository<CityEntity>,
    @Inject(forwardRef(() => ShippingService))
    private readonly shippingService: ShippingService,
    @Inject(forwardRef(() => StoresService))
    private readonly storesService: StoresService,
    @Inject(forwardRef(() => CitiesService))
    private readonly citiesService: CitiesService,
    private readonly translations: TranslationService,
  ) {}

  // =========================================================================
  // Helpers — mandated data sources (§5 of plan)
  // =========================================================================

  /**
   * ONLY source for usable shipping companies.
   * Delegates to ShippingService.activeIntegrations (tenant: active + apiKey;
   * super-admin: all companies). Returns shippingCompany ids (providerId).
   */
  private async getActiveCompanyIds(
    me: any,
  ): Promise<{ ids: string[]; names: Map<string, string> }> {
    const res = await this.shippingService.activeIntegrations(me);
    const integrations = res?.integrations ?? [];
    const ids: string[] = [];
    const names = new Map<string, string>();
    for (const integ of integrations) {
      const companyId = integ.providerId ?? integ.id;
      if (!companyId || ids.includes(companyId)) continue;
      ids.push(companyId);
      if (integ.name) names.set(companyId, integ.name);
    }
    return { ids, names };
  }

  /**
   * ONLY source for stores. Delegates to StoresService.list (admin-scoped,
   * sanitized records). Used for validation membership sets.
   */
  private async getTenantStoreIds(me: any): Promise<Set<string>> {
    const { records } = await this.storesService.list(me, {
      limit: 1000,
      page: 1,
    });
    return new Set((records ?? []).map((s) => String(s.id)));
  }

  /**
   * Cities source of truth: CitiesService.findAllWithProviders (active
   * cities). Used for validation membership sets (§5.3 of plan).
   */
  private async getTenantCityIds(_me: any): Promise<Set<string>> {
    const cities = await this.citiesService.findAllWithProviders();
    return new Set((cities ?? []).map((c) => String(c.id)));
  }

  private async companyNamesById(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const companies = await this.companyRepo.find({
      where: { id: In(ids) },
    });
    return new Map(companies.map((c) => [c.id, c.name]));
  }

  private requireAdminId(me: any): string {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }
    return adminId;
  }

  private throwCompaniesNotFound(count: number): never {
    throw new BadRequestException(
      this.translations.t(
        count === 1
          ? `${T}.shipping_company_not_found`
          : `${T}.some_shipping_companies_not_found`,
      ),
    );
  }

  /**
   * Validates the merged (create or update) rule payload:
   * - equal_distribution: 1+ active companies, no condition needed.
   * - payment_method / store / city / order_total: exactly 1 active company.
   * - store: storeIds must belong to the tenant.
   * - city: cityIds must be active cities.
   */
  private async validateRulePayload(
    me: any,
    ruleType: ShippingAssigningRuleType,
    targetCompanyIds: string[] | undefined,
    condition: AssigningCondition | undefined,
    activeCompanyIds: string[],
  ): Promise<{ effectiveCompanyIds: string[]; storeIds: string[] }> {
    const explicit = targetCompanyIds ?? [];

    if (ruleType === ShippingAssigningRuleType.EQUAL_DISTRIBUTION) {
      if (!explicit.length) {
        throw new BadRequestException(
          this.translations.t(`${T}.empty_mapping`),
        );
      }
      const missing = explicit.filter((id) => !activeCompanyIds.includes(id));
      if (missing.length) this.throwCompaniesNotFound(missing.length);
      return { effectiveCompanyIds: explicit, storeIds: [] };
    }

    if (explicit.length !== 1) {
      throw new BadRequestException(
        this.translations.t(`${T}.empty_mapping`),
      );
    }
    if (!activeCompanyIds.includes(explicit[0])) {
      this.throwCompaniesNotFound(1);
    }

    let storeIds: string[] = [];
    if (ruleType === ShippingAssigningRuleType.PAYMENT_METHOD) {
      if (!condition?.paymentMethod) {
        throw new BadRequestException(
          this.translations.t(`${T}.empty_mapping`),
        );
      }
    } else if (ruleType === ShippingAssigningRuleType.STORE) {
      storeIds = [...new Set(condition?.storeIds ?? [])];
      if (!storeIds.length) {
        throw new BadRequestException(
          this.translations.t(`${T}.empty_mapping`),
        );
      }
      const tenantStoreIds = await this.getTenantStoreIds(me);
      const missing = storeIds.filter((id) => !tenantStoreIds.has(String(id)));
      if (missing.length) {
        throw new BadRequestException(
          this.translations.t(`${T}.some_stores_not_found`),
        );
      }
    } else if (ruleType === ShippingAssigningRuleType.CITY) {
      const cityIds = [...new Set(condition?.cityIds ?? [])];
      if (!cityIds.length) {
        throw new BadRequestException(
          this.translations.t(`${T}.empty_mapping`),
        );
      }
      const tenantCityIds = await this.getTenantCityIds(me);
      const missing = cityIds.filter((id) => !tenantCityIds.has(String(id)));
      if (missing.length) {
        throw new BadRequestException(
          this.translations.t(`${T}.some_cities_not_found`),
        );
      }
    } else if (ruleType === ShippingAssigningRuleType.ORDER_TOTAL) {
      const { minAmount, maxAmount } = condition ?? {};
      if (
        minAmount != null &&
        maxAmount != null &&
        Number(minAmount) > Number(maxAmount)
      ) {
        throw new BadRequestException(
          this.translations.t(`${T}.invalid_amount_range`),
        );
      }
    }

    return { effectiveCompanyIds: explicit, storeIds };
  }

  private async resolveRelations(
    dtoTargetCompanyIds: string[] | undefined,
    storeIds: string[],
  ) {
    let targetCompanies: ShippingCompanyEntity[] | undefined;
    if (dtoTargetCompanyIds !== undefined) {
      targetCompanies =
        dtoTargetCompanyIds.length > 0
          ? await this.companyRepo.find({
              where: { id: In(dtoTargetCompanyIds) },
            })
          : [];
      if (targetCompanies.length !== [...new Set(dtoTargetCompanyIds)].length) {
        this.throwCompaniesNotFound(
          dtoTargetCompanyIds.length - targetCompanies.length,
        );
      }
    }
    let stores: StoreEntity[] | undefined;
    if (storeIds.length) {
      stores = await this.storeRepo.find({ where: { id: In(storeIds) } });
      if (stores.length !== [...new Set(storeIds)].length) {
        throw new BadRequestException(
          this.translations.t(`${T}.some_stores_not_found`),
        );
      }
    }
    return { targetCompanies, stores };
  }

  // =========================================================================
  // Rules CRUD (admin-scoped, like AutoAssignRuleEntity)
  // =========================================================================

  async listRules(me: any, q?: any) {
    const adminId = this.requireAdminId(me);
    const page = Number(q?.page ?? 1);
    const limit = Number(q?.limit ?? 10);
    const search = String(q?.search ?? "").trim();

    const qb = this.ruleRepo
      .createQueryBuilder("rule")
      .leftJoinAndSelect("rule.targetCompanies", "targetCompanies")
      .leftJoinAndSelect("rule.stores", "stores")
      .where("rule.adminId = :adminId", { adminId });

    if (search) {
      qb.andWhere(
        new Brackets((sq) => {
          sq.where("rule.name ILIKE :s", { s: `%${search}%` });
        }),
      );
    }
    DateFilterUtil.applyToQueryBuilder(
      qb,
      "rule.createdAt",
      q?.startDate,
      q?.endDate,
    );
    if (q?.ruleType) {
      qb.andWhere("rule.ruleType = :ruleType", { ruleType: q.ruleType });
    }
    if (q?.isActive !== undefined && q?.isActive !== "") {
      qb.andWhere("rule.isActive = :isActive", {
        isActive: q.isActive === "true",
      });
    }
    qb.orderBy("rule.priority", "ASC").addOrderBy("rule.createdAt", "ASC");

    const total = await qb.getCount();
    const records = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();
    return { total_records: total, current_page: page, per_page: limit, records };
  }

  async createRule(me: any, dto: CreateAssigningRuleDto) {
    const adminId = this.requireAdminId(me);

    const exists = await this.ruleRepo.findOne({
      where: { adminId, name: dto.name },
    });
    if (exists) {
      throw new BadRequestException(
        this.translations.t(`${T}.rule_name_exists`),
      );
    }

    // Companies source of truth: activeIntegrations (§5.1).
    const { ids: activeCompanyIds } = await this.getActiveCompanyIds(me);
    await this.validateRulePayload(
      me,
      dto.ruleType,
      dto.targetCompanyIds,
      dto.condition as AssigningCondition | undefined,
      activeCompanyIds,
    );

    const storeIds =
      dto.ruleType === ShippingAssigningRuleType.STORE
        ? [...new Set((dto.condition?.storeIds ?? []) as string[])]
        : [];
    const { targetCompanies, stores } = await this.resolveRelations(
      dto.targetCompanyIds,
      storeIds,
    );

    const rule = this.ruleRepo.create({
      adminId,
      name: dto.name,
      description: dto.description,
      ruleType: dto.ruleType,
      isActive: dto.isActive ?? true,
      priority: dto.priority ?? 1,
      condition: (dto.condition as AssigningCondition) ?? null,
    });
    if (targetCompanies !== undefined) rule.targetCompanies = targetCompanies;
    if (stores !== undefined) rule.stores = stores;
    return this.ruleRepo.save(rule);
  }

  async getRuleDetails(me: any, ruleId: string) {
    const adminId = this.requireAdminId(me);
    const rule = await this.ruleRepo.findOne({
      where: { id: ruleId, adminId },
      relations: { targetCompanies: true, stores: true },
    });
    if (!rule) {
      throw new NotFoundException(this.translations.t(`${T}.rule_not_found`));
    }
    return rule;
  }

  async updateRule(me: any, ruleId: string, dto: UpdateAssigningRuleDto) {
    const adminId = this.requireAdminId(me);
    const rule = await this.ruleRepo.findOne({
      where: { id: ruleId, adminId },
      relations: { targetCompanies: true, stores: true },
    });
    if (!rule) {
      throw new NotFoundException(this.translations.t(`${T}.rule_not_found`));
    }

    if (dto.name && dto.name !== rule.name) {
      const exists = await this.ruleRepo.findOne({
        where: { adminId, name: dto.name },
      });
      if (exists) {
        throw new BadRequestException(
          this.translations.t(`${T}.rule_name_exists`),
        );
      }
    }

    const nextCondition = (
      dto.condition !== undefined ? dto.condition : rule.condition
    ) as AssigningCondition | undefined;
    const nextTargetIds =
      dto.targetCompanyIds !== undefined
        ? dto.targetCompanyIds
        : (rule.targetCompanies ?? []).map((c) => c.id);

    const { ids: activeCompanyIds } = await this.getActiveCompanyIds(me);
    await this.validateRulePayload(
      me,
      rule.ruleType,
      nextTargetIds,
      nextCondition,
      activeCompanyIds,
    );

    const storeIds =
      rule.ruleType === ShippingAssigningRuleType.STORE
        ? [...new Set(nextCondition?.storeIds ?? [])]
        : [];

    Object.assign(rule, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
      ...(dto.condition !== undefined
        ? { condition: dto.condition as AssigningCondition }
        : {}),
    });

    if (dto.targetCompanyIds !== undefined || storeIds.length) {
      const { targetCompanies, stores } = await this.resolveRelations(
        dto.targetCompanyIds,
        storeIds,
      );
      if (targetCompanies !== undefined) rule.targetCompanies = targetCompanies;
      if (stores !== undefined) rule.stores = stores;
    }

    return this.ruleRepo.save(rule);
  }

  async toggleRuleActive(me: any, ruleId: string) {
    const rule = await this.getRuleDetails(me, ruleId);
    rule.isActive = !rule.isActive;
    return this.ruleRepo.save(rule);
  }

  async deleteRule(me: any, ruleId: string) {
    const rule = await this.getRuleDetails(me, ruleId);
    await this.ruleRepo.remove(rule);
    return { success: true };
  }

  async getRulesStats(me: any) {
    const adminId = this.requireAdminId(me);
    const [generalStats, typeStats] = await Promise.all([
      this.ruleRepo
        .createQueryBuilder("rule")
        .select("COUNT(rule.id)", "total")
        .addSelect(
          "SUM(CASE WHEN rule.isActive = true THEN 1 ELSE 0 END)",
          "active",
        )
        .where("rule.adminId = :adminId", { adminId })
        .getRawOne(),
      this.ruleRepo
        .createQueryBuilder("rule")
        .select("rule.ruleType", "type")
        .addSelect("COUNT(rule.id)", "count")
        .where("rule.adminId = :adminId", { adminId })
        .groupBy("rule.ruleType")
        .getRawMany(),
    ]);
    const byType: Record<string, number> = {};
    for (const ts of typeStats) {
      byType[ts.type] = parseInt(ts.count, 10);
    }
    return {
      total: parseInt(generalStats?.total || "0", 10),
      active: parseInt(generalStats?.active || "0", 10),
      byType,
    };
  }

  async exportRules(me: any, q?: any) {
    const { records } = await this.listRules(me, {
      ...q,
      limit: 10000,
    });
    const companyIds = [
      ...new Set(
        (records ?? []).flatMap((r) =>
          (r.targetCompanies ?? []).map((c) => c.id),
        ),
      ),
    ];
    const names = await this.companyNamesById(companyIds);
    const cityIds = [
      ...new Set(
        (records ?? []).flatMap((r) => (r.condition?.cityIds ?? []) as string[]),
      ),
    ];
    const cityNames = new Map<string, string>();
    if (cityIds.length) {
      const cities = await this.cityRepo.find({ where: { id: In(cityIds) } });
      for (const c of cities) cityNames.set(c.id, c.nameEn || c.nameAr || c.id);
    }
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(
      this.translations.t(`${T}.export_rules_sheet`),
    );
    worksheet.columns = [
      { header: this.translations.t(`${T}.export_name`), key: "name", width: 25 },
      { header: this.translations.t(`${T}.export_type`), key: "ruleType", width: 20 },
      {
        header: this.translations.t(`${T}.export_status`),
        key: "status",
        width: 15,
      },
      {
        header: this.translations.t(`${T}.export_priority`),
        key: "priority",
        width: 10,
      },
      {
        header: this.translations.t(`${T}.export_description`),
        key: "description",
        width: 30,
      },
      {
        header: this.translations.t(`${T}.export_target_companies`),
        key: "companies",
        width: 30,
      },
      {
        header: this.translations.t(`${T}.export_stores`),
        key: "stores",
        width: 30,
      },
      {
        header: this.translations.t(`${T}.export_cities`),
        key: "cities",
        width: 30,
      },
      {
        header: this.translations.t(`${T}.export_payment_method`),
        key: "paymentMethod",
        width: 18,
      },
      {
        header: this.translations.t(`${T}.export_min_amount`),
        key: "minAmount",
        width: 15,
      },
      {
        header: this.translations.t(`${T}.export_max_amount`),
        key: "maxAmount",
        width: 15,
      },
    ];
    for (const rule of records) {
      const condition = (rule.condition ?? {}) as AssigningCondition;
      worksheet.addRow({
        name: rule.name,
        ruleType: rule.ruleType,
        status: rule.isActive
          ? this.translations.t(`${T}.status_active`)
          : this.translations.t(`${T}.status_inactive`),
        priority: rule.priority,
        description: rule.description || "—",
        companies:
          (rule.targetCompanies ?? [])
            .map((c) => names.get(c.id) ?? c.name ?? c.id)
            .join(", ") || "—",
        stores: (rule.stores ?? []).map((s) => s.name).join(", ") || "—",
        cities:
          ((condition.cityIds ?? []) as string[])
            .map((id) => cityNames.get(id) ?? id)
            .join(", ") || "—",
        paymentMethod: condition.paymentMethod || "—",
        minAmount: condition.minAmount ?? "—",
        maxAmount: condition.maxAmount ?? "—",
      });
    }
    worksheet.getRow(1).font = { bold: true };
    return workbook.xlsx.writeBuffer();
  }

  // =========================================================================
  // Resolver — pure, reusable by future automations (no automation wiring)
  // =========================================================================

  private pickNextEqual(
    rule: ShippingAssigningRuleEntity,
    target: string[],
    lastOverride?: string | null,
  ) {
    const cycle = [...target].sort();
    if (!cycle.length) return null;
    const last = lastOverride !== undefined ? lastOverride : rule.lastAssignedCompanyId;
    if (!last) return cycle[0];
    const idx = cycle.indexOf(last);
    if (idx === -1) return cycle[0];
    return cycle[(idx + 1) % cycle.length];
  }

  private matchRule(
    order: ResolveAssigningDto,
    rule: ShippingAssigningRuleEntity,
    target: string[],
    lastOverride?: string | null,
  ): string | null {
    switch (rule.ruleType) {
      case ShippingAssigningRuleType.EQUAL_DISTRIBUTION:
        return this.pickNextEqual(rule, target, lastOverride);
      case ShippingAssigningRuleType.PAYMENT_METHOD: {
        if (!rule.condition?.paymentMethod) return null;
        if (order.paymentMethod !== rule.condition.paymentMethod) return null;
        return target[0] ?? null;
      }
      case ShippingAssigningRuleType.ORDER_TOTAL: {
        const total = Number(order.finalTotal);
        if (order.finalTotal == null || Number.isNaN(total)) return null;
        const { minAmount, maxAmount } = rule.condition ?? {};
        if (minAmount != null && total < Number(minAmount)) return null;
        if (maxAmount != null && total > Number(maxAmount)) return null;
        return target[0] ?? null;
      }
      case ShippingAssigningRuleType.STORE: {
        if (!order.storeId) return null;
        const storeIds = rule.condition?.storeIds ?? [];
        if (!storeIds.includes(order.storeId)) return null;
        return target[0] ?? null;
      }
      case ShippingAssigningRuleType.CITY: {
        if (!order.cityId) return null;
        const cityIds = rule.condition?.cityIds ?? [];
        if (!cityIds.includes(order.cityId)) return null;
        return target[0] ?? null;
      }
      default:
        return null;
    }
  }

  private async loadActiveRules(adminId: string) {
    return this.ruleRepo.find({
      where: { adminId, isActive: true },
      relations: { targetCompanies: true },
      order: { priority: "ASC", createdAt: "ASC" },
    });
  }

  async resolve(me: any, dto: ResolveAssigningDto): Promise<ResolveResult> {
    const adminId = this.requireAdminId(me);
    const rules = await this.loadActiveRules(adminId);
    if (!rules.length) {
      return { companyId: null, reason: "no_matching_rule" };
    }
    const { ids: activeCompanyIds, names } = await this.getActiveCompanyIds(me);

    for (const rule of rules) {
      const explicit = (rule.targetCompanies ?? []).map((c) => c.id);
      const target = explicit.length
        ? explicit.filter((id) => activeCompanyIds.includes(id))
        : activeCompanyIds;
      if (!target.length) continue;
      const companyId = this.matchRule(dto, rule, target);
      if (!companyId) continue;
      if (rule.ruleType === ShippingAssigningRuleType.EQUAL_DISTRIBUTION) {
        await this.ruleRepo.update(rule.id, {
          lastAssignedCompanyId: companyId,
        });
      }
      return {
        companyId,
        companyName: names.get(companyId) ?? null,
        ruleId: rule.id,
        ruleName: rule.name,
      };
    }
    return { companyId: null, reason: "no_matching_rule" };
  }

  async preview(
    me: any,
    dto: PreviewAssigningDto,
  ): Promise<{
    results: Array<ResolveResult & { label?: string }>;
    matchedCount: number;
  }> {
    const adminId = this.requireAdminId(me);
    const rules = await this.loadActiveRules(adminId);
    const { ids: activeCompanyIds, names } = await this.getActiveCompanyIds(me);
    // In-memory pointers so preview shows distribution without persisting.
    const pointers = new Map<string, string | null>();
    const results = dto.orders.map((order) => {
      for (const rule of rules) {
        const explicit = (rule.targetCompanies ?? []).map((c) => c.id);
        const target = explicit.length
          ? explicit.filter((id) => activeCompanyIds.includes(id))
          : activeCompanyIds;
        if (!target.length) continue;
        const companyId = this.matchRule(
          order,
          rule,
          target,
          pointers.has(rule.id) ? pointers.get(rule.id) : rule.lastAssignedCompanyId,
        );
        if (!companyId) continue;
        if (rule.ruleType === ShippingAssigningRuleType.EQUAL_DISTRIBUTION) {
          pointers.set(rule.id, companyId);
        }
        return {
          companyId,
          companyName: names.get(companyId) ?? null,
          ruleId: rule.id,
          ruleName: rule.name,
          label: order.label,
        };
      }
      return { companyId: null, reason: "no_matching_rule", label: order.label };
    });
    return {
      results,
      matchedCount: results.filter((r) => !!r.companyId).length,
    };
  }
}
