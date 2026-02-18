// --- File: backend/src/shipping/shipping.service.ts ---
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';

import { ShippingCompanyEntity } from 'src/shipping/shipping.entity';
import {
	ShipmentEntity,
	ShipmentEventEntity,
	ShipmentStatus,
	ShippingIntegrationEntity,
	UnifiedShippingStatus,
} from './shipping.entity';

import { AssignOrderDto, CreateShipmentDto } from './shipping.dto';
import { ShippingProvider } from './providers/shipping-provider.interface';
import { BostaProvider } from './providers/bosta.provider';
import { JtProvider } from './providers/jt.provider';
import { TurboProvider } from './providers/turbo.provider';

@Injectable()
export class ShippingService {
	private providers: Record<string, ShippingProvider>;

	constructor(
		private bostaProvider: BostaProvider,
		private jtProvider: JtProvider,
		private turboProvider: TurboProvider,

		@InjectRepository(ShippingCompanyEntity)
		private companiesRepo: Repository<ShippingCompanyEntity>,

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
				// optional UI info if you want to return it here
				logo: company.logo,
				website: company.website,
				bg: company.bg,
				description: company.description,
			};
		});

		return { ok: true, integrations: result };
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
			console.log(adminId, companyId );
			integ = await this.integrationsRepo.save(
				this.integrationsRepo.create({
					adminId,
					shippingCompanyId: companyId,
					isActive: true,
					credentials: null,
				}),
			);
		}
		return integ;
	}

	private async requireApiKey(adminId: string, provider: string): Promise<{ apiKey: string; companyId: number; integId: number }> {
		const company = await this.getCompanyByProviderForAdmin(adminId, provider);
		const integ = await this.getOrCreateIntegration(adminId, company.id);

		if (!integ.isActive) throw new BadRequestException('Shipping company is disabled');

		const apiKey = integ.credentials?.apiKey;
		if (!apiKey) throw new BadRequestException('Provider credentials not configured (missing apiKey)');

		return { apiKey, companyId: company.id, integId: integ.id };
	}

	async setCredentials(adminId: string, provider: string, credentials: any) {
		const company = await this.getCompanyByProviderForAdmin(adminId, provider);
		console.log(credentials);
		const integ = await this.getOrCreateIntegration(adminId, company.id);

		const next = {
			...(integ.credentials || {}),
			apiKey: String(credentials.apiKey || '').trim(),
			accountId: credentials.accountId ? String(credentials.accountId).trim() : (integ.credentials?.accountId || undefined),

			// optional webhook config persistence
			webhookHeaderName: credentials.webhookHeaderName ? String(credentials.webhookHeaderName).trim() : (integ.credentials?.webhookHeaderName || undefined),
			webhookSecret: credentials.webhookSecret ? String(credentials.webhookSecret).trim() : (integ.credentials?.webhookSecret || undefined),
		};

		if (!next.apiKey) throw new BadRequestException('Missing apiKey');

		integ.credentials = next; 
		await this.integrationsRepo.save(integ);

		return {
			ok: true,
			provider,
			isActive: integ.isActive,
			credentialsConfigured: true,
		};
	}

	async setActive(adminId: string, provider: string, isActive: boolean) {
		const company = await this.getCompanyByProviderForAdmin(adminId, provider);
		const integ = await this.getOrCreateIntegration(adminId, company.id);
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

	async getAreas(adminId: string, provider: string, countryId: number) {
		const p = this.getProvider(provider);
		await this.requireApiKey(adminId, provider);
		const areas = await p.getAreas(countryId);

		return {
			ok: true,
			provider: p.code,
			providerAreas: areas,
		};
	}

	async createShipment(adminId: string, provider: string, dto: CreateShipmentDto, orderId?: number) {
		const p = this.getProvider(provider);
		const { apiKey, companyId } = await this.requireApiKey(adminId, provider);

		const weight = dto.weightKg ?? 1;

		const shipment = await this.shipmentsRepo.save(
			this.shipmentsRepo.create({
				adminId,
				orderId: orderId ?? null,
				shippingCompanyId: companyId,
				status: ShipmentStatus.SUBMITTED,
				unifiedStatus: UnifiedShippingStatus.NEW,
				providerRaw: {
					request: {
						provider,
						receiver: { name: dto.customerName, phone: dto.phoneNumber, address: dto.address },
						city: dto.city,
						area: dto.area || '',
						weight,
						size: dto.size || 'Small',
						cod: dto.codAmount || 0,
					},
				},
			}),
		);

		// IMPORTANT:
		// Bosta docs: if webhook configured in dashboard, no need to include webhookUrl in creation. :contentReference[oaicite:6]{index=6}
		// So we do NOT inject env webhook by default anymore.
		// If you still want fallback per-admin (optional), you can add it later.

		const providerPayload =
			provider === 'bosta'
				? {
					type: 10,
					specs: { packageType: 'Parcel', size: dto.size || 'Small', actualWeight: weight },
					receiver: {
						firstName: dto.customerName,
						lastName: '',
						phone: dto.phoneNumber,
						address: dto.address,
						city: dto.city,
						zone: dto.area || '',
					},
					cod: dto.codAmount || 0,
					notes: dto.notes || '',
				}
				: dto;

		try {
			const res = await p.createShipment(apiKey, providerPayload);

			shipment.trackingNumber = res.trackingNumber || null;
			shipment.providerShipmentId = res.providerShipmentId || null;
			shipment.labelUrl = res.labelUrl || null;

			shipment.status = ShipmentStatus.CREATED;
			shipment.unifiedStatus = UnifiedShippingStatus.IN_PROGRESS;

			shipment.providerRaw = {
				request: shipment.providerRaw?.request,
				response: res.providerRaw || { trackingNumber: shipment.trackingNumber, providerShipmentId: shipment.providerShipmentId },
			};

			await this.shipmentsRepo.save(shipment);

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
			shipment.providerRaw = { ...shipment.providerRaw, error: e?.response?.data || e?.message || 'unknown' };
			await this.shipmentsRepo.save(shipment);
			throw new BadRequestException(shipment.failureReason);
		}
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
			labelUrl: s.labelUrl,
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
		// set this in env to your backend public base url, e.g. https://api.yourdomain.com
		const base = process.env.PUBLIC_API_BASE_URL || process.env.APP_URL || 'http://localhost:3000';
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
		const p = this.getProvider(provider);
		const mapped = p.mapWebhookToUnified(body);

		const shipment = await this.shipmentsRepo.findOne({
			where: mapped.providerShipmentId
				? { providerShipmentId: mapped.providerShipmentId }
				: mapped.trackingNumber
					? { trackingNumber: mapped.trackingNumber }
					: ({} as any),
		});

		if (!shipment) return { ok: true, ignored: true, reason: 'shipment_not_found' };


		// Validate header per shipment.adminId + provider integration
		const company = await this.companiesRepo.findOne({ where: { code: provider } });
		if (!company) return { ok: true, ignored: true, reason: 'company_not_found' };

		const integ = await this.integrationsRepo.findOne({ where: { adminId: shipment.adminId, shippingCompanyId: company.id } });

		const expectedName = (integ?.credentials?.webhookHeaderName || 'Authorization').toLowerCase();
		const expectedValue = integ?.credentials?.webhookSecret;

		// If secret exists, require it
		if (expectedValue) {
			const incoming = headers?.[expectedName] ?? headers?.[expectedName.toLowerCase()];
			if (!incoming || String(incoming) !== String(expectedValue)) {
				return { ok: true, ignored: true, reason: 'auth_failed' };
			}
		}

		shipment.unifiedStatus = mapped.unifiedStatus;
		shipment.status = this.mapUnifiedToLegacy(mapped.unifiedStatus);
		await this.shipmentsRepo.save(shipment);

		await this.eventsRepo.save(
			this.eventsRepo.create({
				shipmentId: shipment.id,
				source: provider as any,
				eventType: 'status_changed',
				payload: body,
			}),
		);

		return { ok: true };
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
