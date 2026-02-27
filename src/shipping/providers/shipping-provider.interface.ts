// --- File: backend/src/shipping/providers/shipping-provider.interface.ts ---
import { OrderEntity } from 'entities/order.entity';
import { ShippingIntegrationEntity, UnifiedShippingStatus } from '../../../entities/shipping.entity';
import { CreateShipmentDto } from '../shipping.dto';

export type ProviderCode = 'bosta' | 'jt' | 'turbo' | 'aramex' | 'dhl';

export interface UnifiedGeography {
	id: string;
	nameEn: string;
	nameAr: string;
	dropOff: boolean
	pickup: boolean
	parentId?: string // as zoneid for distinct
}

export interface UnifiedPickupLocation {
	id: string;
	nameAr: string;
	nameEn: string;
	isDefault: boolean;
}

export type ProviderCreateResult = {
	providerShipmentId?: string | null;
	trackingNumber?: string | null;
	providerRaw?: any;
};

export type ProviderWebhookResult = {
	unifiedStatus: UnifiedShippingStatus;
	rawState?: any;
	trackingNumber?: string | null;
	providerShipmentId?: string | null;
};

export type ProviderCapability<T = any> = {
	available: boolean;
	data?: T;
	reason?: string;
};

export type ProviderCapabilitiesResponse = {
	provider: ProviderCode;
	services: ProviderCapability<string[]>;
	coverage: ProviderCapability<any>;
	pricing: ProviderCapability<any>;
	limits: ProviderCapability<any>;
	quote: ProviderCapability<any>;
	raw?: any;
};

export abstract class ShippingProvider {
	abstract readonly code: ProviderCode;
	abstract readonly displayName: string;

	// Geography & Capabilities
	// abstract getAreas(countryId: number): Promise<UnifiedGeography[]>;

	abstract getCities(apiKey: string): Promise<UnifiedGeography[]>;
	abstract getDistricts(apiKey: string, cityId: string): Promise<UnifiedGeography[]>;
	abstract getZones(apiKey: string, districtId: string): Promise<UnifiedGeography[]>;
	abstract getPickupLocations(apiKey: string): Promise<UnifiedPickupLocation[]>;

	abstract getCapabilities(apiKey: string): Promise<ProviderCapabilitiesResponse>;
	abstract getServices(apiKey: string): Promise<string[]>;

	abstract verifyCredentials(apiKey: string, accountId?: string): Promise<boolean>;

	// Shipment Creation
	abstract createShipment(apiKey: string, payload: any): Promise<ProviderCreateResult>;
	abstract buildDeliveryPayload(order: OrderEntity, dto: CreateShipmentDto, integartion?: ShippingIntegrationEntity): Promise<any>;

	// Webhooks
	abstract mapWebhookToUnified(body: any): ProviderWebhookResult;
	abstract verifyWebhookAuth(headers: any, body: any, secret: string, headerName?: string): boolean;
	/**
	 * Common helper to format display names or clean strings
	 */
	abstract cancelShipment(apiKey: string, providerShipmentId: string, accountId?: string): Promise<boolean>;
	abstract getShipmentStatus(apiKey: string, trackingNumber: string, accountId?: string): Promise<ProviderWebhookResult>;

	protected buildPublicWebhookUrl(provider: string) {
		const base = process.env.PUBLIC_API_BASE_URL || 'http://localhost:3000';
		return `${base.replace(/\/$/, '')}/shipping/webhooks/${provider}`;
	}

	protected formatName(first: string, last?: string): string {
		return `${first} ${last || '.'}`.trim();
	}
}
