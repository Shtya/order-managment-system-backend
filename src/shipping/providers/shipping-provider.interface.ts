import { UnifiedShippingStatus } from '../shipping.entity';

export type ProviderCode = 'bosta' | 'aramex' | 'dhl';

export type ProviderAreasResponse = {
	provider: ProviderCode;
	countryId?: number;
	providerRaw: any;
	normalized?: any;
};

export type ProviderCreateResult = {
	providerShipmentId?: string | null;
	trackingNumber?: string | null;
	labelUrl?: string | null;
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
	services: ProviderCapability<string[]>; // array of text
	coverage: ProviderCapability<any>;
	pricing: ProviderCapability<any>;
	limits: ProviderCapability<any>;
	quote: ProviderCapability<any>;
	raw?: any; // optional raw diagnostic
};

export interface ShippingProvider {
	code: ProviderCode;
	displayName: string;

	getAreas(countryId: number): Promise<ProviderAreasResponse>;

	createShipment(apiKey: string, payload: any): Promise<ProviderCreateResult>;

	mapWebhookToUnified(body: any): ProviderWebhookResult;

	getServices(apiKey: string): Promise<string[]>;

	getCapabilities(apiKey: string): Promise<ProviderCapabilitiesResponse>;
}
