// --- File: backend/src/shipping/providers/turbo.provider.ts ---
import { Injectable } from '@nestjs/common';
import {
  ProviderAreasResponse,
  ProviderCapabilitiesResponse,
  ProviderCode,
  ProviderCreateResult,
  ProviderWebhookResult,
  ShippingProvider,
} from './shipping-provider.interface';
import { UnifiedShippingStatus } from '../shipping.entity';

@Injectable()
export class TurboProvider implements ShippingProvider {
  code: ProviderCode = 'turbo';
  displayName = 'Turbo';

  async getAreas(_countryId: number): Promise<ProviderAreasResponse> {
    return { provider: 'turbo', providerRaw: null, normalized: null };
  }

  async createShipment(_apiKey: string, _payload: any): Promise<ProviderCreateResult> {
    throw new Error('Turbo provider not implemented yet');
  }

  mapWebhookToUnified(_body: any): ProviderWebhookResult {
    return { unifiedStatus: UnifiedShippingStatus.IN_PROGRESS, rawState: null, trackingNumber: null, providerShipmentId: null };
  }

  async getServices(_apiKey: string): Promise<string[]> {
    return [];
  }

  async getCapabilities(_apiKey: string): Promise<ProviderCapabilitiesResponse> {
    return {
      provider: 'turbo',
      services: { available: false, reason: 'Not implemented yet.' },
      coverage: { available: false, reason: 'Not implemented yet.' },
      pricing: { available: false, reason: 'Not implemented yet.' },
      limits: { available: false, reason: 'Not implemented yet.' },
      quote: { available: false, reason: 'Not implemented yet.' },
    };
  }
}
