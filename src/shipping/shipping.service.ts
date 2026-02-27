// --- File: backend/src/shipping/shipping.service.ts ---
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as crypto from 'crypto';


import {
	ShipmentEntity,
	ShipmentEventEntity,
	ShipmentStatus,
	ShippingCompanyEntity,
	ShippingIntegrationEntity,
	UnifiedShippingStatus,
} from '../../entities/shipping.entity';

import { AssignOrderDto, CreateShipmentDto } from './shipping.dto';
import { ShippingProvider } from './providers/shipping-provider.interface';
import { BostaProvider } from './providers/bosta.provider';
import { JtProvider } from './providers/jt.provider';
import { TurboProvider } from './providers/turbo.provider';
import { tenantId } from 'src/category/category.service';
import { OrderEntity, OrderReplacementEntity } from 'entities/order.entity';
import { ProductVariantEntity } from 'entities/sku.entity';

@Injectable()
export class ShippingService {
	private providers: Record<string, ShippingProvider>;

	constructor(
		private bostaProvider: BostaProvider,
		private jtProvider: JtProvider,
		private turboProvider: TurboProvider,
		private dataSource: DataSource,
		@InjectRepository(ShippingCompanyEntity)
		private companiesRepo: Repository<ShippingCompanyEntity>,

		@InjectRepository(OrderEntity)
		private ordersRepo: Repository<OrderEntity>,

		@InjectRepository(ShippingIntegrationEntity)
		private integrationsRepo: Repository<ShippingIntegrationEntity>,

		@InjectRepository(ShipmentEntity)
		private shipmentsRepo: Repository<ShipmentEntity>,

		@InjectRepository(ShipmentEventEntity)
		private eventsRepo: Repository<ShipmentEventEntity>,
	) {
		this.providers = {
			bosta: this.bostaProvider,
			jt: this.jtProvider,
			turbo: this.turboProvider,
		};
	}


	// backend/src/shipping/shipping.service.ts
	async getIntegrationsStatus(adminId: string) {
		// ✅ GLOBAL companies
		const companies = await this.companiesRepo.find({ order: { id: "ASC" as any } });

		// per-admin integrations
		const integrations = await this.integrationsRepo.find({ where: { adminId } });

		const integByCompanyId = new Map<number, ShippingIntegrationEntity>();
		for (const integ of integrations) integByCompanyId.set(integ.shippingCompanyId, integ);

		const result = companies.map((company) => {
			const integ = integByCompanyId.get(company.id);
			return {
				provider: company.code,
				name: company.name,
				isActive: integ?.isActive ?? false,
				credentialsConfigured: !!(integ?.credentials?.apiKey),
				credentials: this.maskCredentials(integ?.credentials),
				// optional UI info if you want to return it here
				logo: company.logo,
				website: company.website,
				bg: company.bg,
				description: company.description,
			};
		});

		return { ok: true, integrations: result };
	}

	async activeIntegrations(user: any) {
		const adminId = tenantId(user)
		const integrations = await this.integrationsRepo.find({
			where: {
				adminId,
				isActive: true
			},
			relations: ['shippingCompany'] // Ensure we have company details like code/name
		});

		// 3. Filter and format the result
		// We only return those that actually have an API key configured
		const result = integrations
			.filter(integ => !!integ.credentials?.apiKey)
			.map((integ) => ({
				id: integ.id,
				provider: integ.shippingCompany.code,
				providerId: integ.shippingCompany.id,
				name: integ.shippingCompany.name,
				logo: integ.shippingCompany.logo,
			}));

		return {
			ok: true,
			integrations: result
		};
	}

	private maskCredentials(credentials: any) {
		if (!credentials) return null;

		const masked = { ...credentials };
		const sensitiveKeys = ['apiKey'];

		sensitiveKeys.forEach((key) => {
			const value = masked[key];
			if (value && typeof value === 'string') {
				masked[key] = value.length > 8
					? `${value.substring(0, 4)}****************${value.slice(-4)}`
					: "****************";
			}
		});

		return masked;
	}


	listProviders() {
		return {
			ok: true,
			providers: Object.values(this.providers).map((p) => ({
				code: p.code,
				name: p.displayName,
			})),
		};
	}

	private getProvider(provider: string): ShippingProvider {
		const key = (provider || '').toLowerCase().trim();
		const p = this.providers[key];
		if (!p) throw new BadRequestException(`Unsupported shipping provider: ${provider}`);
		return p;
	}

