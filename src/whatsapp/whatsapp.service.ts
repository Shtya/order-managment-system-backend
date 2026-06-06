import { BadRequestException, forwardRef, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as crypto from "crypto";
import { WhatsappApiService, WhatsappMessageResponsePayload, WhatsappSendMessagePayload, WhatsappUploadMediaPayload } from './services/WhatsappApi.service';
import { EmbeddedSignupDto } from 'dto/whatsapp.dto';
import { ConversationEntity, ConversationStatus, MessageDirection, MessageStatus, WebhookEventStatus, WebhookEventType, WhatsappAccountEntity, WhatsappMessageEntity, WhatsappMessageType, WhatsappTemplateEntity, WhatsappWebhookEventEntity, TemplateStatus, TemplateQuality } from 'entities/whatsapp.entity';
import { AutomationFlowEntity, AutomationRunEntity, RunStatus } from 'entities/automation.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository, Not, LessThanOrEqual, In } from 'typeorm';
import { WhatsappTemplateService } from './services/WhatsappTemplate.service';
import { getErrorMessage, imageSrc, calculateRange } from 'common/healpers';
import { FlowExecutionQueueService } from 'src/automation/engine/triggerDispatcher.service';
import { OrdersService } from 'src/orders/services/orders.service';
import { normalizeEgyptianPhoneNumber } from 'common/whatsapp';
import { ConversationService } from 'src/conversation/conversation.service';
import axios from 'axios';
import { RedisService } from 'common/redis/RedisService';
import { subDays } from 'date-fns';
import { CustomerService } from 'src/customer/customer.service';
import { CustomerEntity } from 'entities/customers.entity';
import { AppGateway } from 'common/app.gateway';
import { UpsellsService } from 'src/upsells/upsells.service';
import { tenantId } from 'src/category/category.service';


@Injectable()
export class WhatsappService {
    protected readonly logger = new Logger(this.constructor.name);
    constructor(
        private readonly whatsappApi: WhatsappApiService,
        @InjectRepository(WhatsappAccountEntity)
        private readonly accountRepo: Repository<WhatsappAccountEntity>,
        @InjectRepository(WhatsappMessageEntity)
        private readonly messageRepo: Repository<WhatsappMessageEntity>,
        @InjectRepository(WhatsappWebhookEventEntity)
        private readonly webhookRepo: Repository<WhatsappWebhookEventEntity>,
        @InjectRepository(WhatsappTemplateEntity)
        private readonly templateRepo: Repository<WhatsappTemplateEntity>,
        private readonly templateService: WhatsappTemplateService,
        private readonly flowQueue: FlowExecutionQueueService,
        @Inject(forwardRef(() => OrdersService))
        private readonly orderService: OrdersService,
        @Inject(forwardRef(() => ConversationService))
        private readonly conversationService: ConversationService,
        @InjectRepository(ConversationEntity)
        private readonly conversationRepo: Repository<ConversationEntity>,
        @InjectRepository(CustomerEntity)
        private readonly customerRepo: Repository<CustomerEntity>,
        @Inject(forwardRef(() => CustomerService))
        private readonly customerService: CustomerService,
        private readonly appGateway: AppGateway,
        private readonly redisService: RedisService,
        @Inject(forwardRef(() => UpsellsService))
        private readonly upsellsService: UpsellsService,
        @InjectRepository(AutomationRunEntity)
        private readonly runRepo: Repository<AutomationRunEntity>,
    ) {

    }

    async getMessagesByTypeStats(me: any, filters: any = {}) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const { finalStartDate, finalEndDate } = this.getDashboardDateRange(filters);

        const qb = this.messageRepo
            .createQueryBuilder('m')
            .select('m.messageType', 'type')
            .addSelect('COUNT(*)', 'count')
            .where('m.adminId = :adminId', { adminId })
            .andWhere('m.createdAt >= :finalStartDate', { finalStartDate })
            .andWhere('m.createdAt <= :finalEndDate', { finalEndDate });

        if (filters.accountId) {
            qb.andWhere('m.accountId = :accountId', { accountId: filters.accountId });
        }

        return qb.groupBy('m.messageType').orderBy('count', 'DESC').getRawMany();
    }

    async getTopClickedButtons(me: any, limit = 5, filters: any = {}) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const { finalStartDate, finalEndDate } = this.getDashboardDateRange(filters);

        const buttonTextExpr =
            "COALESCE(m.content->'interactive'->'button_reply'->>'title', m.content->'button'->>'text')";

        const qb = this.messageRepo
            .createQueryBuilder('m')
            .select(buttonTextExpr, 'buttonText')
            .addSelect('COUNT(*)', 'count')
            .where('m.adminId = :adminId', { adminId })
            .andWhere('m.direction = :direction', {
                direction: MessageDirection.INBOUND,
            })
            .andWhere('m.createdAt >= :finalStartDate', { finalStartDate })
            .andWhere('m.createdAt <= :finalEndDate', { finalEndDate })
            .andWhere(
                new Brackets((qb) => {
                    qb.where(
                        "m.content->'interactive'->'button_reply'->>'title' IS NOT NULL"
                    ).orWhere(
                        "m.content->'button'->>'text' IS NOT NULL"
                    );
                }),
            );

        if (filters.accountId) {
            qb.andWhere('m.accountId = :accountId', { accountId: filters.accountId });
        }

        return qb.groupBy(buttonTextExpr).orderBy('count', 'DESC').limit(limit).getRawMany();
    }

    async getTopAutomations(me: any, limit = 5, filters: any = {}) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const { finalStartDate, finalEndDate } = this.getDashboardDateRange(filters);

        const qb = this.runRepo
            .createQueryBuilder('run')
            .innerJoin('run.automationFlow', 'flow')
            .select('flow.id', 'id')
            .addSelect('flow.name', 'name')
            .addSelect('COUNT(run.id)', 'totalRuns')
            .addSelect(`COUNT(run.id) FILTER (WHERE run.status = '${RunStatus.COMPLETED}')`, 'completed')
            .addSelect(`COUNT(run.id) FILTER (WHERE run.status = '${RunStatus.FAILED}')`, 'failed')
            .addSelect(`COUNT(run.id) FILTER (WHERE run.status = '${RunStatus.PAUSED}')`, 'paused')
            .where('run.adminId = :adminId', { adminId })
            .andWhere('run.startedAt >= :finalStartDate', { finalStartDate })
            .andWhere('run.startedAt <= :finalEndDate', { finalEndDate });

        // if (filters.accountId) {
        //     // Join with messages to filter runs that sent messages through this account
        //     qb.innerJoin(WhatsappMessageEntity, 'm', 'm.automationRunId = run.id')
        //       .andWhere('m.accountId = :accountId', { accountId: filters.accountId });
        // }

        const stats = await qb
            .groupBy('flow.id')
            .addGroupBy('flow.name')
            .orderBy('COUNT(run.id)', 'DESC')
            .addOrderBy(
                `CASE WHEN COUNT(run.id) > 0 THEN (COUNT(run.id) FILTER (WHERE run.status = '${RunStatus.COMPLETED}') * 100.0 / NULLIF(COUNT(run.id), 0)) ELSE 0 END`,
                'DESC'
            )
            .limit(limit)
            .getRawMany();

        // Calculate success rate and sort
        const results = stats.map(s => {
            const total = parseInt(s.totalRuns, 10);
            const completed = parseInt(s.completed, 10);
            const successRate = total > 0 ? (completed / total) * 100 : 0;
            return {
                ...s,
                totalRuns: total,
                completed,
                failed: parseInt(s.failed, 10),
                paused: parseInt(s.paused, 10),
                successRate: Math.round(successRate * 100) / 100
            };
        });

        return results;
    }

    async getTopTemplates(me: any, limit = 5, filters: any = {}) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const { finalStartDate, finalEndDate } = this.getDashboardDateRange(filters);
        const accountFilter = filters.accountId ? `AND "accountId" = '${filters.accountId}'` : '';

        // Single optimized query using CTEs to get sent, read and click stats
        const query = `
            WITH template_messages AS (
                SELECT 
                    content->'template'->>'name' as name,
                    content->'template'->'language'->>'code' as language,
                    id,
                    status
                FROM whatsapp_messages
                WHERE "adminId" = $1 
                  AND "messageType" = '${WhatsappMessageType.TEMPLATE}' 
                  AND "direction" = '${MessageDirection.OUTBOUND}'
                  AND "createdAt" >= $3
                  AND "createdAt" <= $4
                  ${accountFilter}
            ),
            sent_stats AS (
                SELECT 
                    name,
                    language,
                    COUNT(*) as "sentCount",
                    COUNT(*) FILTER (WHERE status IN ('${MessageStatus.READ}', '${MessageStatus.PLAYED}')) as "readCount"
                FROM template_messages
                GROUP BY name, language
            ),
            click_stats AS (
                SELECT 
                    tm.name,
                    tm.language,
                    COUNT(reply.id) as "clickCount"
                FROM template_messages tm
                INNER JOIN whatsapp_messages reply ON reply."replyToId" = tm.id
                WHERE reply."direction" = '${MessageDirection.INBOUND}'
                  AND reply."messageType" = '${WhatsappMessageType.BUTTON}'
                GROUP BY tm.name, tm.language
            )
            SELECT 
                ss.name,
                ss.language,
                ss."sentCount",
                ss."readCount",
                COALESCE(cs."clickCount", 0) as "clickCount"
            FROM sent_stats ss
            LEFT JOIN click_stats cs ON cs.name = ss.name AND cs.language = ss.language
            ORDER BY "clickCount" DESC, "sentCount" DESC
            LIMIT $2;
        `;

        const stats = await this.messageRepo.query(query, [adminId, limit, finalStartDate, finalEndDate]);

        // Merge with Template Entity data to get categories
        const templates = await this.templateRepo.find({
            where: {
                adminId,
                name: In(stats.map(s => s.name))
            }
        });

        return stats.map(s => {
            const template = templates.find(t => t.name === s.name);
            return {
                ...s,
                category: template?.category || 'UNKNOWN',
                sentCount: parseInt(s.sentCount, 10),
                readCount: parseInt(s.readCount, 10),
                clickCount: parseInt(s.clickCount, 10),
            };
        });
    }

    async getActivityHeatmap(me: any, filters: any = {}) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const { finalStartDate, finalEndDate } = this.getDashboardDateRange(filters);
        const accountFilter = filters.accountId ? `AND "accountId" = '${filters.accountId}'` : '';

        const query = `
            SELECT 
                EXTRACT(ISODOW FROM timezone('Africa/Cairo', COALESCE("sentAt", "createdAt"))) AS "day_of_week", 
                EXTRACT(HOUR FROM timezone('Africa/Cairo', COALESCE("sentAt", "createdAt"))) AS hour, 
                COUNT(*) AS total 
            FROM whatsapp_messages 
            WHERE "adminId" = $1
              AND COALESCE("sentAt", "createdAt") >= $2
              AND COALESCE("sentAt", "createdAt") <= $3
              ${accountFilter}
            GROUP BY 1, 2 
            ORDER BY 1, 2;
        `;

        return this.messageRepo.query(query, [adminId, finalStartDate, finalEndDate]);
    }

    async getWhatsappTrends(
        me: any,
        filters: {
            startDate?: string;
            endDate?: string;
            range?: string;
            points?: number;
            accountId?: string;
        },
    ) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const points = filters.points || 12;
        const { finalStartDate, finalEndDate } = this.getDashboardDateRange(filters);
        const accountFilter = filters.accountId ? `AND m."accountId" = '${filters.accountId}'` : '';

        const query = `
            WITH params AS (
                SELECT
                    $1::timestamptz AS start_date,
                    $2::timestamptz AS end_date,
                    $3::int AS points
            ),
            calc AS (
                SELECT
                    start_date,
                    end_date,
                    points,
                    CEIL(
                        EXTRACT(EPOCH FROM (end_date - start_date)) 
                        / (points * 86400.0)
                    )::int AS segment_days
                FROM params
            ),
            segments AS (
                SELECT 
                    g.idx,
                    c.start_date + (g.idx * (c.segment_days || ' days')::interval) AS seg_start,
                    LEAST(
                        c.start_date + ((g.idx + 1) * (c.segment_days || ' days')::interval),
                        c.end_date
                    ) AS seg_end,
                    c.end_date AS final_end
                FROM calc c,
                generate_series(
                    0,
                    FLOOR(
                        EXTRACT(EPOCH FROM (c.end_date - c.start_date)) 
                        / (c.segment_days * 86400.0)
                    )
                ) AS g(idx)
            )
            SELECT 
                s.seg_start AS "date",
                COUNT(m.id) FILTER (WHERE m.direction = '${MessageDirection.OUTBOUND}') AS "sent",
                COUNT(m.id) FILTER (WHERE m.direction = '${MessageDirection.OUTBOUND}' AND m.status IN ('${MessageStatus.DELIVERED}', '${MessageStatus.READ}')) AS "delivered",
                COUNT(m.id) FILTER (WHERE m.direction = '${MessageDirection.OUTBOUND}' AND m.status IN ('${MessageStatus.READ}', '${MessageStatus.PLAYED}')) AS "read",
                COUNT(m.id) FILTER (WHERE m.direction = '${MessageDirection.INBOUND}' AND m."messageType" IN ('${WhatsappMessageType.BUTTON}', '${WhatsappMessageType.INTERACTIVE}')) AS "clicked"
            FROM segments s
            LEFT JOIN whatsapp_messages m ON m."createdAt" >= s.seg_start  
            AND (
                m."createdAt" < s.seg_end
                OR (s.seg_end = s.final_end AND m."createdAt" <= s.seg_end)
            ) AND m."adminId" = $4
            ${accountFilter}
            GROUP BY s.idx, s.seg_start
            ORDER BY s.seg_start ASC;
        `;

        const result = await this.messageRepo.query(query, [finalStartDate, finalEndDate, points, adminId]);

        return result.map((row) => ({
            date: row.date,
            sent: parseInt(row.sent),
            delivered: parseInt(row.delivered),
            read: parseInt(row.read),
            clicked: parseInt(row.clicked),
        }));
    }

    async getDashboardStats(me: any, filters: any = {}) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const { finalStartDate, finalEndDate } = this.getDashboardDateRange(filters);

        const [messageStatsRaw, accountStats, templateStats, upsellStats] = await Promise.all([
            // 1. All time outbound message stats
            this.messageRepo
                .createQueryBuilder('m')
                .select('m.status', 'status')
                .addSelect('m.messageType', 'type')
                .addSelect('COUNT(*)', 'count')
                .where('m.adminId = :adminId', { adminId })
                .andWhere('m.direction = :direction', { direction: MessageDirection.OUTBOUND })
                .andWhere('m.createdAt >= :finalStartDate', { finalStartDate })
                .andWhere('m.createdAt <= :finalEndDate', { finalEndDate })
                .andWhere(filters.accountId ? 'm.accountId = :accountId' : '1=1', { accountId: filters.accountId })
                .groupBy('m.status')
                .addGroupBy('m.messageType')
                .getRawMany(),

            // 2. Account stats
            this.accountRepo.count({ where: { adminId } }),

            // 3. Template stats
            this.templateRepo
                .createQueryBuilder('t')
                .select('t.status', 'status')
                .addSelect('t.quality', 'quality')
                .addSelect('COUNT(*)', 'count')
                .where('t.adminId = :adminId', { adminId })
                .andWhere(filters.accountId ? 't.accountId = :accountId' : '1=1', { accountId: filters.accountId })
                .groupBy('t.status')
                .addGroupBy('t.quality')
                .getRawMany(),

            // 4. Upsell stats
            this.upsellsService.stats(me, filters),
        ]);

        const stats = {
            messages: {
                totalSent: 0,
                delivered: 0,
                read: 0,
                failed: 0,
                buttonClicks: 0,
            },
            accounts: accountStats,
            templates: {
                total: 0,
                approved: 0,
                rejected: 0,
                lowQuality: 0,
            },
            upsells: upsellStats,
        };

        // Process Message Stats
        messageStatsRaw.forEach(s => {
            const count = parseInt(s.count, 10);
            stats.messages.totalSent += count;
            if (s.status === MessageStatus.DELIVERED || s.status === MessageStatus.READ || s.status === MessageStatus.PLAYED) stats.messages.delivered += count;
            if (s.status === MessageStatus.READ || s.status === MessageStatus.PLAYED) stats.messages.read += count;
            if (s.status === MessageStatus.FAILED) stats.messages.failed += count;
        });

        // To get actual button clicks, we need a separate query for inbound interactive messages
        const buttonClicksQuery = this.messageRepo
            .createQueryBuilder('m')
            .where('m.adminId = :adminId', { adminId })
            .andWhere('m.direction = :direction', { direction: MessageDirection.INBOUND })
            .andWhere('m.messageType IN (:...types)', { types: [WhatsappMessageType.BUTTON, WhatsappMessageType.INTERACTIVE] })
            .andWhere('m.createdAt >= :finalStartDate', { finalStartDate })
            .andWhere('m.createdAt <= :finalEndDate', { finalEndDate });

        if (filters.accountId) {
            buttonClicksQuery.andWhere('m.accountId = :accountId', { accountId: filters.accountId });
        }

        stats.messages.buttonClicks = await buttonClicksQuery.getCount();

        // Process Template Stats
        templateStats.forEach(s => {
            const count = parseInt(s.count, 10);
            stats.templates.total += count;
            if (s.status === TemplateStatus.APPROVED) stats.templates.approved += count;
            if (s.status === TemplateStatus.REJECTED) stats.templates.rejected += count;
            if (s.quality === TemplateQuality.LOW) stats.templates.lowQuality += count;
        });

        return stats;
    }

    private getDashboardDateRange(filters: { startDate?: string; endDate?: string; range?: string }) {
        let { start, end } = calculateRange(filters.range);
        const finalStartDate = start || (filters.startDate ? new Date(filters.startDate) : subDays(new Date(), 30));
        const finalEndDate = end || (filters.endDate ? new Date(filters.endDate) : new Date());
        return { finalStartDate, finalEndDate };
    }

    async getDefaultAccountId(adminId: string, accountId?: string): Promise<string> {
        if (!accountId) {
            const settings = await this.orderService.getSettings(adminId);
            accountId = settings?.defaultWhatsAppAccountId;
            if (!accountId) {
                // get first active account
                const activeAccount = await this.accountRepo.findOne({
                    where: { adminId, isActive: true },
                });
                accountId = activeAccount?.id;
            }
        }

        if (!accountId) {
            throw new BadRequestException('Missing accountId');
        }

        return accountId;
    }

    async uploadMedia(me: any, payload: WhatsappUploadMediaPayload, accountId?: string) {
        const adminId = me.adminId || me.id;
        if (!adminId) throw new BadRequestException("Missing adminId");
        const url = imageSrc(payload.url);
        if (!payload.file && !url) {
            throw new BadRequestException("Either file or url is required");
        }

        const resolvedAccountId = await this.getDefaultAccountId(adminId, accountId);

        let filename = payload.filename;
        // Check cache if it's a URL
        if (url && !payload.file) {
            const cacheKey = `whatsapp_media:${resolvedAccountId}:${url}`;
            const cacheValue = await this.redisService.get(cacheKey);
            if (cacheValue) {
                if (typeof cacheValue === 'object') {
                    return { ...cacheValue, filename: payload.filename };
                } else {
                    return { id: cacheValue };
                }
            }

            try {
                const response = await axios.get(url, { responseType: 'arraybuffer' });
                const buffer = Buffer.from(response.data, 'binary');
                const contentType = response.headers['content-type']?.split(';')[0]; // Clean mime type (remove charset)

                // Clean filename: remove query params and hash
                const urlPath = url.split('?')[0].split('#')[0];
                filename = urlPath.split('/').pop() || 'file';

                // If filename doesn't have an extension, try to add one from contentType
                if (!filename.includes('.') && contentType) {
                    const extension = contentType.split('/')[1];
                    if (extension) {
                        // Handle common cleanups (e.g., jpeg -> jpg)
                        const cleanExt = extension === 'jpeg' ? 'jpg' : extension;
                        filename += `.${cleanExt}`;
                    }
                }

                payload.file = {
                    buffer,
                    mimetype: contentType,
                    originalname: filename,
                    size: buffer.length,
                    fieldname: 'file',
                    encoding: '7bit',
                } as Express.Multer.File;
                payload.mimeType = contentType;
            } catch (error) {
                this.logger.error(`Failed to download media from URL: ${payload.url}`, error.stack);
                throw new BadRequestException(`Failed to download media from URL: ${getErrorMessage(error)}`);
            }
        }

        const response = await this.whatsappApi.uploadMessageMedia(resolvedAccountId, payload);

        // Cache the result if it was a URL upload
        if (payload.url && response?.id) {
            const cacheKey = `whatsapp_media:${resolvedAccountId}:${payload.url}`;
            await this.redisService.set(cacheKey, { id: response.id, filename: payload.filename }, 3600 * 24 * 29); // Cache for 29 days
        }

        return { ...response, filename: filename };
    }

    async downloadMedia(me: any, mediaId: string, accountId?: string, headers?: Record<string, string>) {
        const adminId = me.adminId || me.id;
        if (!adminId) throw new BadRequestException("Missing adminId");
        if (!mediaId) {
            throw new BadRequestException('Media ID is required');
        }

        const resolvedAccountId = await this.getDefaultAccountId(adminId, accountId);

        // STEP 1: get Meta URL
        const mediaInfo = await this.whatsappApi.getMediaUrl(resolvedAccountId, mediaId);

        if (!mediaInfo.url) {
            throw new BadRequestException('Media URL not found');
        }
        // STEP 2: download stream directly (NOT Graph API)
        return this.whatsappApi.streamMedia(resolvedAccountId, mediaInfo.url, headers);
    }

    async streamMedia(me: any, mediaUrl: string, accountId?: string, headers?: Record<string, string>) {
        const adminId = me.adminId || me.id;
        if (!adminId) throw new BadRequestException("Missing adminId");
        if (!mediaUrl) {
            throw new BadRequestException('Media URL is required');
        }

        const resolvedAccountId = await this.getDefaultAccountId(adminId, accountId);

        return this.whatsappApi.streamMedia(resolvedAccountId, mediaUrl, headers);
    }

    async sendMessage(me: any, payload: WhatsappSendMessagePayload & { metadata?: Record<string, any>; }, accountId?: string, localId?: string) {
        const adminId = me.adminId || me.id;
        if (!adminId) throw new BadRequestException("Missing adminId");

        const resolvedAccountId = await this.getDefaultAccountId(adminId, accountId);

        // Normalize phone number and manage customer/conversation
        const normalizedPhoneNumber = normalizeEgyptianPhoneNumber(payload.to);
        payload.to = normalizedPhoneNumber;

        await this.conversationService.getOrCreateConversation(me, {
            phoneNumber: normalizedPhoneNumber,
            name: payload.to,
        });

        // Extract metadata if present (sent from frontend)
        const { metadata, ...metaPayload } = payload;

        const response = await this.whatsappApi.sendMessage(resolvedAccountId, metaPayload);

        // Attach localId and metadata to the response so processOutboundMessage can use it
        if (localId) {
            (response as any).localId = localId;
        }

        await this.processOutboundMessage(adminId, resolvedAccountId, normalizedPhoneNumber, response, metadata);

        return response;
    }

    async sendTemplate(
        me: any,
        input: {
            to: string;
            templateId: string;
            headerVariables?: Record<string, any>;
            bodyVariables?: Record<string, any>;
            buttonVariables?: Record<string, any>;
            locationData: {
                latitude: string;
                longitude: string;
                address: any,
                name: any,
            }
            headerUrl?: string; // Optional URL for media headers if not already in variables
        },
        accountId?: string,
        localId?: string,
        metadata?: Record<string, any>
    ) {
        const adminId = me.adminId || me.id;
        if (!adminId) throw new BadRequestException("Missing adminId");

        const template = await this.templateRepo.findOne({
            where: { id: input.templateId, adminId }
        });

        if (!template) {
            throw new NotFoundException(`Template ${input.templateId} not found`);
        }

        const components: any[] = [];

        // 1. Build Header
        if (template.templateConfig?.headerType) {
            const hType = template.templateConfig.headerType;
            const parameters: any[] = [];

            if (hType === 'TEXT' && input.headerVariables) {
                Object.values(input.headerVariables).forEach(val => {
                    parameters.push({ type: 'text', text: String(val?.value ?? val) });
                });
            } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(hType)) {
                const mediaUrl = input.headerUrl || template.templateConfig.headerUrl;
                if (mediaUrl) {

                    const media = await this.uploadMedia(me, { url: mediaUrl }, template.accountId);
                    if (!media?.id) {
                        throw new BadRequestException('Media upload failed');
                    }
                    parameters.push({
                        type: hType.toLowerCase(),
                        [hType.toLowerCase()]: { id: media.id, ...(hType === 'DOCUMENT' ? { filename: media?.filename } : {}) }
                    });
                }
            } else if (hType === 'LOCATION') {
                parameters.push({
                    type: 'location',
                    "location": {
                        latitude: input.locationData.latitude,
                        longitude: input.locationData.longitude,
                        address: input.locationData.address,
                        name: input.locationData.name
                    }
                });
            }

            if (parameters.length > 0) {
                components.push({ type: 'header', parameters });
            }
        }

        // 2. Build Body
        if (input.bodyVariables) {
            const parameters = Object.values(input.bodyVariables).map(val => ({
                type: 'text',
                text: String(val?.value ?? val)
            }));
            if (parameters.length > 0) {
                components.push({ type: 'body', parameters });
            }
        }

        // 3. Build Buttons
        if (input.buttonVariables) {
            Object.entries(input.buttonVariables).forEach(([index, val]: [string, any]) => {
                components.push({
                    type: 'button',
                    sub_type: 'url',
                    index: String(index),
                    parameters: [{
                        type: 'text',
                        text: String(val?.value ?? val)
                    }]
                });
            });
        }

        const payload: WhatsappSendMessagePayload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: input.to,
            type: 'template',
            template: {
                name: template.name,
                language: { code: template.language || 'en_US' },
                components
            }
        };

        const templateMetadata = {
            template: {
                templateConfig: template.templateConfig,
                language: template.language,
                category: template.category,
                subCategory: template.subCategory
            },
        }
        return this.sendMessage(me, { ...payload, metadata: { ...metadata, ...templateMetadata } }, accountId, localId);
    }

    async processOutboundMessage(
        adminId: string,
        accountId: string,
        contactNumber: string,
        response: WhatsappMessageResponsePayload,
        metadata?: Record<string, any>,
    ) {
        try {
            const messageId = response.messages?.[0]?.id;
            if (!messageId) return;

            // Ensure conversation exists
            const conversation = await this.conversationService.getOrCreateConversation({ id: adminId }, {
                phoneNumber: contactNumber,
                name: contactNumber,
            });
            const payload = response.payload;

            // Handle Outbound Reactions and Replies (Context)
            let reactionToId: string = null;
            let replyToId: string = null;

            if (payload.type === 'reaction' && (payload as any).reaction?.message_id) {
                const parent = await this.messageRepo.findOne({ where: { messageId: (payload as any).reaction.message_id, adminId } });
                if (parent) reactionToId = parent.id;
            }

            if ((payload as any).context?.message_id) {
                const parent = await this.messageRepo.findOne({ where: { messageId: (payload as any).context.message_id, adminId } });
                if (parent) replyToId = parent.id;
            }

            // Handle Template Metadata for Frontend Preview
            let templateMetadata = null;
            if (payload.type === 'template' && payload.template?.name) {
                const template = await this.templateRepo.findOne({
                    where: {
                        name: payload.template.name,
                        accountId,
                        adminId
                    }
                });
                if (template) {
                    templateMetadata = {
                        templateConfig: template.templateConfig,
                        language: template.language,
                        category: template.category,
                        subCategory: template.subCategory,
                    };
                }
            }

            const message = this.messageRepo.create({
                adminId,
                accountId,
                messageId,
                contactNumber,
                direction: MessageDirection.OUTBOUND,
                status: MessageStatus.ACCEPTED,
                messageType: payload.type as any,
                content: payload,
                customerId: conversation.customerId,
                conversationId: conversation.id,
                metadata: {
                    ...(response.localId ? { localId: response.localId } : {}),
                    ...(metadata ? metadata : {}),
                    ...(templateMetadata ? { template: templateMetadata } : {})
                },
                reactionToId,
                replyToId,
            });
            const savedMsg = await this.messageRepo.save(message);

            // Fetch with relations
            const finalMsg = await this.messageRepo.findOne({
                where: { id: savedMsg.id },
                relations: ['replyTo', 'reactionTo']
            });

            // Update conversation metadata
            let preview = `[${(payload.type || 'MESSAGE').toUpperCase()}]`;
            if (payload.type === 'text') {
                preview = payload.text?.body;
            } else if (payload.type === 'reaction') {
                preview = `Reaction: ${(payload as any).reaction?.emoji}`;
            } else if (payload.type === 'template') {
                preview = `[TEMPLATE: ${payload.template?.name}]`;
            } else if (payload.type === 'interactive') {
                preview = `[INTERACTIVE: ${payload.interactive?.type}]`;
            }

            conversation.lastMessageId = savedMsg.id;
            conversation.lastMessageDirection = MessageDirection.OUTBOUND;
            conversation.lastMessageType = savedMsg.messageType;
            conversation.lastMessagePreview = preview;
            conversation.lastMessageAt = new Date();
            conversation.lastOutgoingMessageAt = new Date();
            await this.conversationService.save(conversation);

            // Emit notifications
            this.appGateway.emitNewMessage(adminId, finalMsg);

            return finalMsg;
        } catch (e) {
            this.logger.error(`Failed to process outbound message: ${e.message}`, e.stack);
        }
    }

    async markAsRead(me: any, payload: { messageId?: string, conversationId?: string }) {
        const adminId = me.adminId || me.id;
        if (!adminId) throw new BadRequestException("Missing adminId");

        if (payload.messageId) {
            const message = await this.messageRepo.findOne({ where: { messageId: payload.messageId, adminId } });
            if (message && message.direction === MessageDirection.INBOUND) {
                // 1. Call Meta API
                try {
                    await this.whatsappApi.markMessageAsRead(message.accountId, message.messageId);
                    message.status = MessageStatus.READ;
                    message.readAt = new Date();
                    await this.messageRepo.save(message);
                } catch (e) {
                    this.logger.error(`Failed to mark message ${message.messageId} as read on Meta: ${e.message}`, e.stack);
                }

                // 2. Sync locally
                await this.syncMessageReadStatus(message);

                // 3. Emit update notification
                this.appGateway.emitUpdateMessage(adminId, message);
            }
        } else if (payload.conversationId) {
            const conversation = await this.conversationRepo.findOne({ where: { id: payload.conversationId, adminId } });
            if (conversation) {
                // Find latest inbound message to mark as read on Meta
                const latestInbound = await this.messageRepo.findOne({
                    where: { conversationId: conversation.id, direction: MessageDirection.INBOUND },
                    order: { createdAt: 'DESC' }
                });

                if (latestInbound) {
                    try {
                        await this.whatsappApi.markMessageAsRead(latestInbound.accountId, latestInbound.messageId);
                    } catch (e) {
                        this.logger.error(`Failed to mark conversation ${conversation.id} as read on Meta: ${e.message}`, e.stack);
                    }
                    // Sync all locally using the latest message as reference
                    await this.syncMessageReadStatus(latestInbound);
                    // We don't emit for every message for performance, frontend should refresh or we could emit a specific event
                }
            }
        }

        return { success: true };
    }

    private async syncMessageReadStatus(message: WhatsappMessageEntity, readAt: Date = new Date()) {
        if (!message.conversationId) return;

        // Mark this and all earlier messages of the SAME direction as READ in local DB
        const result = await this.messageRepo
            .createQueryBuilder()
            .update()
            .set({
                status: MessageStatus.READ,
                readAt,
            })
            .where('conversationId = :conversationId', {
                conversationId: message.conversationId,
            })
            .andWhere('direction = :direction', {
                direction: message.direction,
            })
            .andWhere('status != :status', {
                status: MessageStatus.READ,
            })
            .andWhere(`
                DATE_TRUNC('second', "createdAt")
                <= DATE_TRUNC('second', :createdAt::timestamp)
            `, {
                createdAt: message.createdAt,
            })
            .execute();

        // If it's an inbound message, we must recalculate the unread count for the conversation
        if (message.direction === MessageDirection.INBOUND) {
            const unreadCount = await this.messageRepo.count({
                where: {
                    conversationId: message.conversationId,
                    direction: MessageDirection.INBOUND,
                    status: MessageStatus.RECEIVED
                }
            });
            await this.conversationRepo.update(message.conversationId, { unreadCount });
        }
    }

    async exchangeCodeForToken(code: string, state?: string) {
        const params = new URLSearchParams({
            client_id: process.env.META_APP_ID!,
            client_secret: process.env.META_APP_SECRET!,
            redirect_uri: process.env.META_REDIRECT_URI!,
            code,
        });

        const response = await fetch(
            `https://graph.facebook.com/v22.0/oauth/access_token?${params.toString()}`,
            {
                method: 'GET',
            },
        );
        const data = await response.json();
        console.log(data);


        return response.json();
    }

    /**
 * Subscribe WABA to app webhooks
 *
 * Meta endpoint:
 * POST /{WABA_ID}/subscribed_apps
 */

    async subscribeAppToWebhook(accountId: string) {

        const response = await this.whatsappApi.request({
            method: "POST",
            accountId,
            endpoint: "subscribed_apps",
            data: {},
        });

        return response;

    }

    async unSubscribeAppToWebhook(accountId: string) {

        const response = await this.whatsappApi.request({
            method: "DELETE",
            accountId,
            endpoint: "subscribed_apps",
            data: {},
        });

        return response;

    }

    private validateSignature(
        rawBody: Buffer,
        signatureHeader?: string,
    ) {
        if (!signatureHeader) {
            throw new BadRequestException(
                'Missing X-Hub-Signature-256 header',
            );
        }

        const appSecret = process.env.META_APP_SECRET;

        if (!appSecret) {
            throw new Error('META_APP_SECRET is not configured');
        }

        const receivedSignature = signatureHeader.replace(
            'sha256=',
            '',
        );

        const expectedSignature = crypto
            .createHmac('sha256', appSecret)
            .update(rawBody)
            .digest('hex');

        const isValid = crypto.timingSafeEqual(
            Buffer.from(receivedSignature, 'hex'),
            Buffer.from(expectedSignature, 'hex'),
        );

        if (!isValid) {
            throw new BadRequestException(
                'Invalid webhook signature',
            );
        }

        return true;
    }

    //Unacknowledged responses will be dropped after 7 days.
    async handleEvents(
        body: any,
        rawBody: Buffer,
        headers: Record<string, string>,
    ) {
        this.logger.log(`WhatsApp Webhook Received - Headers: ${JSON.stringify(headers)}`);
        this.logger.log(`WhatsApp Webhook Received - Body: ${JSON.stringify(body)}`);

        // Header can arrive lowercase in Node/Nest
        const signature =
            headers["x-hub-signature-256"] ||
            headers["X-Hub-Signature-256"];

        // Step 1: Validate request
        this.validateSignature(rawBody, signature);

        const entries = body?.entry || [];

        // 🔥 request-scoped cache (ONLY THIS REQUEST)
        const accountCache = new Map<string, WhatsappAccountEntity>();

        const resolveAccount = async (wabaId: any) => {
            if (!wabaId) {
                throw new BadRequestException("Missing WABA ID");
            }

            // 1. check request cache
            if (accountCache.has(wabaId)) {
                return accountCache.get(wabaId)!;
            }

            // 2. DB lookup
            const account = await this.accountRepo.findOne({
                where: [
                    { wabaId },
                ],
            });

            if (!account) {
                throw new BadRequestException("Account not found");
            }

            if (!account.isActive) {
                throw new BadRequestException("Account is not active");
            }

            if (!account.wabaId) {
                throw new BadRequestException("Account not linked to WhatsApp");
            }

            // 3. store in request cache
            accountCache.set(wabaId, account);

            return account;
        };

        for (const entry of entries) {
            const account = await resolveAccount(entry?.id);
            const changes = entry?.changes || [];

            for (const change of changes) {
                const field = change?.field as WebhookEventType;
                const value = change?.value;

                // Save raw webhook event
                const webhookEvent = this.webhookRepo.create({
                    adminId: account.adminId,
                    accountId: account.id,
                    wabaId: entry.id,
                    eventType: field,
                    rawPayload: change,
                    processingStatus: WebhookEventStatus.PENDING,
                });
                await this.webhookRepo.save(webhookEvent);

                try {
                    switch (field) {

                        case WebhookEventType.ACCOUNT_ALERTS:
                            await this.handleAccountAlerts(value, account)
                            break;
                        case WebhookEventType.MESSAGES:
                            await this.handleMessages(value, account)
                            break;
                        case WebhookEventType.CALLS:
                            await this.handleCalls(value, account)
                            break;
                        case WebhookEventType.CONSUMER_PROFILE:
                            await this.handleConsumerProfile(value, account)
                            break;
                        case WebhookEventType.MESSAGING_HANDOVERS:
                            await this.handleMessagingHandovers(value, account)
                            break;
                        case WebhookEventType.GROUP_LIFECYCLE_UPDATE:
                            await this.handleGroupLifecycleUpdate(value, account)
                            break;
                        case WebhookEventType.GROUP_PARTICIPANTS_UPDATE:
                            await this.handleGroupParticipantsUpdate(value, account)
                            break;
                        case WebhookEventType.GROUP_SETTINGS_UPDATE:
                            await this.handleGroupSettingsUpdate(value, account)
                            break;
                        case WebhookEventType.GROUP_STATUS_UPDATE:
                            await this.handleGroupStatusUpdate(value, account)
                            break;
                        case WebhookEventType.SMB_MESSAGE_ECHOES:
                            await this.handleSmbMessageEchoes(value, account)
                            break;
                        case WebhookEventType.SMB_APP_STATE_SYNC:
                            await this.handleSmbAppStateSync(value, account)
                            break;
                        case WebhookEventType.HISTORY:
                            await this.handleHistory(value, account)
                            break;
                        case WebhookEventType.ACCOUNT_SETTINGS_UPDATE:
                            await this.handleAccountSettingsUpdate(value, account)
                            break;
                        case WebhookEventType.MESSAGE_TEMPLATE_STATUS_UPDATE:
                            await this.handleTemplateStatusUpdate(value, account)
                            break;
                        case WebhookEventType.MESSAGE_TEMPLATE_QUALITY_UPDATE:
                            await this.handleTemplateQualityUpdate(value, account)
                            break;
                        case WebhookEventType.MESSAGE_TEMPLATE_COMPONENTS_UPDATE:
                            await this.handleTemplateComponentsUpdate(value, account)
                            break;
                        case WebhookEventType.TEMPLATE_CATEGORY_UPDATE:
                            await this.handleTemplateCategoryUpdate(value, account)
                            break;
                        case WebhookEventType.ACCOUNT_UPDATE:
                            await this.handleAccountUpdate(value, account)
                            break;
                        case WebhookEventType.ACCOUNT_REVIEW_UPDATE:
                            await this.handleAccountReviewUpdate(value, account)
                            break;
                        default:
                            this.logger.warn(
                                `Unhandled webhook field: ${field}`,
                            );
                    }

                    // Mark as processed
                    webhookEvent.processingStatus = WebhookEventStatus.PROCESSED;
                    await this.webhookRepo.save(webhookEvent);

                } catch (error) {
                    this.logger.error(
                        `Error processing webhook field: ${field}`,
                        error,
                    );
                    webhookEvent.processingStatus = WebhookEventStatus.FAILED;
                    webhookEvent.processingError = getErrorMessage(error);
                    await this.webhookRepo.save(webhookEvent);
                }
            }
        }

        return "OK";
    }

    private async handleTemplateStatusUpdate(value: any, account: WhatsappAccountEntity) {
        await this.templateService.updateStatus(
            value.message_template_id,
            value.event,
        );
    }

    private async handleTemplateQualityUpdate(value: any, account: WhatsappAccountEntity) {
        await this.templateService.updateQuality(
            value.message_template_id,
            value.new_quality_score,
        );
    }


    private async handleMessages(value: any, account: WhatsappAccountEntity) {
        const messages = value?.messages || [];
        const statuses = value?.statuses || [];
        if (messages.length === 0 && statuses.length === 0) return;
        await this.handleStatuses(value, account)
        for (const metaMsg of messages) {
            await this.receivedMessage(metaMsg, account);
        }
    }

    private async receivedMessage(metaMsg: any, account: WhatsappAccountEntity) {
        const messageId = metaMsg.id;
        const from = metaMsg.from;
        const type = metaMsg.type as WhatsappMessageType;

        const existing = await this.messageRepo.findOne({ where: { messageId } });
        if (existing) return;

        // Manage customer and conversation
        const normalizedPhoneNumber = normalizeEgyptianPhoneNumber(from);
        const customer = await this.customerService.getOrCreateCustomer({ id: account.adminId }, {
            phoneNumber: normalizedPhoneNumber,
            name: metaMsg.contacts?.[0]?.profile?.name || normalizedPhoneNumber,
        });

        const conversation = await this.conversationService.getOrCreateConversation({ id: account.adminId }, {
            phoneNumber: normalizedPhoneNumber,
            name: customer.name,
        });

        // Handle Reactions and Replies (Context)
        let reactionToId: string = null;
        let replyToId: string = null;

        if (type === WhatsappMessageType.REACTION && metaMsg.reaction?.message_id) {
            const parent = await this.messageRepo.findOne({ where: { messageId: metaMsg.reaction.message_id, adminId: account.adminId } });
            if (parent) reactionToId = parent.id;
        }

        if (metaMsg.context?.id) {
            const parent = await this.messageRepo.findOne({ where: { messageId: metaMsg.context.id, adminId: account.adminId } });
            if (parent) replyToId = parent.id;
        }

        const message = this.messageRepo.create({
            adminId: account.adminId,
            accountId: account.id,
            messageId,
            contactNumber: from,
            direction: MessageDirection.INBOUND,
            status: MessageStatus.RECEIVED,
            messageType: type,
            content: metaMsg,
            customerId: customer.id,
            conversationId: conversation.id,
            reactionToId,
            replyToId,
        });

        const savedMsg = await this.messageRepo.save(message);

        // Fetch with relations to emit to frontend
        const finalMsg = await this.messageRepo.findOne({
            where: { id: savedMsg.id },
            relations: ['replyTo', 'reactionTo']
        });

        // Update conversation metadata and increment unread count
        // Reactions usually don't count as unread messages in many chat apps, 
        // but user requested "handle its remaing loigc as unread count normally"
        conversation.unreadCount = (conversation.unreadCount || 0) + 1;
        conversation.lastMessageId = savedMsg.id;
        conversation.lastMessageDirection = MessageDirection.INBOUND;
        conversation.lastMessageType = savedMsg.messageType;
        conversation.lastMessagePreview = type === 'text' ? metaMsg.text?.body : (type === 'reaction' ? `Reaction: ${metaMsg.reaction?.emoji}` : `[${type.toUpperCase()}]`);
        conversation.lastMessageAt = new Date();
        conversation.lastIncomingMessageAt = new Date();
        await this.conversationService.save(conversation);

        // Update customer
        customer.lastMessageAt = new Date();
        await this.customerRepo.save(customer);

        // Emit notifications
        this.appGateway.emitNewMessage(account.adminId, finalMsg);

        const replyData = this.extractReplyData(metaMsg);
        if (replyData) {
            const originalMessageId = metaMsg.context?.id;
            if (originalMessageId) {
                // Push resume job to queue instead of direct execution
                await this.flowQueue.add({
                    type: 'resume',
                    adminId: account.adminId,
                    resumeData: {
                        originalMessageId,
                        buttonText: replyData.text,
                        buttonId: replyData.id
                    }
                });
            }
        }
    }

    private extractReplyData(metaMsg: any): { id?: string; text: string } | null {
        const type = metaMsg.type;

        // 1. Interactive Button Reply
        if (type === WhatsappMessageType.INTERACTIVE && metaMsg.interactive?.type === 'button_reply') {
            const buttonReply = metaMsg.interactive.button_reply;
            return { id: buttonReply.id, text: buttonReply.title };
        }

        // 2. Quick Reply Button (from templates)
        if (type === WhatsappMessageType.BUTTON && metaMsg.button?.text) {
            return { id: metaMsg.button.payload || null, text: metaMsg.button.text };
        }

        // 3. Interactive List Reply
        if (type === WhatsappMessageType.INTERACTIVE && metaMsg.interactive?.type === 'list_reply') {
            const listReply = metaMsg.interactive.list_reply;
            return { id: listReply.id, text: listReply.title };
        }

        return null;
    }

    private async handleStatuses(value: any, account: WhatsappAccountEntity) {
        const statuses = value?.statuses || [];

        for (const statusUpdate of statuses) {
            const messageId = statusUpdate.id;
            const status = statusUpdate.status as MessageStatus;
            const timestamp = statusUpdate.timestamp;
            const date = new Date(parseInt(timestamp) * 1000);

            const message = await this.messageRepo.findOne({ where: { messageId } });
            if (!message) {
                this.logger.warn(`Received status update for unknown message: ${messageId}`);
                continue;
            }

            message.metaTimestamp = parseInt(timestamp);

            // Update Metadata (Pricing, Conversation, etc.)
            message.metadata = {
                ...(message.metadata || {}),
                conversation: statusUpdate.conversation,
                pricing: statusUpdate.pricing,
                biz_opaque_callback_data: statusUpdate.biz_opaque_callback_data,
                recipient_id: statusUpdate.recipient_id
            };

            if (status === MessageStatus.SENT) {
                message.status = status;
                message.sentAt = date;
            } else if (status === MessageStatus.DELIVERED) {
                message.deliveredAt = date;
                message.status = MessageStatus.DELIVERED;
            } else if (status === MessageStatus.READ) {
                message.status = status;
                message.readAt = date;
            } else if (status === MessageStatus.PLAYED) {
                message.status = status;
                message.playedAt = date;
            } else if (status === MessageStatus.FAILED) {
                message.status = status;
                message.failedAt = date;
                const error = statusUpdate.errors?.[0] || {};
                message.errorCode = String(error.code || '');
                message.error = error.error_data?.details || error.message || error.title || JSON.stringify(error);
            } else {
                message.status = status;
            }

            // Sync all previous messages as read if READ
            if (status === MessageStatus.READ) {
                await this.syncMessageReadStatus(message, date);
            }

            await this.messageRepo.save(message);

            // Emit notification for message status update
            this.appGateway.emitUpdateMessage(account.adminId, message);
        }
    }


    private async handleAccountAlerts(value: any, account: WhatsappAccountEntity) {
        this.logger.log("reactions event");
    }

    private async handleCalls(value: any, account: WhatsappAccountEntity) {
        this.logger.log("calls event");
    }

    private async handleConsumerProfile(value: any, account: WhatsappAccountEntity) {
        this.logger.log("consumer_profile event");
    }

    private async handleMessagingHandovers(value: any, account: WhatsappAccountEntity) {
        this.logger.log("messaging_handovers event");
    }

    private async handleGroupLifecycleUpdate(value: any, account: WhatsappAccountEntity) {
        this.logger.log("group_lifecycle_update event");
    }

    private async handleGroupParticipantsUpdate(value: any, account: WhatsappAccountEntity) {
        this.logger.log("group_participants_update event");
    }

    private async handleGroupSettingsUpdate(value: any, account: WhatsappAccountEntity) {
        this.logger.log("group_settings_update event");
    }

    private async handleGroupStatusUpdate(value: any, account: WhatsappAccountEntity) {
        this.logger.log("group_status_update event");
    }

    private async handleSmbMessageEchoes(value: any, account: WhatsappAccountEntity) {
        this.logger.log("smb_message_echoes event");
    }

    private async handleSmbAppStateSync(value: any, account: WhatsappAccountEntity) {
        this.logger.log("smb_app_state_sync event");
    }

    private async handleHistory(value: any, account: WhatsappAccountEntity) {
        this.logger.log("history event");
    }

    private async handleAccountSettingsUpdate(value: any, account: WhatsappAccountEntity) {
        this.logger.log("account_settings_update event");
    }

    private async handleTemplateComponentsUpdate(value: any, account: WhatsappAccountEntity) {
        this.logger.log(
            "message_template_components_update event",
        );
    }

    private async handleTemplateCategoryUpdate(value: any, account: WhatsappAccountEntity) {
        this.logger.log(
            "template_category_update event",
        );
    }

    private async handleAccountUpdate(value: any, account: WhatsappAccountEntity) {
        this.logger.log("account_update event");
    }

    private async handleAccountReviewUpdate(value: any, account: WhatsappAccountEntity) {
        this.logger.log("account_review_update event");
    }

    async retryMessage(me: any, messageId: string) {
        const adminId = me.adminId || me.id;
        const message = await this.messageRepo.findOne({
            where: { messageId, adminId },
            relations: ['account']
        });

        if (!message) throw new NotFoundException('Message not found');
        if (message.direction !== MessageDirection.OUTBOUND) throw new BadRequestException('Can only retry outbound messages');

        // Increment retry count
        message.retryCount = (message.retryCount || 0) + 1;
        await this.messageRepo.save(message);

        // Re-send using the original content
        return this.sendMessage(me, message.content, message.accountId);
    }

    async findAllMessages(me: any, q?: any) {
        const adminId = me.adminId || me.id; // Basic tenant resolving
        if (!adminId) throw new BadRequestException("Missing adminId");

        const limit = Number(q?.limit ?? 50);
        const search = String(q?.search ?? "").trim();
        const sortBy = String(q?.sortBy ?? "createdAt");
        const sortDir: "ASC" | "DESC" =
            String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

        const cursor = q?.cursor;

        const { finalStartDate, finalEndDate } = this.getDashboardDateRange(q || {});

        const qb = this.messageRepo
            .createQueryBuilder("message")
            .leftJoinAndSelect('message.account', 'account')
            .leftJoinAndSelect('message.replyTo', 'replyTo')
            .leftJoinAndSelect('message.reactions', 'reactions', 'reactions.id IN (' +
                'SELECT r.id FROM whatsapp_messages r ' +
                'WHERE r."reactionToId" = message.id ' +
                'AND r.direction = \'inbound\' ' +
                'ORDER BY r."createdAt" DESC LIMIT 1' +
                ') OR reactions.id IN (' +
                'SELECT r.id FROM whatsapp_messages r ' +
                'WHERE r."reactionToId" = message.id ' +
                'AND r.direction = \'outbound\' ' +
                'ORDER BY r."createdAt" DESC LIMIT 1' +
                ')')
            .where("message.adminId = :adminId", { adminId })
            .andWhere("message.messageType != :reactionType", { reactionType: WhatsappMessageType.REACTION })
            .andWhere("COALESCE(message.sentAt, message.createdAt) >= :finalStartDate", { finalStartDate })
            .andWhere("COALESCE(message.sentAt, message.createdAt) <= :finalEndDate", { finalEndDate });

        // Filters
        if (q?.status) {
            qb.andWhere("message.status = :status", { status: q.status });
        }

        if (q?.accountId) {
            qb.andWhere("message.accountId = :accountId", { accountId: q.accountId });
        }

        if (q?.conversationId) {
            qb.andWhere("message.conversationId = :conversationId", { conversationId: q.conversationId });
        }

        if (q?.direction) {
            qb.andWhere("message.direction = :direction", { direction: q.direction });
        }

        // Search (by contactNumber, messageId, or body text)
        if (search) {
            qb.andWhere(
                new Brackets((sq) => {
                    sq.where("message.contactNumber ILIKE :s", { s: `%${search}%` })
                        .orWhere("message.messageId ILIKE :s", { s: `%${search}%` })
                        .orWhere("message.content->'text'->>'body' ILIKE :s", { s: `%${search}%` });
                }),
            );
        }

        // Sorting
        const sortColumns: Record<string, string> = {
            createdAt: "message.createdAt",
            status: "message.status",
        };

        const sortCol = sortColumns[sortBy] || "message.createdAt";

        if (cursor) {
            const operator = sortDir === "DESC" ? "<" : ">";

            qb.andWhere(
                `(${sortCol}, message.id) ${operator} (:cursorValue, :cursorId)`,
                {
                    cursorValue: cursor.value,
                    cursorId: cursor.id,
                },
            );
        }

        qb.orderBy(sortCol, sortDir);
        qb.addOrderBy("message.id", sortDir);

        const recordsWithExtra = await qb.take(limit + 1).getMany();
        const hasMore = recordsWithExtra.length > limit;
        const records = hasMore ? recordsWithExtra.slice(0, limit) : recordsWithExtra;

        return {
            records,
            hasMore,
            limit,
            nextCursor: hasMore ? { "value": records?.[records.length - 1]?.[sortBy], "id": records?.[records.length - 1]?.id } : undefined,
            sortBy,
            sortDir,
        };
    }

    async findOneMessage(me: any, id: string) {
        const adminId = me.adminId || me.id;

        const message = await this.messageRepo.findOne({
            where: { id, adminId },
            relations: ['account']
        });

        if (!message) {
            throw new NotFoundException("WhatsApp message not found");
        }

        return message;
    }

    async handleEmbeddedSignup(me: any, payload: EmbeddedSignupDto) {
        this.logger.log(`handleEmbeddedSignup: ${JSON.stringify(payload)}`);
        const adminId = me.adminId || me.id;
        if (!adminId) throw new BadRequestException("Missing adminId");

        const { code, wabaId, phoneNumberId, businessId } = payload;

        try {
            // 1. Exchange code for permanent token
            this.appGateway.emitWhatsappSignupStatus(adminId, { step: 'EXCHANGING_TOKEN', status: 'in_progress' });
            const tokenResponse = await this.whatsappApi.exchangeCodeForToken(code);
            const accessToken = tokenResponse.access_token;
            this.appGateway.emitWhatsappSignupStatus(adminId, { step: 'EXCHANGING_TOKEN', status: 'completed' });

            // 2. Fetch Phone Number details
            this.appGateway.emitWhatsappSignupStatus(adminId, { step: 'FETCHING_PHONE_DATA', status: 'in_progress' });
            const phoneNumbers = await this.whatsappApi.fetchWabaPhoneNumbers(wabaId, accessToken);
            const phoneData = phoneNumbers.data.find(p => p.id === phoneNumberId);

            if (!phoneData) {
                throw new BadRequestException("Phone number ID not found in WABA");
            }
            this.appGateway.emitWhatsappSignupStatus(adminId, { step: 'FETCHING_PHONE_DATA', status: 'completed' });

            // 3. Check if account already exists
            const existing = await this.accountRepo.findOne({
                where: [
                    { wabaId, adminId },
                    { phoneNumberId, adminId }
                ]
            });
            if (existing) {
                throw new BadRequestException("WhatsApp account already integrated");
            }

            // 4. Subscribe App to WABA
            this.appGateway.emitWhatsappSignupStatus(adminId, { step: 'SUBSCRIBING_APP', status: 'in_progress' });
            await this.whatsappApi.subscribeAppToWaba(wabaId, accessToken);
            this.appGateway.emitWhatsappSignupStatus(adminId, { step: 'SUBSCRIBING_APP', status: 'completed' });

            // 5. Register Phone Number
            this.appGateway.emitWhatsappSignupStatus(adminId, { step: 'REGISTERING_PHONE', status: 'in_progress' });
            const pin = Math.floor(100000 + Math.random() * 900000).toString();
            await this.whatsappApi.registerPhoneNumber(phoneNumberId, accessToken, pin);
            this.appGateway.emitWhatsappSignupStatus(adminId, { step: 'REGISTERING_PHONE', status: 'completed' });

            // 6. Create Account Record (Outside step 7 manager)
            this.appGateway.emitWhatsappSignupStatus(adminId, { step: 'CREATING_ACCOUNT', status: 'in_progress' });
            const account = this.accountRepo.create({
                adminId,
                name: phoneData.verified_name || phoneData.display_phone_number,
                wabaId,
                phoneNumberId,
                businessId,
                accessToken,
                mobileNumber: phoneData.display_phone_number,
                isActive: true,
            });
            const savedAccount = await this.accountRepo.save(account);
            this.appGateway.emitWhatsappSignupStatus(adminId, { step: 'CREATING_ACCOUNT', status: 'completed' });

            // 7. Sync Templates (Using transaction manager only here)
            this.appGateway.emitWhatsappSignupStatus(adminId, { step: 'SYNCING_TEMPLATES', status: 'in_progress' });
            try {
                await this.accountRepo.manager.transaction(async (manager) => {
                    await this.templateService.syncTemplatesFromMeta(
                        adminId,
                        savedAccount.id,
                        wabaId,
                        accessToken,
                        manager
                    );
                });
                this.appGateway.emitWhatsappSignupStatus(adminId, { step: 'SYNCING_TEMPLATES', status: 'completed' });
                this.appGateway.emitWhatsappSignupStatus(adminId, { step: 'COMPLETED', status: 'completed' });
            } catch (tplError) {
                this.logger.error(`Failed to sync templates during signup: ${tplError.message}`, tplError.stack);
                this.appGateway.emitWhatsappSignupStatus(adminId, {
                    step: 'SYNCING_TEMPLATES',
                    status: 'warning',
                    message: 'Account integrated but failed to sync templates. You can sync them manually later.',
                    error: getErrorMessage(tplError)
                });
            }

            return savedAccount;
        } catch (e) {
            this.logger.error(`Failed to handle embedded signup: ${e.message}`, e.stack);
            this.appGateway.emitWhatsappSignupStatus(adminId, {
                step: 'FAILED',
                status: 'failed',
                error: getErrorMessage(e)
            });
            throw new BadRequestException(getErrorMessage(e));
        }
    }

    async syncTemplates(me: any, accountId: string) {
        const adminId = me.adminId || me.id;
        if (!adminId) throw new BadRequestException("Missing adminId");

        const account = await this.accountRepo.findOne({
            where: { id: accountId, adminId },
            select: {
                accessToken: true,
                id: true,
                wabaId: true,
                phoneNumberId: true
            }
        });

        if (!account) {
            throw new NotFoundException("WhatsApp account not found");
        }

        try {
            this.appGateway.emitWhatsappSignupStatus(adminId, { step: 'SYNCING_TEMPLATES', status: 'in_progress' });

            await this.templateService.syncTemplatesFromMeta(
                adminId,
                account.id,
                account.wabaId,
                account.accessToken
            );

            this.appGateway.emitWhatsappSignupStatus(adminId, { step: 'SYNCING_TEMPLATES', status: 'completed' });
            this.appGateway.emitWhatsappSignupStatus(adminId, { step: 'COMPLETED', status: 'completed' });

            return { success: true };
        } catch (e) {
            this.logger.error(`Failed to sync templates for account ${accountId}: ${e.message}`, e.stack);
            this.appGateway.emitWhatsappSignupStatus(adminId, {
                step: 'SYNCING_TEMPLATES',
                status: 'failed',
            });
            this.appGateway.emitWhatsappSignupStatus(adminId, {
                step: 'FAILED',
                status: 'failed',
                error: getErrorMessage(e)
            });
            throw new BadRequestException(getErrorMessage(e));
        }
    }
}
