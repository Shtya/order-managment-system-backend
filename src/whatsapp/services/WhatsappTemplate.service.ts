import { Injectable, BadRequestException, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Brackets } from 'typeorm';
import * as ExcelJS from 'exceljs';
import {
    WhatsappTemplateEntity,
    TemplateStatus,
    TemplateConfig,
    WhatsappAccountEntity,
    TemplateQuality,
    MetaTemplateLibraryQueryDto,
    MetaTemplateLibraryItemDto,
    MetaTemplateLibraryButtonDto,
    TemplateSubCategory,
    WhatsappMessageEntity,
    MessageStatus,
    WhatsappMessageType
} from 'entities/whatsapp.entity';

import { tenantId } from 'src/category/category.service';
import { BodyComponentDto, ButtonsComponentDto, WhatsappTemplateRemoteDto, FooterComponentDto, HeaderLocationComponentDto, HeaderMediaComponentDto, HeaderTextComponentDto, WhatsappApiService, WhatsappTemplateComponentDto } from './WhatsappApi.service';
import { CreateWhatsappTemplateDto, UpdateWhatsappTemplateDto } from 'dto/whatsapp.dto';
import { NotificationService } from 'src/notifications/notification.service';
import { NotificationType } from 'entities/notifications.entity';
import { normalizePhone } from 'common/whatsapp.helper';
import {
    defaultOtpCopyButtonText,
    isCallPermissionDbSubcategory,
    messageSendTtlSecondsFromConfig,
    metaSubCategoryForPayload,
} from '../utils/whatsapp-template-meta.util';
import { OrdersService } from 'src/orders/services/orders.service';
import { SystemRole, User } from 'entities/user.entity';
import { WhatsappService } from '../whatsapp.service';
import { RequestTranslationService, TranslationService } from 'common/translation.service';

@Injectable()
export class WhatsappTemplateService {
    constructor(
        @InjectRepository(WhatsappAccountEntity)
        private readonly accountRepo: Repository<WhatsappAccountEntity>,

        @InjectRepository(WhatsappTemplateEntity)
        private readonly templateRepo: Repository<WhatsappTemplateEntity>,

        @InjectRepository(WhatsappMessageEntity)
        private readonly messageRepo: Repository<WhatsappMessageEntity>,

        private readonly whatsappApi: WhatsappApiService,
        private readonly notificationService: NotificationService,

        @Inject(forwardRef(() => OrdersService))
        private readonly orderService: OrdersService,
        @Inject(forwardRef(() => WhatsappService))
        private readonly whatsappService: WhatsappService,
        private readonly translations: TranslationService,
        private requestTranslations: RequestTranslationService,
    ) { }


    private isSuperAdmin(me: User) {
        return me.role?.name === SystemRole.SUPER_ADMIN;
    }

    async getStats(me: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

        const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

        const [templateStatsRaw, messageStatsRaw] = await Promise.all([
            // 1. Template Status and Quality Counts
            this.templateRepo
                .createQueryBuilder('t')
                .select('t.status', 'status')
                .addSelect('t.quality', 'quality')
                .addSelect('COUNT(*)', 'count')
                .where('t.adminId = :adminId', { adminId })
                .groupBy('t.status')
                .addGroupBy('t.quality')
                .getRawMany(),

            // 2. Message Stats for TEMPLATE type in last 48h
            this.messageRepo
                .createQueryBuilder('m')
                .select('m.status', 'status')
                .addSelect('COUNT(*)', 'count')
                .where('m.adminId = :adminId', { adminId })
                .andWhere('m.messageType = :type', { type: WhatsappMessageType.TEMPLATE })
                .andWhere('m.createdAt >= :fortyEightHoursAgo', { fortyEightHoursAgo })
                .groupBy('m.status')
                .getRawMany(),
        ]);

        const stats = {
            total: 0,
            approved: 0,
            rejected: 0,
            lowQuality: 0,
            usedLast48h: 0,
            failedLast48h: 0,
        };

        // Process Template Stats
        templateStatsRaw.forEach(s => {
            const count = parseInt(s.count, 10);
            stats.total += count;
            if (s.status === TemplateStatus.APPROVED) stats.approved += count;
            if (s.status === TemplateStatus.REJECTED) stats.rejected += count;
            if (s.quality === TemplateQuality.LOW) stats.lowQuality += count;
        });

        // Process Message Stats
        messageStatsRaw.forEach(s => {
            const count = parseInt(s.count, 10);
            if (s.status === MessageStatus.SENT || s.status === MessageStatus.DELIVERED || s.status === MessageStatus.READ) {
                stats.usedLast48h += count;
            } else if (s.status === MessageStatus.FAILED) {
                stats.failedLast48h += count;
            }
        });

        return stats;
    }