	private async getCompanyByProviderForAdmin(_adminId: string, provider: string) {

		const company = await this.companiesRepo.findOne({ where: { code: provider } });
		if (!company) throw new BadRequestException(`Company record not found for provider "${provider}"`);
		return company;
	}


	private async getOrCreateIntegration(adminId: string, companyId: number) {
		let integ = await this.integrationsRepo.findOne({ where: { adminId, shippingCompanyId: companyId } });
		if (!integ) {
			integ = await this.integrationsRepo.save(
				this.integrationsRepo.create({
					adminId,
					shippingCompanyId: companyId,
					isActive: false,
					credentials: null,
				}),
			);
		}
		return integ;
	}

	private async requireApiKey(adminId: string, provider: string): Promise<{ apiKey: string; companyId: number; integId: number, integ: ShippingIntegrationEntity }> {
		const company = await this.getCompanyByProviderForAdmin(adminId, provider);
		const integ = await this.getOrCreateIntegration(adminId, company.id);

		if (!integ.isActive) throw new BadRequestException('Shipping company is disabled');

		const apiKey = integ.credentials?.apiKey;

		if (!apiKey) throw new BadRequestException('Provider credentials not configured (missing apiKey)');

		return { apiKey, companyId: company.id, integId: integ.id, integ };
	}

	private async validateProviderConnection(provider, integ: ShippingIntegrationEntity): Promise<void> {
		const p = this.getProvider(provider);

		const accountId = integ?.credentials?.accountId ? String(integ?.credentials?.accountId).trim() : (integ?.credentials?.accountId || undefined)
		const apiKey = integ?.credentials?.apiKey;

		const isValid = await p.verifyCredentials(apiKey, accountId);
		if (!isValid) {
			throw new BadRequestException(
				`Unable to validate the integration to ${p.displayName}. This could be due to an invalid API key, or incorrect provider settings.`
			);
		}


	}

	async setCredentials(adminId: string, provider: string, credentials: any) {
		const company = await this.getCompanyByProviderForAdmin(adminId, provider);
		console.log(credentials);
		const integ = await this.getOrCreateIntegration(adminId, company.id);

		const next = {
			...(integ.credentials || {}),
			apiKey: credentials.apiKey ? String(credentials.apiKey).trim() : (integ.credentials?.apiKey || undefined),
			accountId: credentials.accountId ? String(credentials.accountId).trim() : (integ.credentials?.accountId || undefined),

			// optional webhook config persistence
			webhookHeaderName: credentials.webhookHeaderName ? String(credentials.webhookHeaderName).trim() : (integ.credentials?.webhookHeaderName || undefined),
			webhookSecret: credentials.webhookSecret ? String(credentials.webhookSecret).trim() : (integ.credentials?.webhookSecret || undefined),
		};

		if (!next.apiKey) throw new BadRequestException('Missing apiKey');

		await this.dataSource.transaction(async (manager) => {

			integ.credentials = next;
			integ.isActive = true;

			await manager.save(integ);


			await this.validateProviderConnection(provider, integ);

		});

		return {
			ok: true,
			provider,
			isActive: integ.isActive,
			credentialsConfigured: true,
		};
	}

	async setActive(adminId: string, provider: string, isActive: boolean) {
		const company = await this.getCompanyByProviderForAdmin(adminId, provider);
		const p = this.getProvider(provider);
		const integ = await this.getOrCreateIntegration(adminId, company.id);

		if (isActive) {
			const apiKey = integ.credentials?.apiKey;
			if (!apiKey) {
				throw new BadRequestException(`Cannot activate: No API key found for ${provider}.`);
			}


			await this.validateProviderConnection(provider, integ);

		}
		integ.isActive = isActive;
		await this.integrationsRepo.save(integ);
		return { ok: true, provider, isActive };
	}

	async getServices(adminId: string, provider: string) {
		const p = this.getProvider(provider);
		const { apiKey } = await this.requireApiKey(adminId, provider);

		const services = await p.getServices(apiKey);
		return { ok: true, provider: p.code, services };
	}

	async getCapabilities(adminId: string, provider: string) {
		const p = this.getProvider(provider);
		const { apiKey } = await this.requireApiKey(adminId, provider);
		const caps = await p.getCapabilities(apiKey);
		return { ok: true, provider: p.code, capabilities: caps };
	}

	// async getAreas(adminId: string, provider: string, countryId: number) {
	// 	const p = this.getProvider(provider);
	// 	await this.requireApiKey(adminId, provider);
	// 	const areas = await p.getAreas(countryId);

