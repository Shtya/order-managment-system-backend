import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { UnrecoverableError } from "bullmq";
import { randomBytes, randomInt } from "crypto";
import * as ExcelJS from "exceljs";
import {
  buildAudienceFileTemplate,
  deleteLocalUploadsFile,
  duplicateAudienceFile,
} from "./campaign-audience-file.util";
import {
  AudienceSource,
  CampaignAudience,
} from "./audience/campaign-audience.abstract";
import { ManualCampaignAudience } from "./audience/manual-campaign.audience";
import { FileCampaignAudience } from "./audience/file-campaign.audience";
import { FilterCampaignAudience } from "./audience/filter-campaign.audience";
import { SegmentCampaignAudience } from "./audience/segment-campaign.audience";
import {
  CampaignAudienceType,
  CampaignChannel,
  CampaignEntity,
  CampaignExcludedRecipientEntity,
  CampaignExclusionType,
  CampaignProductEntity,
  CampaignRecipientDeliveryStatus,
  CampaignRecipientEntity,
  CampaignScheduleMode,
  CampaignStatus,
} from "entities/campaigns.entity";
import {
  CampaignQueueService,
  type CampaignSendTickResult,
  type CampaignSenderSlot,
} from "src/queue/queues/campaign.queue";

import {
  CampaignChannel as CampaignChannelProvider,
} from "./channels/campaign-channel.abstract";
import { WhatsappCampaignChannel } from "./channels/whatsapp-campaign.channel";
import {
  followupTextHasOrderUrl,
  inspectTemplateOrderLink,
} from "./campaign-order-url";
import {
  CreateCampaignDto,
  UpdateCampaignDto,
} from "dto/campaign.dto";
import {
  RequestTranslationService,
  TranslationService,
} from "common/translation.service";
import { tenantId } from "src/category/category.service";
import { normalizeEgyptianPhoneNumber } from "common/whatsapp";
import { NotificationService } from "src/notifications/notification.service";
import { NotificationType } from "entities/notifications.entity";
import { AppGateway } from "common/app.gateway";
import { OrphanFilesService } from "src/orphan-files/orphan-files.service";