    async list(me: any, q?: any, superAdmin?: boolean) {
        const adminId = tenantId(me);
        const isSuperAdmin = this.isSuperAdmin(me);

        if (!isSuperAdmin && !adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

        const page = Number(q?.page ?? 1);
        const limit = Number(q?.limit ?? 10);
        const search = String(q?.search ?? "").trim();
        const accountId = q?.accountId;
        const category = q?.category;
        const subCategory = q?.subCategory;
        const status = q?.status;
        const quality = q?.quality;

        const language = q?.language;
        const qb = this.templateRepo
            .createQueryBuilder("tpl")
            .leftJoinAndSelect("tpl.account", "account");

        if (isSuperAdmin || superAdmin) {
            qb.where("tpl.adminId IS NULL");
        } else {
            qb.where("tpl.adminId = :adminId", { adminId });
        }

        if (category && category !== 'all') {
            qb.andWhere("tpl.category = :category", { category });
        }

        if (subCategory && subCategory !== 'all') {
            qb.andWhere("tpl.subCategory = :subCategory", { subCategory });
        }

        if (accountId) {
            qb.andWhere("tpl.accountId = :accountId", { accountId });
        }

        if (status && status !== 'all') {
            qb.andWhere("tpl.status = :status", { status });
        }

        if (quality && quality !== 'all') {
            qb.andWhere("tpl.quality = :quality", { quality });
        }

        if (language && language !== 'all') {
            qb.andWhere("tpl.language = :language", { language });
        }

        if (search) {
            qb.andWhere(
                new Brackets((sq) => {
                    sq.where("tpl.name ILIKE :s", { s: `%${search}%` })
                        .orWhere("tpl.metaId ILIKE :s", { s: `%${search}%` });

                }),
            );
        }

        qb.orderBy("tpl.createdAt", "DESC");

        const [records, total] = await qb
            .skip((page - 1) * limit)
            .take(limit)
            .getManyAndCount();

        return { total_records: total, current_page: page, per_page: limit, records };
    }

    async findOne(me: any, id: string) {
        const adminId = tenantId(me);
        const isSuperAdmin = this.isSuperAdmin(me);
        const template = await this.templateRepo.findOne({
            where: isSuperAdmin ? { id } : { id, adminId },
            relations: ['account']
        });
        if (!template) throw new NotFoundException(this.translations.t('domains.whatsapp.template_not_found'));
        return template;
    }

    async metaLibrary(me: any, q: MetaTemplateLibraryQueryDto) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

        const accountId = await this.whatsappService.getDefaultAccountId(adminId, q.accountId);
        const language = q?.language ?? 'ar';
        // const allowedLanguages = ['ar', 'en'];

        // if (language && !allowedLanguages.includes(language)) {
        //     throw new BadRequestException(
        //         'Only Arabic and English template library languages are supported.',
        //     );
        // }

        const params: Record<string, any> = {};
        if (q.search) params.search = q.search;
        if (q.topic) params.topic = q.topic;
        if (q.usecase) params.usecase = q.usecase;
        if (q.industry) params.industry = q.industry;
        if (q.category) params.category = q.category;
        if (language) params.language = q.language;
        if (q.name) params.name = q.name;

        const response = await this.whatsappApi.request<any>({
            accountId,
            method: 'GET',
            endpoint: '/message_template_library',
            params,
            node: 'none',
        });

        //filter out AUTHENTICATION
        const templates = Array.isArray(response) ? response : (response?.data ?? []);

        const filteredTemplates = templates.filter(tpl => tpl.category !== 'AUTHENTICATION');

        return filteredTemplates.map((tpl: any) => this.mapMetaLibraryTemplate(tpl));
    }

    private mapMetaLibraryTemplate(tpl: any): MetaTemplateLibraryItemDto {
        // 1. Determine header string structure and type
        const headerType = tpl.header_type || (tpl.header ? 'TEXT' : undefined);

        const templateConfig: TemplateConfig = {
            headerType: headerType,
            headerText: headerType === 'TEXT' ? tpl.header : undefined,
            bodyText: tpl.body ?? '',
            footerText: tpl.footer ?? undefined,
            examples: this.mapBodyExamples(tpl.body_params, tpl.body_param_types),
            buttons: this.mapButtonsFromMeta(tpl.buttons, tpl.language),
            uiSubcategory: tpl.usecase, // preserved meta key context for frontend dialog structures
        };

        return {
            id: tpl.id,
            name: tpl.name,
            language: tpl.language,
            category: tpl.category,
            topic: tpl.topic,
            usecase: tpl.usecase,
            industry: Array.isArray(tpl.industry) ? tpl.industry : tpl.industry ? [tpl.industry] : [],
            header: tpl.header,
            header_type: headerType,
            body: tpl.body,
            footer: tpl.footer,
            body_params: tpl.body_params,
            body_param_types: tpl.body_param_types,
            buttons: this.mapMetaDtoButtons(tpl.buttons),
            templateConfig,
        };
    }