	// 	return {
	// 		ok: true,
	// 		provider: p.code,
	// 		records: areas,
	// 	};
	// }

	async getCities(adminId: string, provider: string) {
		const p = this.getProvider(provider);
		const { apiKey } = await this.requireApiKey(adminId, provider);
		const cities = await p.getCities(apiKey);

		return {
			ok: true,
			provider: p.code,
			records: cities,
		};
	}

	async getDistricts(adminId: string, provider: string, cityId: string) {
		const p = this.getProvider(provider);
		const { apiKey } = await this.requireApiKey(adminId, provider);
		const districts = await p.getDistricts(apiKey, cityId);

		return {
			ok: true,
			provider: p.code,
			records: districts,
		};
	}

	async getZones(adminId: string, provider: string, cityId: string) {
		const p = this.getProvider(provider);
		const { apiKey } = await this.requireApiKey(adminId, provider);
		const zones = await p.getZones(apiKey, cityId);

		return {
			ok: true,
			provider: p.code,
			records: zones,
		};
	}

	async getPickupLocations(adminId: string, providerCode: string) {
		const provider = this.getProvider(providerCode);
		const { apiKey } = await this.requireApiKey(adminId, providerCode);

		const location = await provider.getPickupLocations(apiKey);

		return {
			ok: true,
			provider: provider,
			records: location,
		};
	}

	async createShipment(me, provider: string, dto: CreateShipmentDto, orderId: number) {
		const adminId = tenantId(me);
		const p = this.getProvider(provider);
		const { apiKey, companyId, integ } = await this.requireApiKey(adminId, provider);


		if (!orderId) {
			throw new BadRequestException("Order is required to create a shipment.");
		}
		const order = await this.ordersRepo.findOne({
			where: { id: orderId, adminId },
			relations: [
				'items',
				'items.variant',
				'items.variant.product',
				'replacementResult',

				'replacementResult.items',
				'replacementResult.items.originalOrderItem',
				'replacementResult.items.originalOrderItem.variant',
				'replacementResult.items.originalOrderItem.variant.product'
			]
		});

		if (!order) throw new BadRequestException("Order not found.");

		return await this.dataSource.transaction(async (manager) => {
			const shipment = await manager.save(
				manager.create(ShipmentEntity, {
					adminId,
					orderId: orderId,
					shippingCompanyId: companyId,
					status: ShipmentStatus.SUBMITTED,
					unifiedStatus: UnifiedShippingStatus.NEW,
				}),
			);


			const payload = p.buildDeliveryPayload(order, dto, integ)
			try {
				const res = await p.createShipment(apiKey, payload);

				shipment.trackingNumber = res.trackingNumber || null;
				shipment.providerShipmentId = res.providerShipmentId || null;

				shipment.status = ShipmentStatus.CREATED;
				shipment.unifiedStatus = UnifiedShippingStatus.IN_PROGRESS;

				shipment.providerRaw = {
					request: payload,
					response: res.providerRaw || { trackingNumber: shipment.trackingNumber, providerShipmentId: shipment.providerShipmentId },
				};

				await manager.save(shipment);


				for (const item of order.items) {
					await manager.decrement(
						ProductVariantEntity,
						{ id: item.variantId, adminId },
						"stockOnHand", // Physical deduction
						item.quantity
					);

					await manager.decrement(
						ProductVariantEntity,
						{ id: item.variantId, adminId },
						"reserved", // Remove from reservation
						item.quantity
					);
				}

				return {
					ok: true,
					shipmentId: shipment.id,
					orderId: shipment.orderId,
					provider,
					trackingNumber: shipment.trackingNumber,
					providerShipmentId: shipment.providerShipmentId,
					status: shipment.unifiedStatus,
				};
			} catch (e: any) {
				shipment.status = ShipmentStatus.FAILED;
				shipment.unifiedStatus = UnifiedShippingStatus.EXCEPTION;
				shipment.failureReason = e?.message || 'Create shipment failed';
				shipment.providerRaw = { request: payload, error: e?.response?.data || e?.message || 'unknown' };
				await manager.save(shipment);
				throw new BadRequestException(shipment.failureReason);
			}

		});
	}

