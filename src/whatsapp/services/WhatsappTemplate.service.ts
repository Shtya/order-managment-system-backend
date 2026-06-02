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
    TemplateSubCategory
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

@Injectable()
export class WhatsappTemplateService {
    constructor(
        @InjectRepository(WhatsappAccountEntity)
        private readonly accountRepo: Repository<WhatsappAccountEntity>,

        @InjectRepository(WhatsappTemplateEntity)
        private readonly templateRepo: Repository<WhatsappTemplateEntity>,
        private readonly whatsappApi: WhatsappApiService,
        private readonly notificationService: NotificationService,

        @Inject(forwardRef(() => OrdersService))
        private readonly orderService: OrdersService,
        @Inject(forwardRef(() => WhatsappService))
        private readonly whatsappService: WhatsappService,
    ) { }


    private isSuperAdmin(me: User) {
        return me.role?.name === SystemRole.SUPER_ADMIN;
    }


    async list(me: any, q?: any, superAdmin?: boolean) {
        const adminId = tenantId(me);
        const isSuperAdmin = this.isSuperAdmin(me);

        if (!isSuperAdmin && !adminId) throw new BadRequestException("Missing adminId");

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
        if (!template) throw new NotFoundException("Template not found");
        return template;
    }

    async metaLibrary(me: any, q: MetaTemplateLibraryQueryDto) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException('Missing adminId');

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
            buttons: this.mapButtonsFromMeta(tpl.buttons),
            uiSubcategory: tpl.usecase, // preserved meta key context for frontend dialog structures
        };

        return {
            id: tpl.id,
            name: tpl.name,
            language: tpl.language === 'en' ? 'en' : 'ar', // Safely structural fallback matching entity constraint
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
            throw new BadRequestException("Missing adminId");
        }

        let account: WhatsappAccountEntity;
        if (!isSuperAdmin && !dto.accountId) {
            throw new BadRequestException("AccountId is required");
        }

        if (dto.accountId) {
            account = await this.accountRepo.findOne({
                where: { id: dto.accountId, adminId },
            });
            if (!account) throw new NotFoundException("Account not found");
        }

        let metaId: string | null = null;
        let status = TemplateStatus.PENDING;

        if (!isSuperAdmin) {

            const payload = await this.mapToMetaPayload(dto as any);

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
            throw new BadRequestException("Missing adminId");
        }

        const template = await this.templateRepo.findOne({
            where: {
                id,
                adminId,
            },
        });

        if (!template) {
            throw new NotFoundException("Template not found");
        }

        if (!isSuperAdmin && template.status === TemplateStatus.LOCKED) {
            throw new BadRequestException("Locked templates cannot be edited");
        }
        // Meta restriction
        const editableStatuses = [
            TemplateStatus.APPROVED,
            TemplateStatus.REJECTED,
            TemplateStatus.PAUSED,
        ];

        if (!isSuperAdmin && !editableStatuses.includes(template.status)) {
            throw new BadRequestException(
                "Only APPROVED, REJECTED, or PAUSED templates can be edited",
            );
        }

        // Build Meta payload
        const payload: any = {};

        // components (FULL replacement)
        if (!isSuperAdmin && dto.templateConfig) {
            const mapped = await this.mapToMetaPayload({
                ...template,
                templateConfig: dto.templateConfig,
            } as any);

            payload.components = mapped.components;
            if (mapped.message_send_ttl_seconds != null) {
                payload.message_send_ttl_seconds = mapped.message_send_ttl_seconds;
            }

            // nothing to update
            if (Object.keys(payload).length === 0) {
                throw new BadRequestException("Nothing to update");
            }
        }


        // Meta edit endpoint
        // POST /{id}
        // with existing template name
        if (!isSuperAdmin) {
            await this.whatsappApi.request(
                {
                    accountId: template.accountId,
                    endpoint: `${template.metaId}`,
                    method: "POST",
                    node: "none",
                    data: payload,
                }
            );
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

        // after editing approved/paused:
        // Meta auto re-approves unless review fails
        if (!isSuperAdmin &&
            template.status === TemplateStatus.APPROVED ||
            template.status === TemplateStatus.PAUSED
        ) {
            template.status = TemplateStatus.PENDING;
        }

        return await this.templateRepo.save(template);
    }

    /**
     * حذف القالب محلياً ومن ميتا
     */
    async delete(me: any, id: string) {

        const template = await this.findOne(me, id);
        const isSuperAdmin = this.isSuperAdmin(me);
        if (!isSuperAdmin && template.status === TemplateStatus.DISABLED) {
            throw new BadRequestException("DISABLED templates can't be deleted");
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
        const worksheet = workbook.addWorksheet("WhatsApp Templates");

        worksheet.columns = [
            { header: "Name", key: "name", width: 25 },
            ...(isSuperAdmin ? [{ header: "Mobile Number", key: "mobileNumber", width: 25 }] : []),
            { header: "Is Active", key: "isActive", width: 25 },
            { header: "Category", key: "category", width: 15 },
            { header: "SubCategory", key: "subCategory", width: 25 },
            { header: "Language", key: "language", width: 10 },
            ...(isSuperAdmin ? [{ header: "Status", key: "status", width: 15 }] : []),
            ...(isSuperAdmin ? [{ header: "Quality", key: "quality", width: 15 }] : []),
            { header: "Created At", key: "createdAt", width: 25 },
        ];
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFE0E0E0" },
        };

        const exportData = records.map(t => ({
            "name": t.name,
            "mobileNumber": t.account?.mobileNumber || t.mobileNumber || "N/A",
            "isActive": t.isActive,
            "category": t.category,
            "subCategory": t.subCategory || "N/A",
            "language": t.language,
            "status": t.status,
            "quality": t.quality,
            "createdAt": t.createdAt,
        }));
        exportData.forEach(t => worksheet.addRow(t));
        return await workbook.xlsx.writeBuffer();
    }

    /**
     * محول البيانات ليتناسب مع هيكلة Meta API
     */

    private async resolveHeaderHandle(data: WhatsappTemplateEntity): Promise<string | null> {
        const url = data.templateConfig?.headerUrl;

        if (!url) return null;

        // already uploaded (cached case)
        if (url.startsWith("h:") || url.startsWith("4::")) {
            return url;
        }

        return await this.whatsappApi.uploadMediaToMeta(url);
    }

    private async mapToMetaPayload(data: WhatsappTemplateEntity): Promise<WhatsappTemplateRemoteDto> {

        const cfg = data.templateConfig;
        if (!cfg) {
            throw new BadRequestException("templateConfig is required");
        }

        let components: WhatsappTemplateComponentDto[] = [];

        //header
        if (cfg.headerType === 'TEXT' && !!cfg.headerText) {
            let header: HeaderTextComponentDto = { type: 'HEADER', text: cfg.headerText, format: "TEXT" }
            if (cfg?.headerExample)
                //Property 'example' does not exist on type '{ type: string; text: string; }'.
                header.example = {
                    "header_text": [
                        cfg.headerExample
                    ]
                }
            components.push(header)
        } else if (
            ["IMAGE", "VIDEO", "DOCUMENT"].includes(cfg.headerType)
        ) {
            const handle = await this.resolveHeaderHandle(data);

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
                const sortedValues = Object.keys(cfg.examples)
                    .sort((a, b) => Number(a) - Number(b)) // 👈 important
                    .map((key) => cfg.examples[key]);

                body.example = {
                    body_text: [sortedValues],
                };
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
            buttonsComp = this.mapButtons(cfg.buttons);
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
            parameter_format: "POSITIONAL",
            allow_category_change: false,
            // cta_url_link_tracking_opted_out: false,
            // send_type: "DIRECT",
            components: components
        };
    }

    private mapButtons(
        buttons: WhatsappTemplateEntity["templateConfig"]["buttons"] = [],
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
            }
        }

        // enforce max 10 quick replies rule safety (optional guard)
        let quickReplies = [];
        let voiceCalls = [];
        let urls = [];
        let phoneNumbers = [];

        metaButtons.forEach((btn) => {
            if (btn.type === "QUICK_REPLY") {
                quickReplies.push(btn);
            } else if (btn.type === "VOICE_CALL") {
                voiceCalls.push(btn);
            } else if (btn.type === "URL") {
                urls.push(btn);
            } else if (btn.type === "PHONE_NUMBER") {
                phoneNumbers.push(btn);
            }
        });

        if (voiceCalls.length > 1) {
            throw new BadRequestException("Max 1 voice call button allowed");
        }
        if (urls.length > 2) {
            throw new BadRequestException("Max 2 URL buttons allowed");
        }
        if (phoneNumbers.length > 1) {
            throw new BadRequestException("Max 1 phone number buttons allowed");
        }

        if (quickReplies.length > 10) {
            throw new BadRequestException("Max 10 quick reply buttons allowed");
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

    private mapButtonsFromMeta(buttons?: any[]): TemplateConfig['buttons'] {
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

    private languageFromMeta(metaLang: string): "ar" | "en" {
        if (!metaLang) return "en";
        const lang = metaLang.toLowerCase();
        if (lang.startsWith("ar")) return "ar";
        return "en";
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

    private async statusFromMeta(metaStatus?: string, templateId?: string): Promise<TemplateStatus | null> {

        if (!metaStatus) return null;

        if (metaStatus === "DELETED") {
            const template = await this.templateRepo.findOne({
                where: { id: templateId },
            });
            if (!template) return;
            await this.templateRepo.remove(template);
            await this.notificationService.create({
                userId: template.adminId,
                type: NotificationType.TEMPLATE_DELETED,
                title: "Template Deleted",
                message: `Template ${template.name} has been deleted`,
                relatedEntityType: "Template",
                relatedEntityId: templateId,
            })
            return null;
        }

        if (metaStatus === "FLAGGED") {
            const template = await this.templateRepo.findOne({
                where: { id: templateId },
            });
            if (!template) return;
            this.notificationService.create({
                userId: template.adminId,
                type: NotificationType.TEMPLATE_FLAGGED,
                title: "Template Flagged",
                message: `Template has received negative feedback and is at risk of being disabled`,
                relatedEntityType: "Template",
                relatedEntityId: templateId,
            })
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

    public async updateQuality(templateId: string, metaQuality?: string) {
        const quality = this.qualityFromMeta(metaQuality);
        const template = await this.templateRepo.findOneBy({
            id: templateId,
        });

        template.quality = quality;
        await this.templateRepo.save(template)

        this.notificationService.create({
            userId: template.adminId,
            type: NotificationType.TEMPLATE_QUALITY_UPDATED,
            title: "Template Quality Updated",
            message: `Template quality updated to ${quality}`,
            relatedEntityType: "Template",
            relatedEntityId: templateId,
        })

        return template;
    }

    public async updateStatus(templateId: string, metaStatus?: string) {
        const status = await this.statusFromMeta(metaStatus, templateId);
        if (!status) return;
        const template = await this.templateRepo.findOneBy({
            metaId: templateId,
        });

        template.status = status;
        await this.templateRepo.save(template)

        this.notificationService.create({
            userId: template.adminId,
            type: NotificationType.TEMPLATE_STATUS_UPDATED,
            title: "Template Status Updated",
            message: `Template status updated to ${status}`,
            relatedEntityType: "Template",
            relatedEntityId: templateId,
        })
        return template;
    }

    async syncTemplatesFromMeta(adminId: string, accountId: string, wabaId: string, accessToken: string, manager?: any) {
        const metaTemplates = await this.whatsappApi.fetchWabaTemplates(wabaId, accessToken);
        const repo = manager ? manager.getRepository(WhatsappTemplateEntity) : this.templateRepo;

        const templatesToSave = [];

        for (const metaTpl of metaTemplates) {
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

            for (const comp of metaTpl.components) {
                if (comp.type === 'HEADER') {
                    templateConfig.headerType = comp.format;
                    if (comp.format === 'TEXT') {
                        templateConfig.headerText = comp.text;
                        if (comp.example?.header_text?.[0]) {
                            templateConfig.headerExample = comp.example.header_text[0];
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
                    }
                } else if (comp.type === 'FOOTER') {
                    templateConfig.footerText = comp.text;
                } else if (comp.type === 'BUTTONS') {
                    templateConfig.buttons = this.mapButtonsFromMeta(comp.buttons);
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