    private mapBodyExamples(
        bodyParams?: string[],
        bodyParamTypes?: string[],
    ): Record<string, string> | undefined {
        if (!bodyParams?.length) return undefined;

        const out: Record<string, string> = {};
        bodyParams.forEach((v, i) => {
            out[String(i + 1)] = v;
        });

        return out;
    }


    /**
     * Maps the buttons cleanly to mirror MetaTemplateLibraryButtonDto flat payload.
     */
    private mapMetaDtoButtons(buttons?: any[]): MetaTemplateLibraryButtonDto[] | undefined {
        if (!buttons?.length) return undefined;

        return buttons.map((btn) => ({
            type: ['PHONE_NUMBER', 'URL', 'WHATSAPP_CALL'].includes(btn.type) ? btn.type : 'CUSTOM',
            text: btn.text ?? '',
            url: btn.url,
            phone_number: btn.phone_number,
            country_code: btn.country_code
        }));
    }


    async create(me: any, dto: CreateWhatsappTemplateDto) {
        const adminId = tenantId(me);
        const isSuperAdmin = this.isSuperAdmin(me);
        if (!isSuperAdmin && !adminId) {
            throw new BadRequestException(this.translations.t('common.missing_admin_id'));
        }

        let account: WhatsappAccountEntity;
        if (!isSuperAdmin && !dto.accountId) {
            throw new BadRequestException(this.translations.t('common.missing_account_id'));
        }

        if (dto.accountId) {
            account = await this.accountRepo.findOne({
                where: { id: dto.accountId, adminId },
            });
            if (!account) throw new NotFoundException(this.translations.t('domains.whatsapp.whatsapp_account_not_found'));
        }

        let metaId: string | null = null;
        let status = TemplateStatus.PENDING;

        if (!isSuperAdmin) {

            const payload = await this.mapToMetaPayload(dto as any, dto.accountId);

            const metaResponse = await this.whatsappApi.request<{ id }>(
                {
                    accountId: dto.accountId,
                    endpoint: "message_templates",
                    method: "POST",
                    data: payload,

                }
            );
            metaId = metaResponse?.id || null;
        }


        status = TemplateStatus.IN_REVIEW;

        const newTemplate = this.templateRepo.create({
            adminId,
            accountId: dto.accountId || null,
            name: dto.name,
            mobileNumber: account?.mobileNumber || null,
            category: dto.category,
            subCategory: dto.subCategory,
            language: dto.language,
            templateConfig: dto.templateConfig,
            metaId,
            status,
            isActive: true,
        });

        return await this.templateRepo.save(newTemplate);
    }