	async cancelShipment(me, provider: string, shipmentId: number) {
		const adminId = tenantId(me);
		const p = this.getProvider(provider);
		const { apiKey } = await this.requireApiKey(adminId, provider);

		const shipment = await this.shipmentsRepo.findOne({
			where: { id: shipmentId, adminId },
			relations: ['order', 'order.items']
		});

		if (!shipment) throw new NotFoundException("Shipment not found.");
		if (shipment.status === ShipmentStatus.CANCELLED) {
			throw new BadRequestException("Shipment is already cancelled.");
		}

		return await this.dataSource.transaction(async (manager) => {
			try {
				const isCancelled = await p.cancelShipment(apiKey, shipment.providerShipmentId || shipment.trackingNumber);

				if (!isCancelled) {
					throw new Error("Provider refused to cancel the shipment.");
				}

				shipment.status = ShipmentStatus.CANCELLED;
				shipment.unifiedStatus = UnifiedShippingStatus.CANCELLED;
				await manager.save(shipment);

				for (const item of shipment.order.items) {
					await manager.increment(
						ProductVariantEntity,
						{ id: item.variantId, adminId },
						"stockOnHand",
						item.quantity
					);

				}

				return {
					ok: true,
					message: "Shipment cancelled successfully and stock restored.",
					shipmentId: shipment.id,
					status: shipment.unifiedStatus
				};

			} catch (e: any) {
				shipment.failureReason = e?.message || 'Cancel shipment failed';
				await manager.save(shipment);

				throw new BadRequestException(`Cancellation Failed: ${shipment.failureReason}`);
			}
		});
	}

	async assignOrder(adminId: string, provider: string, orderId: number, dto: AssignOrderDto) {
		return this.createShipment(adminId, provider, dto, orderId);
	}

	async listShipments(adminId: string) {
		const shipments = await this.shipmentsRepo.find({
			where: { adminId },
			order: { created_at: 'DESC' as any },
			take: 200,
		});

		return {
			ok: true,
			items: shipments.map((s) => ({
				id: s.id,
				orderId: s.orderId,
				companyId: s.shippingCompanyId,
				company: s.shippingCompany?.name,
				trackingNumber: s.trackingNumber,
				status: s.unifiedStatus,
				created_at: s.created_at,
			})),
		};
	}

	async getShipment(adminId: string, id: number) {
		const s = await this.shipmentsRepo.findOne({ where: { id, adminId } });
		if (!s) throw new BadRequestException('Shipment not found');

		return {
			ok: true,
			id: s.id,
			orderId: s.orderId,
			companyId: s.shippingCompanyId,
			company: s.shippingCompany?.name,
			trackingNumber: s.trackingNumber,
			providerShipmentId: s.providerShipmentId,
			status: s.unifiedStatus,
			created_at: s.created_at,
			updated_at: s.updated_at,
		};
	}

	async getShipmentEvents(adminId: string, id: number) {
		const s = await this.shipmentsRepo.findOne({ where: { id, adminId } });
		if (!s) throw new BadRequestException('Shipment not found');

		const events = await this.eventsRepo.find({
			where: { shipmentId: s.id },
			order: { created_at: 'DESC' as any },
			take: 200,
		});

		return {
			ok: true,
			shipmentId: s.id,
			events: events.map((e) => ({
				id: e.id,
				source: e.source,
				eventType: e.eventType,
				payload: e.payload,
				created_at: e.created_at,
			})),
		};
	}

	getUnifiedStatuses() {
		return { ok: true, statuses: Object.values(UnifiedShippingStatus) };
	}

	// -----------------------
	// Webhook setup helpers (NEW)
	// -----------------------
	private buildPublicWebhookUrl(provider: string) {
		const base = process.env.PUBLIC_API_BASE_URL || 'http://localhost:3000';
		return `${base.replace(/\/$/, '')}/shipping/webhooks/${provider}`;
	}

	private generateSecret() {
		return crypto.randomBytes(24).toString('hex');
	}

	async getWebhookSetup(adminId: string, provider: string) {
		const company = await this.getCompanyByProviderForAdmin(adminId, provider);
		const integ = await this.getOrCreateIntegration(adminId, company.id);

		const headerName = (integ.credentials?.webhookHeaderName || 'Authorization').trim();
		let secret = integ.credentials?.webhookSecret;

		if (!secret) {
			secret = this.generateSecret();
			integ.credentials = { ...(integ.credentials || {}), webhookHeaderName: headerName, webhookSecret: secret };
			await this.integrationsRepo.save(integ);
		}

		return {
			ok: true,
			provider,
			webhookUrl: this.buildPublicWebhookUrl(provider),
			headerName,
			headerValue: secret,
		};
	}

