// --- File: backend/src/shipping/providers/jt.provider.ts ---
import { Injectable } from '@nestjs/common';
import {
  ProviderAreasResponse,
  ProviderCapabilitiesResponse,
  ProviderCode,
  ProviderCreateResult,
  ProviderWebhookResult,
  ShippingProvider,
} from './shipping-provider.interface';
import { UnifiedShippingStatus } from '../../../entities/shipping.entity';

@Injectable()
export class JtProvider implements ShippingProvider {
  code: ProviderCode = 'jt';
  displayName = 'J&T Express';

  async getAreas(_countryId: number): Promise<ProviderAreasResponse> {
    return { provider: 'jt', providerRaw: null, normalized: null };
  }

  async createShipment(_apiKey: string, _payload: any): Promise<ProviderCreateResult> {
    throw new Error('J&T provider not implemented yet');
  }

  mapWebhookToUnified(_body: any): ProviderWebhookResult {
    return { unifiedStatus: UnifiedShippingStatus.IN_PROGRESS, rawState: null, trackingNumber: null, providerShipmentId: null };
  }

  async getServices(_apiKey: string): Promise<string[]> {
    return [];
  }

  async getCapabilities(_apiKey: string): Promise<ProviderCapabilitiesResponse> {
    return {
      provider: 'jt',
      services: { available: false, reason: 'Not implemented yet.' },
      coverage: { available: false, reason: 'Not implemented yet.' },
      pricing: { available: false, reason: 'Not implemented yet.' },
      limits: { available: false, reason: 'Not implemented yet.' },
      quote: { available: false, reason: 'Not implemented yet.' },
    };
  }

  async verifyCredentials(apiKey: string): Promise<boolean> {
    return true;
  }
}