    /**
     * تحديث القالب محلياً وفي ميتا
     */
    async update(me: any, id: string, dto: UpdateWhatsappTemplateDto) {
        const adminId = tenantId(me);
        const isSuperAdmin = this.isSuperAdmin(me);

        if (!isSuperAdmin && !adminId) {
            throw new BadRequestException(
                this.translations.t("common.missing_admin_id"),
            );
        }

        const template = await this.templateRepo.findOne({
            where: {
                id,
                adminId,
            },
        });

        if (!template) {
            throw new NotFoundException(
                this.translations.t("domains.whatsapp.template_not_found"),
            );
        }

        if (!isSuperAdmin && template.status === TemplateStatus.LOCKED) {
            throw new BadRequestException(
                this.translations.t("domains.whatsapp.locked_templates_cannot_be_edited"),
            );
        }

        const editableStatuses = [
            TemplateStatus.APPROVED,
            TemplateStatus.REJECTED,
            TemplateStatus.PAUSED,
        ];

        if (!isSuperAdmin && !editableStatuses.includes(template.status)) {
            throw new BadRequestException(
                this.translations.t("domains.whatsapp.only_specific_templates_can_be_edited"),
            );
        }

        const payload: any = {};

        if (!isSuperAdmin && dto.templateConfig) {
            const mapped = await this.mapToMetaPayload(
                {
                    ...template,
                    templateConfig: dto.templateConfig,
                } as any,
                template.accountId,
            );

            payload.components = mapped.components;

            if (mapped.message_send_ttl_seconds != null) {
                payload.message_send_ttl_seconds =
                    mapped.message_send_ttl_seconds;
            }

            if (Object.keys(payload).length === 0) {
                throw new BadRequestException(
                    this.translations.t("domains.whatsapp.nothing_to_update"),
                );
            }
        }

        if (!isSuperAdmin) {
            await this.whatsappApi.request({
                accountId: template.accountId,
                endpoint: `${template.metaId}`,
                method: "POST",
                node: "none",
                data: payload,
            });
        }

        if (dto.templateConfig) {
            template.templateConfig = dto.templateConfig as any;
        }

        if (isSuperAdmin) {
            if (dto.name) template.name = dto.name;
            if (dto.category) template.category = dto.category;
            if (dto.subCategory) template.subCategory = dto.subCategory;
            if (dto.language) template.language = dto.language as any;
        }

        if (
            !isSuperAdmin &&
            (
                template.status === TemplateStatus.APPROVED ||
                template.status === TemplateStatus.PAUSED ||
                template.status === TemplateStatus.REJECTED
            )
        ) {
            template.status = TemplateStatus.PENDING;
        }

        return await this.templateRepo.save(template);
    }
      async delete(me: any, id: string) {
        const adminId = tenantId(me);
        const template = await this.findOne(me, id);
        const isSuperAdmin = this.isSuperAdmin(me);
        if (!isSuperAdmin && template.status === TemplateStatus.DISABLED) {
            throw new BadRequestException(await this.requestTranslations.tAsync("domains.whatsapp.disabled_templates_cannot_be_deleted", adminId));
            
        }

        if (!isSuperAdmin) {

            await this.whatsappApi.request(
                {
                    accountId: template.accountId,
                    endpoint: `message_templates?name=${template.name}&hsm_id=${template.metaId}`,
                    method: "DELETE",
                    node: "wabaId",
                }
            );
        }
        return await this.templateRepo.remove(template);
    }
    /**
     * تصدير القوالب لـ Excel
     */
    async export(me: any, q: any) {
        const isSuperAdmin = this.isSuperAdmin(me);
        const { records } = await this.list(me, { ...q, limit: 1000, page: 1 });
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet(
            this.translations.t("domains.whatsapp.templates"),
        );

        worksheet.columns = [
            {
                header: this.translations.t("domains.whatsapp.template_name"),
                key: "name",
                width: 25,
            },
            ...(isSuperAdmin
                ? [
                    {
                        header: this.translations.t("domains.whatsapp.mobile_number"),
                        key: "mobileNumber",
                        width: 25,
                    },
                ]
                : []),
            {
                header: this.translations.t("domains.whatsapp.is_active"),
                key: "isActive",
                width: 15,
            },
            {
                header: this.translations.t("domains.whatsapp.category"),
                key: "category",
                width: 15,
            },
            {
                header: this.translations.t("domains.whatsapp.subcategory"),
                key: "subCategory",
                width: 25,
            },
            {
                header: this.translations.t("domains.whatsapp.language"),
                key: "language",
                width: 10,
            },
            ...(isSuperAdmin
                ? [
                    {
                        header: this.translations.t("domains.whatsapp.status"),
                        key: "status",
                        width: 15,
                    },
                ]
                : []),
            ...(isSuperAdmin
                ? [
                    {
                        header: this.translations.t("domains.whatsapp.quality"),
                        key: "quality",
                        width: 15,
                    },
                ]
                : []),
            {
                header: this.translations.t("domains.whatsapp.created_at"),
                key: "createdAt",
                width: 25,
            },
        ];

        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFE0E0E0" },
        };

        const exportData = records.map((t) => ({
            name: t.name,
            mobileNumber:
                t.account?.mobileNumber ||
                t.mobileNumber ||
                this.translations.t("common.not_available_symbol"),
            isActive: t.isActive,
            category: t.category,
            subCategory:
                t.subCategory ||
                this.translations.t("common.not_available_symbol"),
            language: t.language,
            status: t.status,
            quality: t.quality,
            createdAt: t.createdAt,
        }));