const LIST_PAGE_LIMIT = 20;
const LIST_PAGE_LIMIT_MAX = 100;
const STALE_SENDING_MS = 5 * 60 * 1000;
const GATE_DELAY_CAP_MS = 15 * 60 * 1000;

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    @InjectRepository(CampaignEntity)
    private readonly campaignRepo: Repository<CampaignEntity>,
    @InjectRepository(CampaignProductEntity)
    private readonly productRepo: Repository<CampaignProductEntity>,
    @InjectRepository(CampaignExcludedRecipientEntity)
    private readonly excludedRepo: Repository<CampaignExcludedRecipientEntity>,
    private readonly translations: TranslationService,
    private readonly whatsappChannel: WhatsappCampaignChannel,
    private readonly manualAudience: ManualCampaignAudience,
    private readonly fileAudience: FileCampaignAudience,
    private readonly filterAudience: FilterCampaignAudience,
    private readonly segmentAudience: SegmentCampaignAudience,
    @InjectRepository(CampaignRecipientEntity)
    private readonly recipientRepo: Repository<CampaignRecipientEntity>,
    @Inject(forwardRef(() => CampaignQueueService))
    private readonly campaignQueue: CampaignQueueService,
    private readonly notificationService: NotificationService,
    private readonly requestTranslations: RequestTranslationService,
    private readonly appGateway: AppGateway,
    private readonly orphanFilesService: OrphanFilesService,
  ) {
    this.channels = {
      [CampaignChannel.WHATSAPP]: this.whatsappChannel,
    };
    this.audiences = {
      [CampaignAudienceType.MANUAL]: this.manualAudience,
      [CampaignAudienceType.FILE]: this.fileAudience,
      [CampaignAudienceType.CUSTOMERS]: this.filterAudience,
      [CampaignAudienceType.SEGMENT]: this.segmentAudience,
    };
  }

  private readonly channels: Record<string, CampaignChannelProvider>;
  private readonly audiences: Record<string, CampaignAudience>;

  private getChannel(channel: CampaignChannel): CampaignChannelProvider {
    const provider = this.channels[channel];
    if (!provider) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.channel_not_supported_yet"),
      );
    }
    return provider;
  }

  private getAudience(type: CampaignAudienceType): CampaignAudience {
    const provider = this.audiences[type];
    if (!provider) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.invalid_audience_type"),
      );
    }
    return provider;
  }

  private toAudienceSource(
    audienceType: CampaignAudienceType,
    dto: {
      audienceSegmentId?: string | null;
      audienceFilter?: any;
    },
    manualEntries?: { phoneNumber: string; name?: string | null }[] | null,
    stagedFilePath?: string | null,
    fileUrl?: string | null,
  ): AudienceSource {
    switch (audienceType) {
      case CampaignAudienceType.MANUAL:
        return { kind: "manual", entries: manualEntries ?? [] };
      case CampaignAudienceType.FILE:
        return {
          kind: "file",
          filePath: stagedFilePath ?? undefined,
          fileUrl: fileUrl ?? null,
        };
      case CampaignAudienceType.CUSTOMERS:
        return { kind: "filter", filter: dto.audienceFilter };
      case CampaignAudienceType.SEGMENT:
        return { kind: "segment", segmentId: dto.audienceSegmentId as string };
      default:
        throw new BadRequestException(
          this.translations.t("domains.campaigns.invalid_audience_type"),
        );
    }
  }

  private adminIdOf(me: any): string {
    const id = tenantId(me);
    if (!id)
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    return id;
  }

  private async confirmOrphanFiles(adminId: string, ids?: string[] | null) {
    await this.orphanFilesService.deleteOrphansByIds(
      this.campaignRepo.manager,
      adminId,
      ids ?? [],
    );
  }

  // ──────────────────────────────────────────────────────────────
  // List / Export / Get
  // ──────────────────────────────────────────────────────────────

  async list(me: any, q: any) {
    const adminId = this.adminIdOf(me);
    const qb = this.campaignRepo
      .createQueryBuilder("campaign")
      .leftJoinAndSelect("campaign.products", "products")
      .leftJoinAndSelect("campaign.template", "template")
      .where("campaign.adminId = :adminId", { adminId });

    if (q?.status) qb.andWhere("campaign.status = :status", { status: q.status });
    if (q?.channel) qb.andWhere("campaign.channel = :channel", { channel: q.channel });
    if (q?.category)
      qb.andWhere("campaign.category = :category", { category: q.category });
    if (q?.search) {
      qb.andWhere("campaign.name ILIKE :search", { search: `%${q.search}%` });
    }

    qb.orderBy("campaign.createdAt", "DESC");

    const page = Math.max(1, parseInt(q?.page) || 1);
    const limit = Math.min(
      LIST_PAGE_LIMIT_MAX,
      Math.max(1, parseInt(q?.limit) || LIST_PAGE_LIMIT),
    );
    qb.skip((page - 1) * limit).take(limit);

    const [records, total] = await qb.getManyAndCount();
    return {
      total_records: total,
      current_page: page,
      per_page: limit,
      records,
    };
  }

  async stats(me: any) {
    const adminId = this.adminIdOf(me);

    const result = await this.campaignRepo
      .createQueryBuilder("campaign")
      .select("COUNT(*)", "total")
      .addSelect(
        `SUM(CASE WHEN campaign.status = :draft THEN 1 ELSE 0 END)`,
        "draft",
      )
      .addSelect(
        `SUM(CASE WHEN campaign.status = :scheduled THEN 1 ELSE 0 END)`,
        "scheduled",
      )
      .addSelect(
        `SUM(CASE WHEN campaign.status = :running THEN 1 ELSE 0 END)`,
        "running",
      )
      .addSelect(
        `SUM(CASE WHEN campaign.status = :paused THEN 1 ELSE 0 END)`,
        "paused",
      )
      .addSelect(
        `SUM(CASE WHEN campaign.status = :completed THEN 1 ELSE 0 END)`,
        "completed",
      )
      .addSelect(
        `SUM(CASE WHEN campaign.status = :cancelled THEN 1 ELSE 0 END)`,
        "cancelled",
      )
      .addSelect(
        `SUM(CASE WHEN campaign.status = :failed THEN 1 ELSE 0 END)`,
        "failed",
      )
      .addSelect(`COALESCE(SUM(campaign."sentCount"), 0)`, "sent")
      .addSelect(`COALESCE(SUM(campaign."deliveredCount"), 0)`, "delivered")
      .addSelect(`COALESCE(SUM(campaign."readCount"), 0)`, "read")
      .addSelect(`COALESCE(SUM(campaign."repliedCount"), 0)`, "replied")
      .addSelect(`COALESCE(SUM(campaign."ordersCount"), 0)`, "orders")
      .addSelect(`COALESCE(SUM(campaign."salesAmount"), 0)`, "salesAmount")
      .addSelect(`COALESCE(SUM(campaign."costAmount"), 0)`, "costAmount")
      .where("campaign.adminId = :adminId", { adminId })
      .setParameters({
        draft: CampaignStatus.DRAFT,
        scheduled: CampaignStatus.SCHEDULED,
        running: CampaignStatus.RUNNING,
        paused: CampaignStatus.PAUSED,
        completed: CampaignStatus.COMPLETED,
        cancelled: CampaignStatus.CANCELLED,
        failed: CampaignStatus.FAILED,
      })
      .getRawOne();

    return {
      total: Number(result.total),
      byStatus: {
        draft: Number(result.draft),
        scheduled: Number(result.scheduled),
        running: Number(result.running),
        paused: Number(result.paused),
        completed: Number(result.completed),
        cancelled: Number(result.cancelled),
        failed: Number(result.failed),
      },
      funnel: {
        sent: Number(result.sent),
        delivered: Number(result.delivered),
        read: Number(result.read),
        replied: Number(result.replied),
        orders: Number(result.orders),
        salesAmount: Number(result.salesAmount),
        costAmount: Number(result.costAmount),
      },
    };
  }

  async exportCampaigns(me: any, q?: any) {
    const { records } = await this.list(me, {
      ...q,
      page: 1,
      limit: 10000,
    });
    const na = this.translations.t("common.not_applicable");
    const yes = this.translations.t("common.yes");
    const no = this.translations.t("common.no");
    const t = (key: Parameters<TranslationService["t"]>[0]) =>
      this.translations.t(key);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(
      t("domains.campaigns.export_sheet"),
    );
    sheet.columns = [
      { header: t("common.name"), key: "name", width: 28 },
      {
        header: t("domains.campaigns.export_description"),
        key: "description",
        width: 36,
      },
      {
        header: t("domains.campaigns.export_channel"),
        key: "channel",
        width: 14,
      },
      {
        header: t("domains.campaigns.export_category"),
        key: "category",
        width: 20,
      },
      { header: t("common.status"), key: "status", width: 14 },
      {
        header: t("domains.campaigns.export_audience_type"),
        key: "audienceType",
        width: 16,
      },
      {
        header: t("domains.campaigns.export_schedule_mode"),
        key: "scheduleMode",
        width: 16,
      },
      {
        header: t("domains.campaigns.export_scheduled_at"),
        key: "scheduledAt",
        width: 22,
      },
      {
        header: t("domains.campaigns.export_working_hours"),
        key: "workingHours",
        width: 18,
      },
      {
        header: t("domains.campaigns.export_delay_min"),
        key: "delayMinSeconds",
        width: 14,
      },
      {
        header: t("domains.campaigns.export_delay_max"),
        key: "delayMaxSeconds",
        width: 14,
      },
      {
        header: t("domains.campaigns.export_max_per_hour"),
        key: "maxMessagesPerHour",
        width: 14,
      },
      {
        header: t("domains.campaigns.export_shipping_price"),
        key: "shippingPrice",
        width: 16,
      },
      {
        header: t("domains.campaigns.export_purchase_page"),
        key: "enablePurchasePage",
        width: 14,
      },
      {
        header: t("domains.campaigns.export_template"),
        key: "template",
        width: 24,
      },
      {
        header: t("domains.campaigns.export_products"),
        key: "products",
        width: 36,
      },
      {
        header: t("domains.campaigns.export_estimated"),
        key: "estimatedRecipientsCount",
        width: 14,
      },
      {
        header: t("domains.campaigns.export_recipients"),
        key: "recipientsCount",
        width: 14,
      },
      {
        header: t("domains.campaigns.export_excluded"),
        key: "excludedRecipientsCount",
        width: 14,
      },
      {
        header: t("domains.campaigns.export_sent"),
        key: "sentCount",
        width: 12,
      },
      {
        header: t("domains.campaigns.export_delivered"),
        key: "deliveredCount",
        width: 14,
      },
      {
        header: t("domains.campaigns.export_read"),
        key: "readCount",
        width: 12,
      },
      {
        header: t("domains.campaigns.export_replied"),
        key: "repliedCount",
        width: 12,
      },
      {
        header: t("domains.campaigns.export_orders"),
        key: "ordersCount",
        width: 12,
      },
      {
        header: t("domains.campaigns.export_sales"),
        key: "salesAmount",
        width: 16,
      },
      {
        header: t("domains.campaigns.export_started_at"),
        key: "startedAt",
        width: 22,
      },
      {
        header: t("domains.campaigns.export_completed_at"),
        key: "completedAt",
        width: 22,
      },
      {
        header: t("domains.campaigns.export_cancelled_at"),
        key: "cancelledAt",
        width: 22,
      },
      { header: t("common.created_at"), key: "createdAt", width: 22 },
      {
        header: t("domains.campaigns.export_updated_at"),
        key: "updatedAt",
        width: 22,
      },
    ];

    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFEFEFEF" },
    };

    const formatDate = (value?: Date | null) =>
      value ? new Date(value).toLocaleString() : na;

    records.forEach((campaign) => {
      const products = campaign.products ?? [];
      sheet.addRow({
        name: campaign.name || na,
        description: campaign.description || na,
        channel: campaign.channel || na,
        category: campaign.category || na,
        status: campaign.status || na,
        audienceType: campaign.audienceType || na,
        scheduleMode: campaign.scheduleMode || na,
        scheduledAt: formatDate(campaign.scheduledAt),
        workingHours:
          campaign.workingHoursStart || campaign.workingHoursEnd
            ? `${campaign.workingHoursStart ?? na} - ${campaign.workingHoursEnd ?? na}`
            : na,
        delayMinSeconds: campaign.delayMinSeconds ?? na,
        delayMaxSeconds: campaign.delayMaxSeconds ?? na,
        maxMessagesPerHour: campaign.maxMessagesPerHour ?? na,
        shippingPrice: Number(campaign.shippingPrice ?? 0),
        enablePurchasePage: campaign.enablePurchasePage ? yes : no,
        template:
          (campaign as any).template?.name || campaign.templateId || na,
        products: products.length
          ? `${products.length} | ` +
          products
            .slice(0, 5)
            .map((p) => `${p.name} x${p.quantity}`)
            .join(", ")
          : na,
        estimatedRecipientsCount: Number(campaign.estimatedRecipientsCount || 0),
        recipientsCount: Number(campaign.recipientsCount || 0),
        excludedRecipientsCount: Number(campaign.excludedRecipientsCount || 0),
        sentCount: Number(campaign.sentCount || 0),
        deliveredCount: Number(campaign.deliveredCount || 0),
        readCount: Number(campaign.readCount || 0),
        repliedCount: Number(campaign.repliedCount || 0),
        ordersCount: Number(campaign.ordersCount || 0),
        salesAmount: Number(campaign.salesAmount || 0),
        startedAt: formatDate(campaign.startedAt),
        completedAt: formatDate(campaign.completedAt),
        cancelledAt: formatDate(campaign.cancelledAt),
        createdAt: formatDate(campaign.createdAt),
        updatedAt: formatDate((campaign as any).updatedAt),
      });
    });

    return workbook.xlsx.writeBuffer();
  }

  async get(me: any, id: string) {
    const adminId = this.adminIdOf(me);
    const campaign = await this.campaignRepo.findOne({
      where: { id, adminId },
      relations: {
        products: true,
        audienceSegment: true,
        template: true,
      },
    });
    if (!campaign)
      throw new NotFoundException(
        this.translations.t("domains.campaigns.not_found"),
      );
    return campaign;
  }

  // Processed recipients only: pending/sending rows are still in the
  // pipeline, so they are excluded unless explicitly requested.
  async listRecipients(me: any, id: string, q: any) {
    const adminId = this.adminIdOf(me);
    const campaign = await this.campaignRepo.findOne({
      where: { id, adminId },
      select: { id: true },
    });
    if (!campaign)
      throw new NotFoundException(
        this.translations.t("domains.campaigns.not_found"),
      );

    const qb = this.recipientRepo
      .createQueryBuilder("recipient")
      .leftJoin("recipient.order", "order")
      .addSelect(["order.id", "order.orderNumber"])
      .where("recipient.campaignId = :id", { id })
      .andWhere("recipient.adminId = :adminId", { adminId });

    if (q?.status) {
      qb.andWhere("recipient.deliveryStatus = :status", { status: q.status });
    } else {
      qb.andWhere("recipient.deliveryStatus NOT IN (:...pending)", {
        pending: [
          CampaignRecipientDeliveryStatus.PENDING,
          CampaignRecipientDeliveryStatus.SENDING,
        ],
      });
    }
    if (q?.search) {
      qb.andWhere(
        "(recipient.name ILIKE :search OR recipient.phoneNumber ILIKE :search)",
        { search: `%${q.search}%` },
      );
    }

    qb.orderBy("recipient.createdAt", "DESC");

    const page = Math.max(1, parseInt(q?.page) || 1);
    const limit = Math.min(
      LIST_PAGE_LIMIT_MAX,
      Math.max(1, parseInt(q?.limit) || LIST_PAGE_LIMIT),
    );
    qb.skip((page - 1) * limit).take(limit);

    const [records, total] = await qb.getManyAndCount();

    const summary = await this.recipientRepo
      .createQueryBuilder("recipient")
      .select("recipient.deliveryStatus", "status")
      .addSelect("COUNT(*)", "count")
      .where("recipient.campaignId = :id", { id })
      .andWhere("recipient.adminId = :adminId", { adminId })
      .groupBy("recipient.deliveryStatus")
      .getRawMany();
    const byStatus: Record<string, number> = {};
    for (const row of summary) byStatus[row.status] = Number(row.count);

    return {
      total_records: total,
      current_page: page,
      per_page: limit,
      records,
      summary: { total: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus },
    };
  }

  // ──────────────────────────────────────────────────────────────
  // Create / Update / Delete (draft-only editing)
  // ──────────────────────────────────────────────────────────────

  async create(
    me: any,
    dto: CreateCampaignDto,
    stagedFile?: Express.Multer.File,
  ) {
    const adminId = this.adminIdOf(me);
    await this.ensureUniqueName(adminId, dto.name);

    // Staged uploads live or die with this call: any failure below
    // deletes the staged file so no orphan upload survives a bad create.
    // A duplicated file copy is owned the same way (never the source).
    const stagedUrl = stagedFile
      ? `/uploads/campaign-audiences/${stagedFile.filename}`
      : null;
    let storedFileUrl: string | null = stagedUrl;
    let fileCommitted = false;

    try {
      const channelType = dto.channel ?? CampaignChannel.WHATSAPP;
      const channel = this.getChannel(channelType);

      const audienceType = dto.audienceType;
      const audience = this.getAudience(audienceType);
      const isFileDuplicate =
        audienceType === CampaignAudienceType.FILE &&
        !stagedFile &&
        dto.duplicateAudienceFile === true &&
        typeof dto.audienceFileUrl === "string" &&
        !!dto.audienceFileUrl;
      if (audienceType === CampaignAudienceType.FILE && !stagedFile && !isFileDuplicate) {
        throw new BadRequestException(
          this.translations.t("domains.campaigns.audience_file_url_required"),
        );
      }
      await this.validateAudience(adminId, dto, stagedFile?.path);

      const manualSnapshot =
        audienceType === CampaignAudienceType.MANUAL && dto.manualRecipients
          ? (audience as ManualCampaignAudience).buildSnapshot(
            dto.manualRecipients,
          )
          : null;

      const estimatedRecipientsCount = await audience.count(
        adminId,
        this.toAudienceSource(
          audienceType,
          dto,
          manualSnapshot,
          stagedFile?.path,
          dto.audienceFileUrl ?? null,
        ),
      );
      this.assertAudienceHasRecipients(estimatedRecipientsCount);

      if (isFileDuplicate) {
        const copied = await duplicateAudienceFile(dto.audienceFileUrl);
        if (!copied) {
          throw new BadRequestException(
            this.translations.t("domains.campaigns.audience_file_not_found"),
          );
        }
        storedFileUrl = copied;
      }

      const whatsapp = await channel.validateChannelData(adminId, dto);

      this.validateSchedule(dto.scheduleMode, dto.scheduledAt);
      this.validateDelays(dto.delayMinSeconds, dto.delayMaxSeconds);
      const offer = this.resolveOfferFields(dto, dto.whatsapp);

      const campaign = this.campaignRepo.create({
        adminId,
        name: dto.name,
        category: dto.category as any,
        channel: channelType,
        description: dto.description,
        shippingPrice: dto.shippingPrice ?? 0,
        discount: 0,
        enablePurchasePage: offer.enablePurchasePage,
        orderReplyFollowupEnabled: offer.orderReplyFollowupEnabled,
        orderReplyFollowupText: offer.orderReplyFollowupText,
        orderReplyFollowupButtonIndex: offer.orderReplyFollowupButtonIndex,
        orderReplyFollowupButtonText: offer.orderReplyFollowupButtonText,
        audienceType,
        audienceSegmentId: dto.audienceSegmentId ?? null,
        audienceFileUrl: storedFileUrl,
        audienceFilter: (dto.audienceFilter as any) ?? null,
        audienceManualSnapshot: manualSnapshot,
        estimatedRecipientsCount,
        templateId: whatsapp?.templateId ?? null,
        templateConfigSnapshot: (whatsapp?.snapshot as any) ?? null,
        scheduleMode: dto.scheduleMode ?? CampaignScheduleMode.NOW,
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
        workingHoursStart: dto.workingHoursStart ?? null,
        workingHoursEnd: dto.workingHoursEnd ?? null,
        workingHoursTimezone: dto.workingHoursTimezone ?? null,
        delayMinSeconds: dto.delayMinSeconds ?? 30,
        delayMaxSeconds: dto.delayMaxSeconds ?? 90,
        maxMessagesPerHour: dto.maxMessagesPerHour ?? null,
        status: CampaignStatus.DRAFT,
        products: (dto.products ?? []).map((p, index) =>
          this.productRepo.create({
            productId: p.productId ?? null,
            variantId: p.variantId ?? null,
            name: p.name,
            sku: p.sku ?? null,
            image: p.image ?? null,
            quantity: p.quantity ?? 1,
            price: p.price ?? 0,
            sortOrder: p.sortOrder ?? index,
          }),
        ),
      });

      const saved = await this.campaignRepo.save(campaign);
      fileCommitted = true;
      await this.confirmOrphanFiles(adminId, dto.orphanFileIds);

      if (dto.excludedRecipients?.length) {
        await this.replaceExclusions(
          adminId,
          saved.id,
          dto.excludedRecipients,
        );
      }

      const isFutureSchedule =
        (dto.scheduleMode ?? CampaignScheduleMode.NOW) ===
        CampaignScheduleMode.SCHEDULED &&
        saved.scheduledAt &&
        saved.scheduledAt.getTime() > Date.now();
      if (isFutureSchedule) {
        await this.armScheduledCampaign(adminId, saved.id);
        return this.get(me, saved.id);
      }

      return this.start(me, saved.id);
    } catch (error) {
      if (storedFileUrl && !fileCommitted) {
        await this.deleteAudienceFile(storedFileUrl);
      }
      throw error;
    }
  }

  async update(
    me: any,
    id: string,
    dto: UpdateCampaignDto,
    stagedFile?: Express.Multer.File,
  ) {
    const adminId = this.adminIdOf(me);
    const campaign = await this.campaignRepo.findOne({
      where: { id, adminId },
      relations: { products: true },
    });
    if (!campaign)
      throw new NotFoundException(
        this.translations.t("domains.campaigns.not_found"),
      );

    if (campaign.status !== CampaignStatus.SCHEDULED) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.cannot_edit_active"),
      );
    }

    if (dto.name !== undefined && dto.name !== campaign.name) {
      await this.ensureUniqueName(adminId, dto.name, id);
      campaign.name = dto.name;
    }

    const nextChannelType = dto.channel ?? campaign.channel;
    const channel = this.getChannel(nextChannelType);
    const channelChanged = dto.channel !== undefined && dto.channel !== campaign.channel;
    if (channelChanged) {
      campaign.channel = nextChannelType;
    }

    const nextAudienceType = dto.audienceType ?? campaign.audienceType;
    const audience = this.getAudience(nextAudienceType);
    const stagedUrl = stagedFile
      ? `/uploads/campaign-audiences/${stagedFile.filename}`
      : null;
    let fileCommitted = false;
    const effectiveFileUrl = stagedUrl ?? campaign.audienceFileUrl ?? null;

    try {
      await this.validateAudience(
        adminId,
        {
          audienceType: nextAudienceType,
          audienceSegmentId:
            dto.audienceSegmentId !== undefined
              ? dto.audienceSegmentId
              : campaign.audienceSegmentId,
          audienceFileUrl: effectiveFileUrl,
          audienceFilter:
            dto.audienceFilter !== undefined
              ? dto.audienceFilter
              : (campaign.audienceFilter as any),
          manualRecipients: dto.manualRecipients,
        } as any,
        stagedFile?.path,
      );

      const previousFileUrl = campaign.audienceFileUrl ?? null;

      let manualSnapshot = campaign.audienceManualSnapshot ?? null;
      if (
        nextAudienceType === CampaignAudienceType.MANUAL &&
        dto.manualRecipients !== undefined
      ) {
        manualSnapshot = dto.manualRecipients
          ? (audience as ManualCampaignAudience).buildSnapshot(
            dto.manualRecipients,
          )
          : null;
        campaign.audienceManualSnapshot = manualSnapshot;
      } else if (dto.audienceType !== undefined) {
        manualSnapshot = null;
        campaign.audienceManualSnapshot = null;
      }

      if (stagedUrl) {
        campaign.audienceFileUrl = stagedUrl;
      }

      const effectiveFilter =
        dto.audienceFilter !== undefined
          ? dto.audienceFilter
          : (campaign.audienceFilter as any);
      const effectiveSegmentId =
        dto.audienceSegmentId !== undefined
          ? dto.audienceSegmentId
          : campaign.audienceSegmentId;
      const audienceTouched =
        dto.audienceType !== undefined ||
        dto.audienceSegmentId !== undefined ||
        dto.audienceFilter !== undefined ||
        dto.manualRecipients !== undefined ||
        stagedUrl !== null;
      if (audienceTouched) {
        campaign.estimatedRecipientsCount = await audience.count(
          adminId,
          this.toAudienceSource(
            nextAudienceType,
            {
              audienceSegmentId: effectiveSegmentId,
              audienceFilter: effectiveFilter,
            },
            manualSnapshot,
            stagedFile?.path,
            effectiveFileUrl,
          ),
        );
      }
      this.assertAudienceHasRecipients(campaign.estimatedRecipientsCount);

      // Channel data: full replace when provided, keep existing otherwise.
      // When channel itself changed, new channel data is required.
      if (dto.whatsapp !== undefined || channelChanged) {
        const whatsapp = await channel.validateChannelData(
          adminId,
          { whatsapp: dto.whatsapp } as any,
          { requireData: channelChanged },
        );
        campaign.templateId = whatsapp?.templateId ?? null;
        campaign.templateConfigSnapshot = (whatsapp?.snapshot as any) ?? null;
      }

      if (dto.audienceType !== undefined) campaign.audienceType = dto.audienceType;
      if (dto.audienceType !== undefined && nextAudienceType !== CampaignAudienceType.FILE) {
        campaign.audienceFileUrl = null;
      }
      if (dto.audienceSegmentId !== undefined)
        campaign.audienceSegmentId = dto.audienceSegmentId ?? null;
      if (dto.audienceFilter !== undefined)
        campaign.audienceFilter = (dto.audienceFilter as any) ?? null;

      if (dto.category !== undefined) campaign.category = dto.category as any;
      if (dto.description !== undefined) campaign.description = dto.description;
      if (dto.shippingPrice !== undefined) campaign.shippingPrice = dto.shippingPrice;
      const templateSnapshot =
        dto.whatsapp !== undefined
          ? dto.whatsapp
          : campaign.templateConfigSnapshot;
      const offerTouched =
        dto.enablePurchasePage !== undefined ||
        dto.orderReplyFollowupEnabled !== undefined ||
        dto.orderReplyFollowupText !== undefined ||
        dto.orderReplyFollowupButtonIndex !== undefined ||
        dto.whatsapp !== undefined ||
        dto.products !== undefined;
      if (offerTouched) {
        const offer = this.resolveOfferFields(
          {
            enablePurchasePage:
              dto.enablePurchasePage ?? campaign.enablePurchasePage,
            orderReplyFollowupEnabled:
              dto.orderReplyFollowupEnabled ?? campaign.orderReplyFollowupEnabled,
            orderReplyFollowupText:
              dto.orderReplyFollowupText !== undefined
                ? dto.orderReplyFollowupText
                : campaign.orderReplyFollowupText,
            orderReplyFollowupButtonIndex:
              dto.orderReplyFollowupButtonIndex !== undefined
                ? dto.orderReplyFollowupButtonIndex
                : campaign.orderReplyFollowupButtonIndex,
            products:
              dto.products ??
              campaign.products?.map((p) => ({
                productId: p.productId,
                variantId: p.variantId,
                name: p.name,
                sku: p.sku,
                image: p.image,
                quantity: p.quantity,
                price: Number(p.price),
              })),
          },
          templateSnapshot,
        );
        campaign.enablePurchasePage = offer.enablePurchasePage;
        campaign.discount = 0;
        campaign.orderReplyFollowupEnabled = offer.orderReplyFollowupEnabled;
        campaign.orderReplyFollowupText = offer.orderReplyFollowupText;
        campaign.orderReplyFollowupButtonIndex = offer.orderReplyFollowupButtonIndex;
        campaign.orderReplyFollowupButtonText = offer.orderReplyFollowupButtonText;
      }

      const nextScheduleMode = dto.scheduleMode ?? campaign.scheduleMode;
      const nextScheduledAt =
        dto.scheduledAt !== undefined
          ? dto.scheduledAt
            ? new Date(dto.scheduledAt)
            : null
          : campaign.scheduledAt;
      this.validateSchedule(
        nextScheduleMode,
        nextScheduledAt ? nextScheduledAt.toISOString() : undefined,
      );
      if (dto.scheduleMode !== undefined) campaign.scheduleMode = dto.scheduleMode;
      if (dto.scheduledAt !== undefined)
        campaign.scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;

      if (dto.workingHoursStart !== undefined)
        campaign.workingHoursStart = dto.workingHoursStart ?? null;
      if (dto.workingHoursEnd !== undefined)
        campaign.workingHoursEnd = dto.workingHoursEnd ?? null;
      if (dto.workingHoursTimezone !== undefined)
        campaign.workingHoursTimezone = dto.workingHoursTimezone ?? null;

      const nextDelayMin = dto.delayMinSeconds ?? campaign.delayMinSeconds;
      const nextDelayMax = dto.delayMaxSeconds ?? campaign.delayMaxSeconds;
      this.validateDelays(nextDelayMin, nextDelayMax);
      if (dto.delayMinSeconds !== undefined) campaign.delayMinSeconds = dto.delayMinSeconds;
      if (dto.delayMaxSeconds !== undefined) campaign.delayMaxSeconds = dto.delayMaxSeconds;
      if (dto.maxMessagesPerHour !== undefined)
        campaign.maxMessagesPerHour = dto.maxMessagesPerHour ?? null;

      if (dto.products !== undefined) {
        await this.productRepo.delete({ campaignId: id });
        campaign.products = (dto.products ?? []).map((p, index) =>
          this.productRepo.create({
            campaignId: id,
            productId: p.productId ?? null,
            variantId: p.variantId ?? null,
            name: p.name,
            sku: p.sku ?? null,
            image: p.image ?? null,
            quantity: p.quantity ?? 1,
            price: p.price ?? 0,
            sortOrder: p.sortOrder ?? index,
          }),
        );
      }

      const saved = await this.campaignRepo.save(campaign);
      fileCommitted = true;
      await this.confirmOrphanFiles(adminId, dto.orphanFileIds);

      if (
        previousFileUrl &&
        previousFileUrl !== (saved.audienceFileUrl ?? null)
      ) {
        await this.deleteAudienceFile(previousFileUrl);
      }

      if (dto.excludedRecipients !== undefined) {
        await this.replaceExclusions(
          adminId,
          saved.id,
          dto.excludedRecipients ?? [],
        );
      }

      if (dto.scheduleMode === CampaignScheduleMode.NOW) {
        return this.start(me, id);
      }
      if (dto.scheduleMode === CampaignScheduleMode.SCHEDULED) {
        if (this.isFutureSchedule(saved)) {
          await this.armScheduledCampaign(adminId, id);
          return this.get(me, id);
        }
        return this.start(me, id);
      }

      return this.get(me, saved.id);
    } catch (error) {
      if (stagedUrl && !fileCommitted) {
        await this.deleteAudienceFile(stagedUrl);
      }
      throw error;
    }
  }

  async remove(me: any, id: string) {
    const adminId = this.adminIdOf(me);
    const campaign = await this.campaignRepo.findOne({
      where: { id, adminId },
    });
    if (!campaign)
      throw new NotFoundException(
        this.translations.t("domains.campaigns.not_found"),
      );

    if (
      campaign.status === CampaignStatus.RUNNING ||
      campaign.status === CampaignStatus.PAUSED
    ) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.cannot_delete_active"),
      );
    }

    await this.campaignRepo.delete({ id, adminId });
    await this.deleteAudienceFile(campaign.audienceFileUrl ?? null);
    return {
      message: this.translations.t("domains.campaigns.deleted_successfully"),
    };
  }

  // ──────────────────────────────────────────────────────────────
  // Lifecycle: start / pause / resume / cancel / retry-failed
  // ──────────────────────────────────────────────────────────────

  async start(me: any, id: string, dto?: { startNow?: boolean }) {
    const adminId = this.adminIdOf(me);
    const campaign = await this.campaignRepo.findOne({
      where: { id, adminId },
    });
    if (!campaign) {
      throw new NotFoundException(
        this.translations.t("domains.campaigns.not_found"),
      );
    }
    if (
      campaign.status !== CampaignStatus.DRAFT &&
      campaign.status !== CampaignStatus.SCHEDULED
    ) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.not_startable"),
      );
    }

    await this.getChannel(campaign.channel).assertSendable(adminId, campaign);

    const estimated = await this.getAudience(campaign.audienceType).count(
      adminId,
      this.toAudienceSourceFromCampaign(campaign),
    );
    this.assertAudienceHasRecipients(estimated);

    if (!dto?.startNow && this.isFutureSchedule(campaign)) {
      await this.armScheduledCampaign(adminId, id);
      return this.get(me, id);
    }

    await this.campaignQueue.removeScheduledJob(id);

    const flipped = await this.flipStatus(
      id,
      adminId,
      [CampaignStatus.DRAFT, CampaignStatus.SCHEDULED],
      { status: CampaignStatus.RUNNING, startedAt: new Date(), pausedAt: null },
    );
    if (!flipped) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.not_startable"),
      );
    }
    await this.campaignQueue.enqueueMaterialize(adminId, id);
    return this.get(me, id);
  }

  async pause(me: any, id: string) {
    const adminId = this.adminIdOf(me);
    const flipped = await this.flipStatus(
      id,
      adminId,
      [CampaignStatus.RUNNING],
      { status: CampaignStatus.PAUSED, pausedAt: new Date() },
    );
    if (!flipped) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.not_pausable"),
      );
    }
    return this.get(me, id);
  }

  async resume(me: any, id: string) {
    const adminId = this.adminIdOf(me);
    const flipped = await this.flipStatus(
      id,
      adminId,
      [CampaignStatus.PAUSED],
      { status: CampaignStatus.RUNNING, pausedAt: null },
    );
    if (!flipped) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.not_resumable"),
      );
    }
    await this.campaignQueue.ensureSendLoop(adminId, id);
    return this.get(me, id);
  }

  async cancel(me: any, id: string) {
    const adminId = this.adminIdOf(me);
    const flipped = await this.flipStatus(
      id,
      adminId,
      [
        CampaignStatus.DRAFT,
        CampaignStatus.SCHEDULED,
        CampaignStatus.RUNNING,
        CampaignStatus.PAUSED,
      ],
      { status: CampaignStatus.CANCELLED, cancelledAt: new Date() },
    );
    if (!flipped) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.not_cancellable"),
      );
    }
    await this.campaignQueue.removeCampaignJobs(id);
    return this.get(me, id);
  }

  async retryFailed(me: any, id: string) {
    const adminId = this.adminIdOf(me);
    const campaign = await this.campaignRepo.findOne({
      where: { id, adminId },
    });
    if (!campaign) {
      throw new NotFoundException(
        this.translations.t("domains.campaigns.not_found"),
      );
    }
    if (
      campaign.status !== CampaignStatus.FAILED
    ) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.not_retryable"),
      );
    }
    const result = await this.recipientRepo
      .createQueryBuilder()
      .update(CampaignRecipientEntity)
      .set({
        deliveryStatus: CampaignRecipientDeliveryStatus.PENDING,
        failedAt: null,
        failureReason: null,
      })
      .where("campaignId = :id", { id })
      .andWhere("deliveryStatus = :failed", {
        failed: CampaignRecipientDeliveryStatus.FAILED,
      })
      .execute();
    const retried = result.affected ?? 0;
    if (!retried) return { retried: 0 };

    await this.flipStatus(
      id,
      adminId,
      [CampaignStatus.FAILED],
      {
        status: CampaignStatus.RUNNING,
        failedAt: null,
        failureReason: null,
      },
    );
    await this.campaignQueue.ensureSendLoop(adminId, id);

    await this.emitCampaignLive(adminId, id, "recipient");
    return { retried };
  }

  private isFutureSchedule(campaign: CampaignEntity): boolean {
    return (
      campaign.scheduleMode === CampaignScheduleMode.SCHEDULED &&
      !!campaign.scheduledAt &&
      campaign.scheduledAt.getTime() > Date.now()
    );
  }

  private async armScheduledCampaign(adminId: string, campaignId: string) {
    await this.campaignQueue.removeScheduledJob(campaignId);
    await this.campaignRepo.update(campaignId, {
      status: CampaignStatus.SCHEDULED,
    });
    await this.campaignQueue.enqueueMaterialize(adminId, campaignId);
    await this.emitCampaignLive(adminId, campaignId, "status");
  }

  private async emitCampaignLive(
    adminId: string,
    campaignId: string,
    reason = "updated",
    recipient?: Record<string, unknown> | null,
  ) {
    try {
      const campaign = await this.campaignRepo.findOne({
        where: { id: campaignId, adminId },
      });
      if (!campaign) return;
      this.appGateway.emitCampaignUpdated(adminId, {
        campaign: campaign as unknown as Record<string, unknown>,
        reason,
        recipient: recipient ?? null,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to emit campaign live update ${campaignId}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private async flipStatus(
    id: string,
    adminId: string,
    from: CampaignStatus[],
    set: Record<string, any>,
  ): Promise<boolean> {
    const result = await this.campaignRepo
      .createQueryBuilder()
      .update(CampaignEntity)
      .set(set)
      .where("id = :id", { id })
      .andWhere("adminId = :adminId", { adminId })
      .andWhere("status IN (:...from)", { from })
      .execute();
    const changed = (result.affected ?? 0) > 0;
    if (changed) {
      await this.emitCampaignLive(adminId, id, "status");
    }
    return changed;
  }

  private toAudienceSourceFromCampaign(campaign: CampaignEntity): AudienceSource {
    return this.toAudienceSource(
      campaign.audienceType,
      {
        audienceSegmentId: campaign.audienceSegmentId,
        audienceFilter: campaign.audienceFilter,
      },
      campaign.audienceManualSnapshot ?? [],
      undefined,
      campaign.audienceFileUrl,
    );
  }

  // ──────────────────────────────────────────────────────────────
  // Worker entry points (called by CampaignWorkerService)
  // ──────────────────────────────────────────────────────────────

  async materializeCampaign(adminId: string, campaignId: string) {
    const campaign = await this.campaignRepo.findOne({
      where: { id: campaignId, adminId },
    });
    if (!campaign) return { skipped: true };
    if (
      campaign.status !== CampaignStatus.RUNNING &&
      campaign.status !== CampaignStatus.SCHEDULED
    ) {
      return { skipped: true };
    }
    const audience = this.getAudience(campaign.audienceType);

    // Re-start rewrites unsent rows only; sent rows are never touched.
    await this.recipientRepo.delete({
      campaignId,
      deliveryStatus: CampaignRecipientDeliveryStatus.PENDING,
    });

    const exclusions = await this.excludedRepo.find({
      where: { campaignId },
    });
    const excludedClientIds = new Set(
      exclusions.map((item) => item.clientId).filter(Boolean) as string[],
    );
    const excludedPhones = new Set(
      exclusions
        .map((item) =>
          item.phoneNumber
            ? normalizeEgyptianPhoneNumber(String(item.phoneNumber))
            : null,
        )
        .filter(Boolean) as string[],
    );

    const source = this.toAudienceSourceFromCampaign(campaign);
    const seen = new Set<string>();
    let cursor: any;
    let excluded = 0;
    while (true) {
      const live = await this.campaignRepo.findOne({
        where: { id: campaignId },
      });
      if (
        !live ||
        (live.status !== CampaignStatus.RUNNING &&
          live.status !== CampaignStatus.SCHEDULED)
      ) {
        break;
      }
      const page = await audience.listPage(adminId, source, cursor, 1000);
      const rows: CampaignRecipientEntity[] = [];
      for (const record of page.records) {
        const phoneNumber = normalizeEgyptianPhoneNumber(
          String(record.phoneNumber ?? ""),
        );
        if (!phoneNumber || seen.has(phoneNumber)) continue;
        if (
          (record.clientId && excludedClientIds.has(record.clientId)) ||
          excludedPhones.has(phoneNumber)
        ) {
          excluded += 1;
          continue;
        }
        seen.add(phoneNumber);
        rows.push(
          this.recipientRepo.create({
            adminId,
            campaignId,
            source: campaign.audienceType,
            customerId: record.customerId ?? null,
            clientId: record.clientId ?? null,
            phoneNumber,
            name: record.name ?? null,
            accessToken: randomBytes(24).toString("base64url"),
            deliveryStatus: CampaignRecipientDeliveryStatus.PENDING,
          }),
        );
      }
      if (rows.length) {
        await this.recipientRepo
          .createQueryBuilder()
          .insert()
          .values(rows)
          .orIgnore()
          .execute();
      }
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }

    const recipientsCount = await this.recipientRepo.count({
      where: { campaignId },
    });
    await this.campaignRepo.update(campaignId, {
      recipientsCount,
      excludedRecipientsCount: excluded,
    });
    if (!recipientsCount) {
      await this.campaignRepo.update(campaignId, {
        status: CampaignStatus.FAILED,
        failedAt: new Date(),
        failureReason: "audience_empty",
      });
      await this.notifyCampaignEnded(adminId, campaignId, "failed");
      await this.emitCampaignLive(adminId, campaignId, "status");
      return { inserted: 0 };
    }
    await this.emitCampaignLive(adminId, campaignId, "stats");

    const fresh = await this.campaignRepo.findOne({
      where: { id: campaignId },
    });
    if (
      fresh?.scheduleMode === CampaignScheduleMode.SCHEDULED &&
      fresh.scheduledAt &&
      fresh.scheduledAt.getTime() > Date.now() &&
      fresh.status === CampaignStatus.SCHEDULED
    ) {
      await this.campaignQueue.enqueueScheduleCheck(
        adminId,
        campaignId,
        fresh.scheduledAt.getTime() - Date.now(),
      );
      return { inserted: recipientsCount, deferred: true };
    }
    await this.campaignQueue.ensureSendLoop(adminId, campaignId);
    return { inserted: recipientsCount };
  }

  async runScheduledCampaign(adminId: string, campaignId: string) {
    const campaign = await this.campaignRepo.findOne({
      where: { id: campaignId, adminId },
    });
    if (!campaign || campaign.status !== CampaignStatus.SCHEDULED) return;
    if (
      campaign.scheduledAt &&
      campaign.scheduledAt.getTime() > Date.now()
    ) {
      await this.campaignQueue.enqueueScheduleCheck(
        adminId,
        campaignId,
        campaign.scheduledAt.getTime() - Date.now(),
      );
      return;
    }
    const flipped = await this.flipStatus(
      campaignId,
      adminId,
      [CampaignStatus.SCHEDULED],
      { status: CampaignStatus.RUNNING, startedAt: new Date() },
    );
    if (!flipped) return;
    await this.campaignQueue.ensureSendLoop(adminId, campaignId);
  }

  async advanceCampaignSend(
    adminId: string,
    campaignId: string,
    sendWithSenderSlot: CampaignSenderSlot,
  ): Promise<CampaignSendTickResult> {
    const started = Date.now();
    const campaign = await this.campaignRepo.findOne({
      where: { id: campaignId, adminId },
    });
    if (!campaign || campaign.status !== CampaignStatus.RUNNING) {
      this.logger.log(
        JSON.stringify({
          adminId,
          campaignId,
          action: "idle",
          durationMs: Date.now() - started,
        }),
      );
      return {
        action: "idle",
        campaignId,
        durationMs: Date.now() - started,
      };
    }

    await this.releaseStaleSending(campaignId);

    const live = await this.campaignRepo.findOne({
      where: { id: campaignId, adminId },
    });
    if (!live || live.status !== CampaignStatus.RUNNING) {
      const stuck = await this.recipientRepo.findOne({
        where: {
          campaignId,
          deliveryStatus: CampaignRecipientDeliveryStatus.SENDING,
        },
      });
      if (stuck) await this.revertSending(stuck.id);
      return {
        action: "idle",
        campaignId,
        durationMs: Date.now() - started,
      };
    }

    const deferral = await this.getSendDeferral(live);
    if (deferral) {
      this.logger.log(
        JSON.stringify({
          adminId,
          campaignId,
          action: "deferral",
          delayMs: deferral.delayMs,
          durationMs: Date.now() - started,
        }),
      );
      return {
        action: "deferral",
        delayMs: deferral.delayMs,
        campaignId,
        durationMs: Date.now() - started,
      };
    }

    let recipient = await this.recipientRepo.findOne({
      where: {
        campaignId,
        deliveryStatus: CampaignRecipientDeliveryStatus.SENDING,
      },
      order: { updatedAt: "DESC" },
    });
    if (!recipient) {
      recipient = await this.claimNextPending(campaignId);
    }
    if (!recipient) {
      await this.maybeCompleteCampaign(adminId, campaignId);
      return {
        action: "idle",
        campaignId,
        durationMs: Date.now() - started,
      };
    }

    return this.finishSendTick(
      adminId,
      live,
      recipient,
      started,
      sendWithSenderSlot,
    );
  }

  async failInFlightSending(
    adminId: string,
    campaignId: string,
  ): Promise<void> {
    await this.recipientRepo
      .createQueryBuilder()
      .update(CampaignRecipientEntity)
      .set({
        deliveryStatus: CampaignRecipientDeliveryStatus.FAILED,
        failedAt: new Date(),
        failureReason: "send_attempts_exhausted",
      })
      .where("adminId = :adminId", { adminId })
      .andWhere("campaignId = :campaignId", { campaignId })
      .andWhere("deliveryStatus = :sending", {
        sending: CampaignRecipientDeliveryStatus.SENDING,
      })
      .execute();
    await this.emitCampaignLive(adminId, campaignId, "recipient");
  }

  private async finishSendTick(
    adminId: string,
    campaign: CampaignEntity,
    recipient: CampaignRecipientEntity,
    started: number,
    sendWithSenderSlot: CampaignSenderSlot,
  ): Promise<CampaignSendTickResult> {
    const delayMs = this.nextSendDelayMs(campaign);
    try {
      const outcome = await this.sendClaimedRecipient(
        adminId,
        campaign,
        recipient,
        sendWithSenderSlot,
      );
      if (outcome.action !== "sent") {
        if (outcome.action === "dropped") {
          await this.revertSending(recipient.id);
        }
        const parkDelay = Math.min(
          outcome.delayMs ?? 0,
          GATE_DELAY_CAP_MS,
        );
        this.logger.log(
          JSON.stringify({
            adminId,
            campaignId: campaign.id,
            recipientId: recipient.id,
            action: "deferral",
            delayMs: parkDelay,
            durationMs: Date.now() - started,
          }),
        );
        return {
          action: "deferral",
          delayMs: parkDelay,
          campaignId: campaign.id,
          recipientId: recipient.id,
          durationMs: Date.now() - started,
        };
      }
      await this.maybeCompleteCampaign(adminId, campaign.id);
      this.logger.log(
        JSON.stringify({
          adminId,
          campaignId: campaign.id,
          recipientId: recipient.id,
          action: "sent",
          delayMs,
          durationMs: Date.now() - started,
        }),
      );
      return {
        action: "sent",
        delayMs,
        campaignId: campaign.id,
        recipientId: recipient.id,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof UnrecoverableError) {
        await this.maybeCompleteCampaign(adminId, campaign.id);
        this.logger.log(
          JSON.stringify({
            adminId,
            campaignId: campaign.id,
            recipientId: recipient.id,
            action: "failed",
            delayMs,
            durationMs: Date.now() - started,
          }),
        );
        return {
          action: "failed",
          delayMs,
          campaignId: campaign.id,
          recipientId: recipient.id,
          durationMs: Date.now() - started,
        };
      }
      throw error;
    }
  }

  private async sendClaimedRecipient(
    adminId: string,
    campaign: CampaignEntity,
    recipient: CampaignRecipientEntity,
    sendWithSenderSlot: CampaignSenderSlot,
  ): Promise<{ action: "sent" | "dropped" | "park"; delayMs?: number }> {
    if (
      recipient.deliveryStatus !== CampaignRecipientDeliveryStatus.SENDING
    ) {
      return { action: "dropped" };
    }
    if (
      campaign.status === CampaignStatus.CANCELLED ||
      campaign.status === CampaignStatus.FAILED ||
      campaign.status === CampaignStatus.COMPLETED
    ) {
      return { action: "dropped" };
    }
    if (campaign.status !== CampaignStatus.RUNNING) {
      return { action: "park", delayMs: 0 };
    }

    const channel = this.getChannel(campaign.channel);
    try {
      const result = await sendWithSenderSlot(() =>
        channel.sendRecipient(adminId, campaign, recipient),
      );
      recipient.deliveryStatus = CampaignRecipientDeliveryStatus.ACCEPTED;
      recipient.messageId = result.providerMessageId;
      recipient.sentAt = new Date();
      await this.recipientRepo.save(recipient);
      await this.campaignRepo.increment({ id: campaign.id }, "sentCount", 1);
      await this.emitCampaignLive(adminId, campaign.id, "recipient", {
        id: recipient.id,
        deliveryStatus: recipient.deliveryStatus,
        sentAt: recipient.sentAt,
      });
      return { action: "sent" };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        recipient.deliveryStatus = CampaignRecipientDeliveryStatus.FAILED;
        recipient.failedAt = new Date();
        recipient.failureReason = String(error.message ?? error).slice(0, 500);
        await this.recipientRepo.save(recipient);
        await this.emitCampaignLive(adminId, campaign.id, "recipient", {
          id: recipient.id,
          deliveryStatus: recipient.deliveryStatus,
          failedAt: recipient.failedAt,
          failureReason: recipient.failureReason,
        });
        throw new UnrecoverableError(
          `campaign recipient failed: ${recipient.failureReason}`,
        );
      }
      throw error;
    }
  }

  private async getSendDeferral(
    campaign: CampaignEntity,
  ): Promise<{ delayMs: number } | null> {
    const hours = this.workingHoursGate(campaign);
    if (!hours.open) {
      //GATE_DELAY_CAP_MS is 15 minutes. So the job does not sleep until 9am. It sleeps at most 15 minutes, then runs the tick again: still closed? wait another 15 minutes. Open? send.
      //That is intentional:

      // Pause / cancel / edit hours — an 11-hour delayed job would ignore those until morning. Waking every 15 minutes re-reads the campaign.
      return { delayMs: Math.min(hours.delayMs, GATE_DELAY_CAP_MS) };
    }
    if (
      campaign.maxMessagesPerHour &&
      (await this.sentLastHour(campaign.id)) >= campaign.maxMessagesPerHour
    ) {
      return { delayMs: Math.min(5 * 60_000, GATE_DELAY_CAP_MS) };
    }
    return null;
  }

  private async claimNextPending(
    campaignId: string,
  ): Promise<CampaignRecipientEntity | null> {
    const result = await this.recipientRepo.query(
      `
      UPDATE campaign_recipients SET "deliveryStatus" = $2, "updatedAt" = NOW()
      WHERE id = (
        SELECT id FROM campaign_recipients
        WHERE "campaignId" = $1 AND "deliveryStatus" = $3
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
      `,
      [
        campaignId,
        CampaignRecipientDeliveryStatus.SENDING,
        CampaignRecipientDeliveryStatus.PENDING,
      ],
    );
    const rows = Array.isArray(result?.[0]) ? result[0] : result;
    const id = rows?.[0]?.id;
    if (!id) return null;
    return this.recipientRepo.findOne({ where: { id, campaignId } });
  }

  private async releaseStaleSending(campaignId: string): Promise<void> {
    const result = await this.recipientRepo
      .createQueryBuilder()
      .update(CampaignRecipientEntity)
      .set({ deliveryStatus: CampaignRecipientDeliveryStatus.PENDING })
      .where("campaignId = :campaignId", { campaignId })
      .andWhere("deliveryStatus = :sending", {
        sending: CampaignRecipientDeliveryStatus.SENDING,
      })
      .andWhere("updatedAt < :staleBefore", {
        staleBefore: new Date(Date.now() - STALE_SENDING_MS),
      })
      .execute();
    if ((result.affected ?? 0) > 0) {
      this.logger.warn(
        `Reverted ${result.affected} stale sending recipient(s) for campaign ${campaignId}`,
      );
    }
  }

  private async revertSending(recipientId: string): Promise<void> {
    await this.recipientRepo.update(
      {
        id: recipientId,
        deliveryStatus: CampaignRecipientDeliveryStatus.SENDING,
      },
      { deliveryStatus: CampaignRecipientDeliveryStatus.PENDING },
    );
  }

  private async maybeCompleteCampaign(
    adminId: string,
    campaignId: string,
  ): Promise<void> {
    const leftover = await this.recipientRepo
      .createQueryBuilder("recipient")
      .where("recipient.campaignId = :campaignId", { campaignId })
      .andWhere("recipient.deliveryStatus IN (:...statuses)", {
        statuses: [
          CampaignRecipientDeliveryStatus.PENDING,
          CampaignRecipientDeliveryStatus.SENDING,
        ],
      })
      .getCount();
    if (leftover > 0) return;
    const completed = await this.flipStatus(
      campaignId,
      adminId,
      [CampaignStatus.RUNNING],
      { status: CampaignStatus.COMPLETED, completedAt: new Date() },
    );
    if (completed) {
      const failedCount = await this.recipientRepo.count({
        where: {
          campaignId,
          deliveryStatus: CampaignRecipientDeliveryStatus.FAILED,
        },
      });
      const total = await this.recipientRepo.count({ where: { campaignId } });
      await this.notifyCampaignEnded(
        adminId,
        campaignId,
        !total || failedCount === total ? "failed" : "completed",
      );
    }
  }

  private async notifyCampaignEnded(
    adminId: string,
    campaignId: string,
    outcome: "completed" | "failed",
  ): Promise<void> {
    try {
      const campaign = await this.campaignRepo.findOne({
        where: { id: campaignId, adminId },
        select: { id: true, name: true },
      });
      if (!campaign) return;
      const isFailed = outcome === "failed";
      await this.notificationService.create({
        userId: adminId,
        type: isFailed
          ? NotificationType.CAMPAIGN_FAILED
          : NotificationType.CAMPAIGN_COMPLETED,
        title: await this.requestTranslations.tAsync(
          isFailed
            ? "domains.campaigns.failed_title"
            : "domains.campaigns.completed_title",
          adminId,
        ),
        message: await this.requestTranslations.tAsync(
          isFailed
            ? "domains.campaigns.failed_message"
            : "domains.campaigns.completed_message",
          adminId,
          { args: { name: campaign.name } },
        ),
        relatedEntityType: "campaign",
        relatedEntityId: String(campaign.id),
      });
    } catch (error) {
      this.logger.error(
        `Failed to send campaign ${outcome} notification: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private nextSendDelayMs(campaign: CampaignEntity): number {
    const min = Math.max(1, Math.floor(campaign.delayMinSeconds ?? 4));
    const max = Math.max(min, Math.floor(campaign.delayMaxSeconds ?? min));
    return randomInt(min, max + 1) * 1000;
  }

  private async sentLastHour(campaignId: string): Promise<number> {
    return this.recipientRepo
      .createQueryBuilder("recipient")
      .where("recipient.campaignId = :campaignId", { campaignId })
      .andWhere("recipient.sentAt > :since", {
        since: new Date(Date.now() - 3600_000),
      })
      .getCount();
  }

  private workingHoursGate(campaign: CampaignEntity): {
    open: boolean;
    delayMs: number;
  } {
    const { workingHoursStart, workingHoursEnd } = campaign;
    if (!workingHoursStart || !workingHoursEnd) {
      return { open: true, delayMs: 0 };
    }
    const timeZone = campaign.workingHoursTimezone || "Africa/Cairo";
    const toMinutes = (value: string) => {
      const [hours, minutes] = value.split(":").map(Number);
      return hours * 60 + minutes;
    };
    let now: Date;
    try {
      now = new Date(new Date().toLocaleString("en-US", { timeZone }));
    } catch {
      now = new Date(new Date().toLocaleString("en-US", { timeZone: "Africa/Cairo" }));
    }
    const current = now.getHours() * 60 + now.getMinutes();
    const start = toMinutes(workingHoursStart);
    const end = toMinutes(workingHoursEnd);
    const inside =
      start <= end
        ? current >= start && current < end
        : current >= start || current < end;
    if (inside) return { open: true, delayMs: 0 };
    const minutesUntil = (start - current + 24 * 60) % (24 * 60) || 24 * 60;
    return {
      open: false,
      delayMs: Math.min(minutesUntil * 60_000 + 5_000, 24 * 3600_000),
    };
  }

  // ──────────────────────────────────────────────────────────────
  // Audience file: upload / template / validation / cleanup
  // ──────────────────────────────────────────────────────────────

  async audienceFileTemplate() {
    const workbook = buildAudienceFileTemplate();
    return workbook.xlsx.writeBuffer();
  }

  private async deleteAudienceFile(url?: string | null): Promise<void> {
    try {
      await deleteLocalUploadsFile(url);
    } catch (error) {
      this.logger.warn(
        `Failed to delete campaign audience file ${url}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Validation helpers (channel-aware, core stays agnostic)
  // ──────────────────────────────────────────────────────────────

  private async ensureUniqueName(
    adminId: string,
    name: string,
    excludeId?: string,
  ) {
    const qb = this.campaignRepo
      .createQueryBuilder("campaign")
      .where("campaign.adminId = :adminId", { adminId })
      .andWhere("campaign.name = :name", { name });
    if (excludeId) qb.andWhere("campaign.id != :excludeId", { excludeId });
    const exists = await qb.getOne();
    if (exists) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.name_exists"),
      );
    }
  }

  private async validateAudience(
    adminId: string,
    dto: any,
    stagedFilePath?: string,
  ) {
    const type = dto.audienceType as CampaignAudienceType;
    await this.getAudience(type).validate(adminId, {
      audienceSegmentId: dto.audienceSegmentId ?? null,
      audienceFilter: dto.audienceFilter ?? null,
      manualRecipients: dto.manualRecipients ?? null,
      stagedFilePath: stagedFilePath ?? null,
      fileUrl: dto.audienceFileUrl ?? null,
    });

    const manual = dto.manualRecipients ?? null;
    if (
      manual !== undefined &&
      manual !== null &&
      type !== CampaignAudienceType.MANUAL
    ) {
      throw new BadRequestException(
        this.translations.t(
          "domains.campaigns.manual_recipients_only_for_manual",
        ),
      );
    }
    if (stagedFilePath && type !== CampaignAudienceType.FILE) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.audience_file_only_for_file"),
      );
    }
  }

  private assertAudienceHasRecipients(count: number) {
    if (!count) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.audience_empty"),
      );
    }
  }

  private validateSchedule(mode?: CampaignScheduleMode, scheduledAt?: string) {
    if (mode === CampaignScheduleMode.SCHEDULED) {
      if (!scheduledAt)
        throw new BadRequestException(
          this.translations.t(
            "domains.campaigns.scheduled_at_required",
          ),
        );
      if (new Date(scheduledAt).getTime() <= Date.now())
        throw new BadRequestException(
          this.translations.t(
            "domains.campaigns.scheduled_at_must_be_future",
          ),
        );
    }
  }

  private validateDelays(min?: number, max?: number) {
    if (min !== undefined && min < 4)
      throw new BadRequestException(
        this.translations.t(
          "domains.campaigns.delay_min_seconds_invalid",
        ),
      );
    if (
      min !== undefined &&
      max !== undefined &&
      max < min
    )
      throw new BadRequestException(
        this.translations.t(
          "domains.campaigns.delay_max_seconds_invalid",
        ),
      );
  }

  private resolveOfferFields(dto: any, whatsapp: any) {
    const inspect = inspectTemplateOrderLink(whatsapp);
    let enablePurchasePage = !!dto.enablePurchasePage;
    if (enablePurchasePage && !inspect.orderLinkAvailable) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.purchase_page_not_available"),
      );
    }
    if (!enablePurchasePage) {
      return {
        enablePurchasePage: false,
        orderReplyFollowupEnabled: false,
        orderReplyFollowupText: null,
        orderReplyFollowupButtonIndex: null,
        orderReplyFollowupButtonText: null,
      };
    }

    const products = Array.isArray(dto.products) ? dto.products : [];
    if (!products.length) {
      throw new BadRequestException(
        this.translations.t(
          "domains.campaigns.products_required_for_purchase_page",
        ),
      );
    }
    if (products.some((p) => !p.variantId)) {
      throw new BadRequestException(
        this.translations.t(
          "domains.campaigns.product_variant_required_for_purchase_page",
        ),
      );
    }

    const qrOnly = inspect.qrOnly;
    let followupEnabled = !!dto.orderReplyFollowupEnabled;
    if (qrOnly) followupEnabled = true;
    if (!inspect.hasQuickReply) followupEnabled = false;

    let buttonIndex =
      dto.orderReplyFollowupButtonIndex === undefined ||
      dto.orderReplyFollowupButtonIndex === null
        ? null
        : Number(dto.orderReplyFollowupButtonIndex);
    let buttonText: string | null = null;
    let followupText = dto.orderReplyFollowupText
      ? String(dto.orderReplyFollowupText)
      : null;

    if (followupEnabled) {
      if (!inspect.hasQuickReply) {
        throw new BadRequestException(
          this.translations.t("domains.campaigns.followup_requires_quick_reply"),
        );
      }
      const chosen = inspect.quickReplies.find((btn) => btn.index === buttonIndex);
      if (!chosen) {
        throw new BadRequestException(
          this.translations.t("domains.campaigns.followup_button_required"),
        );
      }
      buttonText = chosen.text;
      if (!followupTextHasOrderUrl(followupText)) {
        throw new BadRequestException(
          this.translations.t("domains.campaigns.followup_text_requires_order_url"),
        );
      }
    } else {
      buttonIndex = null;
      followupText = null;
    }

    return {
      enablePurchasePage: true,
      orderReplyFollowupEnabled: followupEnabled,
      orderReplyFollowupText: followupText,
      orderReplyFollowupButtonIndex: buttonIndex,
      orderReplyFollowupButtonText: buttonText,
    };
  }

  private async replaceExclusions(
    adminId: string,
    campaignId: string,
    items: any[],
  ) {
    await this.excludedRepo.delete({ campaignId });
    if (!items.length) return;
    const rows = items.map((item) => {
      if (
        item.type === CampaignExclusionType.CLIENT &&
        !item.clientId
      )
        throw new BadRequestException(
          this.translations.t(
            "domains.campaigns.exclusion_client_id_required",
          ),
        );
      if (
        item.type === CampaignExclusionType.PHONE_NUMBER &&
        !item.phoneNumber
      )
        throw new BadRequestException(
          this.translations.t(
            "domains.campaigns.exclusion_phone_number_required",
          ),
        );
      return this.excludedRepo.create({
        adminId,
        campaignId,
        type: item.type,
        clientId: item.clientId ?? null,
        phoneNumber: item.phoneNumber
          ? normalizeEgyptianPhoneNumber(String(item.phoneNumber))
          : null,
        reason: item.reason ?? null,
      });
    });
    await this.excludedRepo.save(rows);
  }
}
