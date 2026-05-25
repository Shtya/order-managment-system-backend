import { BadRequestException, forwardRef, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as crypto from "crypto";
import { WhatsappApiService } from './services/WhatsappApi.service';
import { MessageDirection, MessageStatus, WebhookEventStatus, WebhookEventType, WhatsappAccountEntity, WhatsappMessageEntity, WhatsappMessageType, WhatsappWebhookEventEntity } from 'entities/whatsapp.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { WhatsappTemplateService } from './services/WhatsappTemplate.service';
import { getErrorMessage } from 'common/healpers';
import { FlowExecutionQueueService } from 'src/automation/engine/triggerDispatcher.service';

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

        private readonly templateService: WhatsappTemplateService,
        private readonly flowQueue: FlowExecutionQueueService,
    ) {

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
        body: any,
        signatureHeader?: string,
    ) {
        if (!signatureHeader) {
            throw new BadRequestException(
                "Missing X-Hub-Signature-256 header",
            );
        }

        const appSecret = process.env.META_APP_SECRET;

        if (!appSecret) {
            throw new Error("META_APP_SECRET is not configured");
        }

        // header format:
        // sha256=abc123...
        const receivedSignature =
            signatureHeader.replace("sha256=", "");

        // IMPORTANT:
        // Meta signs RAW request body
        const payload =
            typeof body === "string"
                ? body
                : JSON.stringify(body);

        const expectedSignature = crypto
            .createHmac("sha256", appSecret)
            .update(payload)
            .digest("hex");

        const isValid = crypto.timingSafeEqual(
            Buffer.from(receivedSignature),
            Buffer.from(expectedSignature),
        );

        if (!isValid) {
            throw new BadRequestException(
                "Invalid webhook signature",
            );
        }

        return true;
    }

    //Unacknowledged responses will be dropped after 7 days.
    async handleEvents(
        body: any,
        headers: Record<string, string>,
    ) {
        // Header can arrive lowercase in Node/Nest
        const signature =
            headers["x-hub-signature-256"] ||
            headers["X-Hub-Signature-256"];

        // Step 1: Validate request
        this.validateSignature(body, signature);

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
            const messageId = metaMsg.id;
            const from = metaMsg.from;
            const type = metaMsg.type as WhatsappMessageType;

            const existing = await this.messageRepo.findOne({ where: { messageId } });
            if (existing) continue;

            const message = this.messageRepo.create({
                adminId: account.adminId,
                accountId: account.id,
                messageId,
                contactNumber: from,
                direction: MessageDirection.INBOUND,
                status: MessageStatus.RECEIVED,
                messageType: type,
                content: metaMsg,
            });

            await this.messageRepo.save(message);

            if (type === WhatsappMessageType.INTERACTIVE && metaMsg.interactive?.type === 'button_reply') {
                const originalMessageId = metaMsg.context?.id;
                const buttonReply = metaMsg.interactive.button_reply;

                if (originalMessageId) {

                    // Push resume job to queue instead of direct execution
                    await this.flowQueue.add({
                        type: 'resume',
                        adminId: account.adminId,
                        resumeData: {
                            originalMessageId,
                            buttonText: buttonReply.title,
                            buttonId: buttonReply.id
                        }
                    });
                }
            }
        }
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

            message.status = status;
            if (status === MessageStatus.DELIVERED) {
                message.deliveredAt = date;
            } else if (status === MessageStatus.READ) {
                message.readAt = date;
            } else if (status === MessageStatus.FAILED) {
                message.error = JSON.stringify(statusUpdate.errors || statusUpdate);
            } else if (status === MessageStatus.SENT) {
                message.sentAt = date;
            }

            await this.messageRepo.save(message);
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

    async findAllMessages(me: any, q?: any) {
        const adminId = me.adminId || me.id; // Basic tenant resolving
        if (!adminId) throw new BadRequestException("Missing adminId");

        const page = Number(q?.page ?? 1);
        const limit = Number(q?.limit ?? 10);
        const search = String(q?.search ?? "").trim();
        const sortBy = String(q?.sortBy ?? "createdAt");
        const sortDir: "ASC" | "DESC" =
            String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

        const qb = this.messageRepo
            .createQueryBuilder("message")
            .leftJoinAndSelect('message.account', 'account')
            .where("message.adminId = :adminId", { adminId });

        // Filters
        if (q?.status) {
            qb.andWhere("message.status = :status", { status: q.status });
        }

        if (q?.accountId) {
            qb.andWhere("message.accountId = :accountId", { accountId: q.accountId });
        }

        if (q?.direction) {
            qb.andWhere("message.direction = :direction", { direction: q.direction });
        }

        // Search (by contactNumber or messageId)
        if (search) {
            qb.andWhere(
                new Brackets((sq) => {
                    sq.where("message.contactNumber ILIKE :s", { s: `%${search}%` })
                        .orWhere("message.messageId ILIKE :s", { s: `%${search}%` });
                }),
            );
        }

        // Sorting
        const sortColumns: Record<string, string> = {
            createdAt: "message.createdAt",
            status: "message.status",
        };

        if (sortColumns[sortBy]) {
            qb.orderBy(sortColumns[sortBy], sortDir);
        } else {
            qb.orderBy("message.createdAt", "DESC");
        }

        const total = await qb.getCount();
        const records = await qb
            .skip((page - 1) * limit)
            .take(limit)
            .getMany();

        return {
            total_records: total,
            current_page: page,
            per_page: limit,
            records,
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
}
