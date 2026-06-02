import { BadRequestException, forwardRef, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as crypto from "crypto";
import { WhatsappApiService, WhatsappMessageResponsePayload, WhatsappSendMessagePayload, WhatsappUploadMediaPayload } from './services/WhatsappApi.service';
import { EmbeddedSignupDto } from 'dto/whatsapp.dto';
import { ConversationEntity, ConversationStatus, MessageDirection, MessageStatus, WebhookEventStatus, WebhookEventType, WhatsappAccountEntity, WhatsappMessageEntity, WhatsappMessageType, WhatsappTemplateEntity, WhatsappWebhookEventEntity } from 'entities/whatsapp.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository, Not, LessThanOrEqual, In } from 'typeorm';
import { WhatsappTemplateService } from './services/WhatsappTemplate.service';
import { getErrorMessage } from 'common/healpers';
import { FlowExecutionQueueService } from 'src/automation/engine/triggerDispatcher.service';
import { OrdersService } from 'src/orders/services/orders.service';
import { normalizeEgyptianPhoneNumber } from 'common/whatsapp';
import { ConversationService } from 'src/conversation/conversation.service';
import { CustomerService } from 'src/customer/customer.service';
import { CustomerEntity } from 'entities/customers.entity';
import { AppGateway } from 'common/app.gateway';


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
    ) {

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

        const resolvedAccountId = await this.getDefaultAccountId(adminId, accountId);

        return this.whatsappApi.uploadMessageMedia(resolvedAccountId, payload);
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
        // this.validateSignature(rawBody, signature);

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
            .andWhere("message.messageType != :reactionType", { reactionType: WhatsappMessageType.REACTION });

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
