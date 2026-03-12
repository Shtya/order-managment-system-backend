import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import * as crypto from 'crypto';
import { CheckoutOptions, CheckoutResponse, ParsedRedirectData, ParsedWebhookData, PaymentProvider, PaymentProviderEnum, PaymentSessionEntity, PaymentSessionResponse, PaymentSessionStatusEnum } from 'entities/payments.entity';
import { User } from 'entities/user.entity';
import { Repository } from 'typeorm';
import queryString from 'query-string';

@Injectable()
export class KashierProvider extends PaymentProvider {
    private readonly logger = new Logger(KashierProvider.name);
    providerName = PaymentProviderEnum.KASHIER;

    private baseUrl: string;
    private mode: string;
    private apiKey: string;
    private secretKey: string;
    private merchantId: string;

    constructor(
        private readonly configService: ConfigService,
        @InjectRepository(PaymentSessionEntity) private sessionRepo: Repository<PaymentSessionEntity>,
        @InjectRepository(User) private readonly userRepo: Repository<User>,) {
        super();

        const config = this.configService.get('kashier');

        this.baseUrl = config.baseUrl;
        this.mode = config.mode;
        this.apiKey = config.apiKey;
        this.secretKey = config.secretKey;
        this.merchantId = config.merchantId;
    }

    async checkout(options: CheckoutOptions): Promise<CheckoutResponse> {

        const manager = options.manager;
        const user = await manager.findOneBy(User, { id: options.userId });
        if (!user) {
            throw new NotFoundException(`User with ID ${options.userId} not found`);
        }

        const expireMinutes = Number(process.env.PAYMENT_EXPIRE_MINUTES) || 30;
        const maxAttempts = Number(process.env.PAYMENT_MAX_FAILURE_ATTEMPTS) || 3;

        // Create Date object for DB
        const expireAtDate = new Date(Date.now() + expireMinutes * 60 * 1000);

        const session = manager.create(PaymentSessionEntity, {
            provider: PaymentProviderEnum.KASHIER,
            userId: user.id,
            purpose: options.purpose,
            amount: options.amount,
            currency: options.currency.trim().toUpperCase(),
            subscriptionId: options.subscriptionId ? options.subscriptionId : null,
            userFeatureId: options.userFeatureId ? options.userFeatureId : null,
            expireAt: expireAtDate, // Saved as timestamptz in DB
        });

        const savedSession = await manager.save(session);
        const backendDomain = process.env.BACKEND_URL?.trim();
        const payload = {
            expireAt: savedSession.expireAt.toISOString(),
            maxFailureAttempts: maxAttempts,
            amount: options.amount?.toString(),
            currency: options.currency,
            merchantOrderId: savedSession.id?.toString(),
            merchantId: this.merchantId,
            merchantRedirect: `${backendDomain}/payments/redirect/kashier`,
            serverWebhook: `${backendDomain}/payments/webhook/kashier`,
            failureRedirect: true,
            type: 'external',
            display: 'ar',
            customer: {
                email: user.email,
                reference: user.id?.toString(),
            }

        }
        try {
            // 3. Call Kashier API
            const { data } = await axios.post(`${this.baseUrl}`, payload, {
                headers: {
                    'Authorization': this.secretKey,
                    'api-key': this.apiKey,
                    'Content-Type': 'application/json'
                },
            });

            // 4. Update session with URL if provided by Kashier
            const sessionId = data?._id || ''; // This is the external session ID
            const checkoutUrl = data?.sessionUrl || '';
            if (checkoutUrl) {
                await manager.update(PaymentSessionEntity, savedSession.id, {
                    checkoutUrl,
                    externalSessionId: sessionId
                });
            }

            return { checkoutUrl, sessionId };

        } catch (error) {
            // Log error and update session status to failed
            await this.sessionRepo.update(savedSession.id, {
                metadata: { error: error.response?.data || error.message },
                status: PaymentSessionStatusEnum.FAILED
            });
            throw error;
        }

    }

    verifyWebhookSignature(headers: any, payload: any): boolean {
        const { data, event } = payload;
        const signature = headers['x-kashier-signature']?.trim();
        if (!signature || !data?.signatureKeys || !this.apiKey) return false;

        const sortedKeys = [...data.signatureKeys].sort();
        const objectSignaturePayload: Record<string, any> = {};
        for (const key of sortedKeys) {
            objectSignaturePayload[key] = data[key];
        }

        const signaturePayload = queryString.stringify(objectSignaturePayload);
        const generatedSignature = crypto
            .createHmac('sha256', this.apiKey)
            .update(signaturePayload)
            .digest('hex');

        return signature === generatedSignature;
    }

    parseRedirectQuery(query: any): ParsedRedirectData {
        // Extract raw status from query
        const rawStatus = query.paymentStatus?.trim()?.toUpperCase() || '';

        const status = this.mapProviderStatus(rawStatus);

        return {
            status,
            sessionId: query.merchantOrderId?.trim() || '',
        };
    }

    mapProviderStatus(rawStatus: any): PaymentSessionStatusEnum {
        switch (rawStatus) {
            case 'SUCCESS': return PaymentSessionStatusEnum.SUCCESS;
            case 'FAILED': return PaymentSessionStatusEnum.FAILED;
            case 'CANCELLED': return PaymentSessionStatusEnum.CANCELLED;
            case 'EXPIRED': return PaymentSessionStatusEnum.EXPIRED;
            default: return PaymentSessionStatusEnum.FAILED;
        }
    }

    parseWebhookPayload(payload: any): ParsedWebhookData {
        const { data } = payload;
        const rawStatus = data?.status?.trim()?.toUpperCase() || '';

        return {
            externalTransactionId: (data?.transactionId || data?.kashierOrderId)?.trim(),
            internalSessionId: data?.merchantOrderId?.trim(),
            status: this.mapProviderStatus(rawStatus),
            paymentMethod: data?.method?.trim()?.toLowerCase(),
            rawStatus
        };
    }
}