	async rotateWebhookSecret(adminId: string, provider: string) {
		const company = await this.getCompanyByProviderForAdmin(adminId, provider);
		const integ = await this.getOrCreateIntegration(adminId, company.id);

		const headerName = (integ.credentials?.webhookHeaderName || 'Authorization').trim();
		const secret = this.generateSecret();

		integ.credentials = { ...(integ.credentials || {}), webhookHeaderName: headerName, webhookSecret: secret };
		await this.integrationsRepo.save(integ);

		return {
			ok: true,
			provider,
			webhookUrl: this.buildPublicWebhookUrl(provider),
			headerName,
			headerValue: secret,
		};
	}

	// -----------------------
	// Webhook processing (UPDATED multi-tenant auth)
	// -----------------------
	async handleWebhook(provider: string, body: any, headers?: Record<string, any>) {
		try {


			const p = this.getProvider(provider);
			const mapped = p.mapWebhookToUnified(body);

			const shipment = await this.shipmentsRepo.findOne({
				where: mapped.providerShipmentId
					? { providerShipmentId: mapped.providerShipmentId }
					: mapped.trackingNumber
						? { trackingNumber: mapped.trackingNumber }
						: ({} as any),
				relations: ['order', 'order.items']
			});

			if (!shipment) return { ok: true, ignored: true, reason: 'shipment_not_found' };


			// Validate header per shipment.adminId + provider integration
			const company = await this.companiesRepo.findOne({ where: { code: provider } });
			if (!company) return { ok: true, ignored: true, reason: 'company_not_found' };

			const integ = await this.integrationsRepo.findOne({ where: { adminId: shipment.adminId, shippingCompanyId: company.id } });

			// If secret exists, require it
			const savedSecret = integ?.credentials?.webhookSecret;
			const customHeaderName = integ?.credentials?.webhookHeaderName; // <--- Pull from DB

			if (savedSecret) {
				// Pass the custom header name to the provider
				const isAuthed = p.verifyWebhookAuth(headers, body, savedSecret, customHeaderName);
				if (!isAuthed) {
					return { ok: true, ignored: true, reason: 'auth_failed' };
				}
			}
			// تشغيل كل شيء داخل Transaction واحدة
			await this.dataSource.transaction(async (manager) => {

				if (mapped.unifiedStatus === UnifiedShippingStatus.CANCELLED && shipment.unifiedStatus !== UnifiedShippingStatus.CANCELLED) {
					// 1. تحديث الحالات في حالة الإلغاء
					shipment.unifiedStatus = UnifiedShippingStatus.CANCELLED;
					shipment.status = ShipmentStatus.CANCELLED;

					// 2. إعادة المخزون
					for (const item of shipment.order.items) {
						await manager.increment(
							ProductVariantEntity,
							{ id: item.variantId, adminId: shipment.adminId },
							"stockOnHand",
							item.quantity
						);
					}
				} else {
					// تحديث طبيعي للحالات الأخرى
					shipment.unifiedStatus = mapped.unifiedStatus;
					shipment.status = this.mapUnifiedToLegacy(mapped.unifiedStatus);
				}

				// 3. حفظ الشحنة (سواء كانت ملغاة أو حالة أخرى)
				await manager.save(shipment);

				// 4. تسجيل الحدث (Event) داخل نفس الـ Transaction
				await manager.save(
					manager.create(ShipmentEventEntity, {
						shipmentId: shipment.id,
						source: provider as any,
						eventType: 'status_changed',
						payload: body,
					}),
				);
			});


			return { ok: true };
		} catch (e) {
			console.log(e)
		}
	}

	private mapUnifiedToLegacy(u: UnifiedShippingStatus): ShipmentStatus {
		if (u === UnifiedShippingStatus.DELIVERED) return ShipmentStatus.DELIVERED;
		if (u === UnifiedShippingStatus.CANCELLED) return ShipmentStatus.CANCELLED;

		if ([UnifiedShippingStatus.EXCEPTION, UnifiedShippingStatus.LOST, UnifiedShippingStatus.DAMAGED, UnifiedShippingStatus.TERMINATED].includes(u)) {
			return ShipmentStatus.FAILED;
		}

		if ([UnifiedShippingStatus.IN_TRANSIT, UnifiedShippingStatus.PICKED_UP, UnifiedShippingStatus.IN_PROGRESS].includes(u)) {
			return ShipmentStatus.IN_TRANSIT;
		}

		return ShipmentStatus.SUBMITTED;
	}
}
