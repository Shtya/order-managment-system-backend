import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as crypto from "crypto";
import { WhatsappApiService } from './services/WhatsappApi.service';
import { WhatsappAccountEntity } from 'entities/whatsapp.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WhatsappTemplateService } from './services/WhatsappTemplate.service';

@Injectable()
export class WhatsappService {
     protected readonly logger = new Logger(this.constructor.name);
    constructor(
        private readonly whatsappApi: WhatsappApiService,
        @InjectRepository(WhatsappAccountEntity)
        private readonly accountRepo: Repository<WhatsappAccountEntity>,

        private readonly templateService: WhatsappTemplateService,
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
                const field = change?.field;
                const value = change?.value;
                try {
                    switch (field) {

                        case "account_alerts":
                            await this.handleAccountAlerts(value, account)
                            break;
                        case "messages":
                            await this.handleMessages(value, account)
                            break;
                        case "statuses":
                            await this.handleStatuses(value, account)
                            break;
                        case "message_echoes":
                            await this.handleMessageEchoes(value, account)
                            break;
                        case "calls":
                            await this.handleCalls(value, account)
                            break;
                        case "consumer_profile":
                            await this.handleConsumerProfile(value, account)
                            break;
                        case "messaging_handovers":
                            await this.handleMessagingHandovers(value, account)
                            break;
                        case "group_lifecycle_update":
                            await this.handleGroupLifecycleUpdate(value, account)
                            break;
                        case "group_participants_update":
                            await this.handleGroupParticipantsUpdate(value, account)
                            break;
                        case "group_settings_update":
                            await this.handleGroupSettingsUpdate(value, account)
                            break;
                        case "group_status_update":
                            await this.handleGroupStatusUpdate(value, account)
                            break;
                        case "smb_message_echoes":
                            await this.handleSmbMessageEchoes(value, account)
                            break;
                        case "smb_app_state_sync":
                            await this.handleSmbAppStateSync(value, account)
                            break;
                        case "history":
                            await this.handleHistory(value, account)
                            break;
                        case "account_settings_update":
                            await this.handleAccountSettingsUpdate(value, account)
                            break;
                        case "message_template_status_update":
                            await this.handleTemplateStatusUpdate(value, account)
                            break;
                        case "message_template_quality_update":
                            await this.handleTemplateQualityUpdate(value, account)
                            break;
                        case "message_template_components_update":
                            await this.handleTemplateComponentsUpdate(value, account)
                            break;
                        case "template_category_update":
                            await this.handleTemplateCategoryUpdate(value, account)
                            break;
                        case "account_update":
                            await this.handleAccountUpdate(value, account)
                            break;
                        case "account_review_update":
                        case "account_alerts":
                        default:
                            this.logger.warn(
                                `Unhandled webhook field: ${field}`,
                            );
                    }
                } catch (error) {
                    this.logger.error(
                        `Error processing webhook field: ${field}`,
                        error,
                    );
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

    private async handleAccountAlerts(value: any, account: WhatsappAccountEntity) {
        this.logger.log("account_alerts event");
    }

    private async handleMessages(value: any, account: WhatsappAccountEntity) {
        this.logger.log("messages event");
    }

    private async handleStatuses(value: any, account: WhatsappAccountEntity) {
        this.logger.log("statuses event");
    }

    private async handleMessageEchoes(value: any, account: WhatsappAccountEntity) {
        this.logger.log("message_echoes event");
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


}