        exportData.forEach((row) => worksheet.addRow(row));
        return await workbook.xlsx.writeBuffer();
    }

    /**
     * محول البيانات ليتناسب مع هيكلة Meta API
     */

    private async resolveHeaderHandle(data: WhatsappTemplateEntity, accountId: string): Promise<string | null> {
        const url = data.templateConfig?.headerUrl;

        if (!url) return null;

        // already uploaded (cached case)
        if (url.startsWith("h:") || url.startsWith("4::")) {
            return url;
        }

        return await this.whatsappApi.uploadMediaToMeta(url, accountId);
    }

    private async mapToMetaPayload(data: WhatsappTemplateEntity, accountId: string): Promise<WhatsappTemplateRemoteDto> {

        const cfg = data.templateConfig;
        if (!cfg) {
            throw new BadRequestException("templateConfig is required");
        }

        let components: WhatsappTemplateComponentDto[] = [];
        const parameterFormat = cfg.parameterFormat || "positional";
        //header
        if (cfg.headerType === 'TEXT' && !!cfg.headerText) {
            let header: HeaderTextComponentDto = { type: 'HEADER', text: cfg.headerText, format: "TEXT" }
            if (cfg?.headerExample)
                if (parameterFormat === "positional") {
                    header.example = {
                        header_text: [
                            cfg.headerExample
                        ]
                    }
                } else {
                    header.example = {
                        header_text_named_params: [
                            {
                                param_name: cfg.headerNamedKey,
                                example: cfg.headerExample
                            }
                        ]
                    }
                }
            components.push(header)
        } else if (["IMAGE", "VIDEO", "DOCUMENT"].includes(cfg.headerType)) {
            const handle = await this.resolveHeaderHandle(data, accountId);

            if (!handle) {
                throw new BadRequestException("Missing media file for header");
            }

            const header: HeaderMediaComponentDto = {
                type: "HEADER",
                format: cfg.headerType as any,
                example: {
                    header_handle: [handle],
                },
            };

            components.push(header);
        } else if (cfg.headerType === "LOCATION") {

            const header: HeaderLocationComponentDto = {
                type: "HEADER",
                format: "LOCATION",
            };

            components.push(header);
        }

        //body
        if (cfg?.bodyText) {
            let body: BodyComponentDto = { type: 'BODY', text: cfg.bodyText }
            if (cfg?.examples) {
                if (parameterFormat === "positional") {
                    const sortedValues = Object.keys(cfg.examples)
                        .sort((a, b) => Number(a) - Number(b)) // 👈 important
                        .map((key) => cfg.examples[key]);

                    body.example = {
                        body_text: [sortedValues],
                    };
                }
                else {
                    body.example = {
                        body_text_named_params: Object.entries(cfg.examples ?? {}).map(
                            ([param_name, example]) => ({
                                param_name,
                                example,
                            }),
                        ),
                    };
                }
            }
            components.push(body)
        } else if (cfg?.addSecurityRecommendation) {
            const body: BodyComponentDto = { type: 'BODY', add_security_recommendation: true, }
            components.push(body)
        }

        //footer
        if (cfg?.footerText) {
            let footer: FooterComponentDto = { type: 'FOOTER', text: cfg.footerText }
            components.push(footer)
        } else if (cfg?.addExpirationTime && cfg?.expirationMinutes) {
            let footer: FooterComponentDto = { type: 'FOOTER', code_expiration_minutes: cfg.expirationMinutes, text: cfg.footerText }
            components.push(footer)
        }


        if (isCallPermissionDbSubcategory(data.subCategory)) {
            components.push({ type: "CALL_PERMISSION_REQUEST" } as any);
        }

        //buttons
        let buttonsComp: ButtonsComponentDto | null = null;
        if (cfg?.buttons?.length) {
            buttonsComp = this.mapButtons(cfg.buttons, data.language);
        }

        const catLower = String(data.category || "").toLowerCase();
        if (catLower === "authentication") {
            const otpType = cfg.authMethod === "NO_ACTION" ? "zero_tap" : "copy_code";
            const text =
                (cfg.otpCopyButtonText && String(cfg.otpCopyButtonText).trim()) ||
                defaultOtpCopyButtonText();
            const otpBtn = {
                type: "otp" as const,
                otp_type: otpType,
                // text: text.slice(0, 25),
            };
            if (buttonsComp) {
                (buttonsComp.buttons as any[]).push(otpBtn);
            } else {
                buttonsComp = {
                    type: "BUTTONS",
                    buttons: [otpBtn] as any,
                };
            }
        }

        if (buttonsComp) {
            components.push(buttonsComp);
        }

        const ttl = messageSendTtlSecondsFromConfig(cfg as any);

        return {
            name: data.name,
            language: data.language,
            category: data.category.toUpperCase() as any,
            sub_category: metaSubCategoryForPayload(data.category, data.subCategory),
            ...(ttl != null ? { message_send_ttl_seconds: ttl } : {}),
            // display_format: "ORDER_DETAILS",
            parameter_format: parameterFormat === "positional" ? "POSITIONAL" : "NAMED",
            allow_category_change: false,
            // cta_url_link_tracking_opted_out: false,
            // send_type: "DIRECT",
            components: components
        };
    }

    private mapButtons(
        buttons: WhatsappTemplateEntity["templateConfig"]["buttons"] = [],
        language?: string,
    ): ButtonsComponentDto | null {
        if (!buttons.length) return null;

        const encoded = (value: string) =>
            encodeURIComponent(value); // 🔥 important for URL params

        const metaButtons: ButtonsComponentDto["buttons"] = [];

        for (const btn of buttons) {
            switch (btn.type) {
                case "PHONE_NUMBER":
                    metaButtons.push({
                        type: "PHONE_NUMBER",
                        text: btn.text.slice(0, 25),
                        phone_number: normalizePhone(btn.countryCode + btn.phoneNumber),
                    });
                    break;

                case "VISIT_WEBSITE": {
                    const url = btn.url || "";

                    // If dynamic URL → encode example
                    const example =
                        btn.urlType === "Dynamic" && btn.urlExample
                            ? [encoded(btn.urlExample)]
                            : undefined;

                    metaButtons.push({
                        type: "URL",
                        text: btn.text.slice(0, 25),
                        url,
                        ...(example ? { example } : {}),
                    });
                    break;
                }

                case "CUSTOM":
                    metaButtons.push({
                        type: "QUICK_REPLY",
                        text: btn.text.slice(0, 25),
                    });
                    break;

                case "WHATSAPP_CALL":
                    metaButtons.push({
                        type: "VOICE_CALL",
                        text: btn.text.slice(0, 25),
                        ttl_minutes: (btn.activeForDays ?? 7) * 24 * 60,
                    });
                    break;

                case "COPY_CODE": {
                    const example = btn.example ? [btn.example] : undefined;
                    const staticText = language === "ar" ? "نسخ رمز العرض" : "Copy offer code";
                    metaButtons.push({
                        type: "COPY_CODE",
                        text: staticText.slice(0, 25),
                        ...(example ? { example } : {}),
                    });
                    break;
                }
            }
        }

        // enforce max 10 quick replies rule safety (optional guard)
        let quickReplies = [];
        let voiceCalls = [];
        let urls = [];
        let phoneNumbers = [];
        let copyCodes = [];

        metaButtons.forEach((btn) => {
            if (btn.type === "QUICK_REPLY") {
                quickReplies.push(btn);
            } else if (btn.type === "VOICE_CALL") {
                voiceCalls.push(btn);
            } else if (btn.type === "URL") {
                urls.push(btn);
            } else if (btn.type === "PHONE_NUMBER") {
                phoneNumbers.push(btn);
            } else if (btn.type === "COPY_CODE") {
                copyCodes.push(btn);
            }
        });

        if (voiceCalls.length > 1) {
            throw new BadRequestException(
                this.translations.t("domains.whatsapp.max_1_voice_call_button_allowed"),
            );
        }

        if (urls.length > 2) {
            throw new BadRequestException(
                this.translations.t("domains.whatsapp.max_2_url_buttons_allowed"),
            );
        }

        if (phoneNumbers.length > 1) {
            throw new BadRequestException(
                this.translations.t("domains.whatsapp.max_1_phone_number_button_allowed"),
            );
        }

        if (copyCodes.length > 1) {
            throw new BadRequestException(
                this.translations.t("domains.whatsapp.max_1_copy_code_button_allowed"),
            );
        }

        if (quickReplies.length > 10) {
            throw new BadRequestException(
                this.translations.t("domains.whatsapp.max_10_quick_reply_buttons_allowed"),
            );
        }

        if (metaButtons.length > 10) {
            throw new BadRequestException(
                this.translations.t("domains.whatsapp.max_10_buttons_allowed"),
            );
        }

        //all max 10 buttons
        if (metaButtons.length > 10) {
            throw new BadRequestException("Max 10 buttons allowed");
        }

        // Move QUICK_REPLY to the end
        metaButtons.sort((a, b) => {
            if (a.type === "QUICK_REPLY" && b.type !== "QUICK_REPLY") return 1;
            if (a.type !== "QUICK_REPLY" && b.type === "QUICK_REPLY") return -1;
            return 0;
        });

        return {
            type: "BUTTONS",
            buttons: metaButtons,
        };
    }

    private mapButtonsFromMeta(buttons?: any[], language?: string,): TemplateConfig['buttons'] {
        if (!buttons?.length) return undefined;

        return buttons.map((btn) => {
            if (btn.type === 'PHONE_NUMBER') {
                return {
                    type: 'PHONE_NUMBER',
                    text: btn.text,
                    phoneNumber: btn.phone_number,
                };
            }

            if (btn.type === 'URL') {
                return {
                    type: 'VISIT_WEBSITE',
                    text: btn.text,
                    url: btn.url,
                    urlType: btn.url?.includes('{{') ? 'Dynamic' : 'Static',
                    urlExample: btn.example?.[0] ? decodeURIComponent(btn.example[0]) : undefined,
                };
            }

            if (btn.type === 'VOICE_CALL') {
                return {
                    type: 'WHATSAPP_CALL',
                    text: btn.text,
                    activeForDays: btn.ttl_minutes ? Math.round(btn.ttl_minutes / (24 * 60)) : 7,
                };
            }

            if (btn.type === 'WHATSAPP_CALL') {
                return {
                    type: 'WHATSAPP_CALL',
                    text: btn.text,
                    countryCode: btn.country_code,
                    phoneNumber: btn.phone_number,
                };
            }

            if (btn.type === 'QUICK_REPLY') {
                return {
                    type: 'CUSTOM',
                    text: btn.text,
                };
            }

            if (btn.type === 'COPY_CODE') {
                const staticText = language === "ar" ? "نسخ رمز العرض" : "Copy offer code";
                return {
                    type: 'COPY_CODE',
                    text: language === "ar" ? btn.text : staticText,
                    example: btn.example?.[0],
                };
            }

            // FLOW / FORMS / unknown Meta button types
            return {
                type: 'CUSTOM',
                text: btn.text,
            } as any;
        });
    }

    private subCategoryFromMeta(metaSub?: string): TemplateSubCategory {
        if (!metaSub) return TemplateSubCategory.BOOKING_STATUS;

        const sub = metaSub.toLowerCase();
        switch (sub) {
            case "order_details":
                return TemplateSubCategory.ORDER_DETAILS;
            case "call_permissions_request":
                return TemplateSubCategory.CALL_PERMISSIONS_REQUEST;
            case "order_status":
                return TemplateSubCategory.ORDER_STATUS;
            case "rich_order_status":
                return TemplateSubCategory.RICH_ORDER_STATUS;
            case "fraud_alert":
                return TemplateSubCategory.FRAUD_ALERT;
            case "flight_delay_and_gate_change_alert":
                return TemplateSubCategory.FLIGHT_DELAY_AND_GATE_CHANGE_ALERT;
            default:
                return TemplateSubCategory.BOOKING_STATUS;
        }
    }

    private qualityFromMeta(metaQuality?: string): TemplateQuality {
        if (!metaQuality) return TemplateQuality.UNKNOWN;

        switch (metaQuality.toUpperCase()) {
            case "GREEN":
                return TemplateQuality.HIGH;

            case "YELLOW":
                return TemplateQuality.MEDIUM;

            case "RED":
                return TemplateQuality.LOW;

            case "UNKNOWN":
            default:
                return TemplateQuality.UNKNOWN;
        }
    }

    private async statusFromMeta(metaStatus?: string, metaTemplateId?: string): Promise<TemplateStatus | null> {

        if (!metaStatus) return null;

        if (metaStatus === "DELETED") {
            const template = await this.templateRepo.findOne({
                where: { metaId: metaTemplateId },
            });
            if (!template) return;
            await this.templateRepo.remove(template);
            await this.notificationService.create({
                userId: template.adminId,
                type: NotificationType.TEMPLATE_DELETED,
                title: await this.requestTranslations.tAsync("domains.whatsapp.template_deleted", template.adminId),
                message: await this.requestTranslations.tAsync("domains.whatsapp.template_deleted_message", template.adminId, {
                    args: { name: template.name }
                }),
                relatedEntityType: "Template",
                relatedEntityId: template.id,
            });
            return null;
        }

        if (metaStatus === "FLAGGED") {
            const template = await this.templateRepo.findOne({
                where: { metaId: metaTemplateId },
            });
            if (!template) return;
            await this.notificationService.create({
                userId: template.adminId,
                type: NotificationType.TEMPLATE_FLAGGED,
                title: await this.requestTranslations.tAsync("domains.whatsapp.template_flagged", template.adminId),
                message: await this.requestTranslations.tAsync("domains.whatsapp.template_flagged_message", template.adminId),
                relatedEntityType: "Template",
                relatedEntityId: template.id,
            });
        }

        switch (metaStatus.toUpperCase()) {
            case "APPROVED":
                return TemplateStatus.APPROVED;
            case "ARCHIVED":
                return TemplateStatus.ARCHIVED;
            case "UNARCHIVED":
                return TemplateStatus.UNARCHIVED;
            case "DISABLED":
                return TemplateStatus.DISABLED;
            case "IN_APPEAL":
                return TemplateStatus.APPEAL_REQUESTED;
            case "LOCKED":
                return TemplateStatus.LOCKED;
            case "PAUSED":
                return TemplateStatus.PAUSED;
            case "PENDING":
                return TemplateStatus.PENDING;
            case "REINSTATED":
                return TemplateStatus.APPROVED;
            case "PENDING_DELETION":
                return TemplateStatus.PENDING_DELETION;
            case "REJECTED":
                return TemplateStatus.REJECTED;
            default:
                return null;
        }
    }

    public async updateQuality(metaTemplateId: string, metaQuality?: string) {
        const quality = this.qualityFromMeta(metaQuality);
        const template = await this.templateRepo.findOneBy({
            metaId: metaTemplateId,
        });

        template.quality = quality;
        await this.templateRepo.save(template)

        await this.notificationService.create({
            userId: template.adminId,
            type: NotificationType.TEMPLATE_QUALITY_UPDATED,
            title: await this.requestTranslations.tAsync("domains.whatsapp.template_quality_updated", template.adminId),
            message: await this.requestTranslations.tAsync(
                "domains.whatsapp.template_quality_updated_message",
                template.adminId,
                {
                    args: { quality },
                },
            ),
            relatedEntityType: "Template",
            relatedEntityId: template.id,
        });

        return template;
    }

    public async updateStatus(metaTemplateId: string, metaStatus?: string) {
        const status = await this.statusFromMeta(metaStatus, metaTemplateId);
        if (!status) return;
        const template = await this.templateRepo.findOneBy({
            metaId: metaTemplateId,
        });

        template.status = status;
        await this.templateRepo.save(template)

        await this.notificationService.create({
            userId: template.adminId,
            type: NotificationType.TEMPLATE_STATUS_UPDATED,
            title: await this.requestTranslations.tAsync("domains.whatsapp.template_status_updated", template.adminId),
            message: await this.requestTranslations.tAsync(
                "domains.whatsapp.template_status_updated_message",
                template.adminId,
                {
                    args: { status },
                },
            ),
            relatedEntityType: "Template",
            relatedEntityId: template.id,
        });
        return template;
    }

    async syncTemplatesFromMeta(adminId: string, accountId: string, wabaId: string, accessToken: string, manager?: any) {
        const metaTemplates = await this.whatsappApi.fetchWabaTemplates(wabaId, accessToken);
        const repo = manager ? manager.getRepository(WhatsappTemplateEntity) : this.templateRepo;

        const templatesToSave = [];

        for (const metaTpl of metaTemplates) {
            const parameterFormat = metaTpl.parameter_format === 'POSITIONAL' ? "positional" : "named";
            const status = await this.statusFromMeta(metaTpl.status);
            const quality = this.qualityFromMeta(metaTpl.quality_score?.score);
            const language = metaTpl.language;
            const subCategory = this.subCategoryFromMeta(metaTpl.sub_category);

            const templateConfig: TemplateConfig = {
                headerType: undefined,
                headerText: undefined,
                bodyText: '',
                footerText: undefined,
                buttons: [],
            };

            templateConfig.parameterFormat = parameterFormat;

            for (const comp of metaTpl.components) {
                if (comp.type === 'HEADER') {
                    templateConfig.headerType = comp.format;
                    if (comp.format === 'TEXT') {
                        templateConfig.headerText = comp.text;
                        if (comp.example?.header_text?.[0]) {
                            templateConfig.headerExample = comp.example.header_text[0];
                        } else if (comp.example?.header_text_named_params?.[0]) {
                            templateConfig.headerExample = comp.example.header_text_named_params[0].example;
                            templateConfig.headerNamedKey = comp.example.header_text_named_params[0].param_name;
                        }
                    } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(comp.format)) {
                        if (comp.example?.header_handle?.[0]) {
                            templateConfig.headerUrl = comp.example.header_handle[0];
                        }
                    }
                } else if (comp.type === 'BODY') {
                    templateConfig.bodyText = comp.text;
                    if (comp.example?.body_text?.[0]) {
                        templateConfig.examples = {};
                        comp.example.body_text[0].forEach((ex, i) => {
                            templateConfig.examples[String(i + 1)] = ex;
                        });
                    } else if (comp.example?.body_text_named_params) {
                        templateConfig.examples = {};
                        comp.example.body_text_named_params.forEach((np: any) => {
                            templateConfig.examples[np.param_name] = np.example;
                        });
                    }
                } else if (comp.type === 'FOOTER') {
                    templateConfig.footerText = comp.text;
                } else if (comp.type === 'BUTTONS') {
                    templateConfig.buttons = this.mapButtonsFromMeta(comp.buttons, language);
                }
            }

            const existing = await repo.findOne({
                where: { name: metaTpl.name, accountId, adminId, language }
            });

            if (existing) {
                existing.status = status || existing.status;
                existing.quality = quality;
                existing.templateConfig = templateConfig;
                existing.category = metaTpl.category?.toLowerCase();
                existing.subCategory = subCategory;
                existing.metaId = metaTpl.id;
                templatesToSave.push(existing);
            } else {
                templatesToSave.push(repo.create({
                    adminId,
                    accountId,
                    name: metaTpl.name,
                    language,
                    category: metaTpl.category?.toLowerCase(),
                    subCategory,
                    status: status || TemplateStatus.APPROVED,
                    quality,
                    templateConfig,
                    metaId: metaTpl.id,
                    isActive: true,
                }));
            }
        }

        if (templatesToSave.length > 0) {
            await repo.save(templatesToSave);
        }
    }
}

