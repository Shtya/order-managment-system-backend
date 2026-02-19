import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import {
  ProviderAreasResponse,
  ProviderCapabilitiesResponse,
  ProviderCode,
  ProviderCreateResult,
  ProviderWebhookResult,
  ShippingProvider,
} from './shipping-provider.interface';
import { UnifiedShippingStatus } from '../../../entities/shipping.entity';

type BostaEnv = 'stg' | 'prod';

function getBostaBaseUrl(env: BostaEnv) {
  if (env === 'stg') return 'https://stg-app.bosta.co/api/v2';
  return 'https://app.bosta.co/api/v2';
}

@Injectable()
export class BostaProvider implements ShippingProvider {
  code: ProviderCode = 'bosta';
  displayName = 'Bosta';

  private baseUrl: string;

  constructor(private http: HttpService) {
    const env = (process.env.BOSTA_ENV as BostaEnv) || 'stg';
    this.baseUrl = getBostaBaseUrl(env);
  }

  async getAreas(countryId: number): Promise<ProviderAreasResponse> {
    const url = `${this.baseUrl}/cities/getAllDistricts?countryId=${countryId}`;
    const { data } = await firstValueFrom(this.http.get(url));

    return {
      provider: 'bosta',
      countryId,
      providerRaw: data,
      normalized: data,
    };
  }

  async createShipment(apiKey: string, payload: any): Promise<ProviderCreateResult> {
    const url = `${this.baseUrl}/deliveries?apiVersion=1`;

    const { data } = await firstValueFrom(
      this.http.post(url, payload, {
        headers: {
          Authorization: apiKey,
          'Content-Type': 'application/json',
        },
      }),
    );

    const trackingNumber = data?.trackingNumber || data?.data?.trackingNumber || null;
    const providerShipmentId = data?._id || data?.data?._id || null;

    return {
      trackingNumber,
      providerShipmentId,
      labelUrl: data?.labelUrl || data?.data?.labelUrl || null,
      providerRaw: { trackingNumber, providerShipmentId },
    };
  }

  mapWebhookToUnified(body: any): ProviderWebhookResult {
    const providerShipmentId = body?._id ?? null;
    const trackingNumber = body?.trackingNumber ? String(body.trackingNumber) : null;
    const state = body?.state;
    const unified = this.mapBostaStateToUnified(state);

    return {
      unifiedStatus: unified,
      rawState: state,
      trackingNumber,
      providerShipmentId,
    };
  }

  /**
   * ✅ Array of text describing what Bosta integration supports in YOUR system.
   * (Not “business features”, but integration capabilities your backend can do)
   */
  async getServices(_apiKey: string): Promise<string[]> {
    return [
      'create_shipment',
      'webhook_status',
      'areas',
      'tracking_number',
      'label_url',
      // later you can add: 'cancel_shipment', 'pickup_request', ...
    ];
  }

  /**
   * ✅ Dynamic capabilities endpoint.
   * If Bosta doesn’t expose pricing/limits/coverage APIs, mark as unavailable.
   * Areas is available (we already have getAreas).
   */
  async getCapabilities(apiKey: string): Promise<ProviderCapabilitiesResponse> {
    // We can safely say these are available in our integration:
    const services = await this.getServices(apiKey);

    return {
      provider: 'bosta',
      services: { available: true, data: services },

      // “coverage/pricing/limits/quote” depend on provider official endpoints.
      // You asked: don’t hardcode; so return unavailable until you provide endpoints.
      coverage: {
        available: false,
        reason: 'Provider does not expose coverage configuration API (not implemented).',
      },
      pricing: {
        available: false,
        reason: 'Provider does not expose pricing API (not implemented).',
      },
      limits: {
        available: false,
        reason: 'Provider does not expose limits API (not implemented).',
      },
      quote: {
        available: false,
        reason: 'Provider does not expose quote API (not implemented).',
      },
    };
  }

  private mapBostaStateToUnified(state: number): UnifiedShippingStatus {
    if (state == null) return UnifiedShippingStatus.IN_PROGRESS;

    if ([10, 11].includes(state)) return UnifiedShippingStatus.NEW;
    if ([20, 24, 25, 30, 102].includes(state)) return UnifiedShippingStatus.IN_PROGRESS;

    if ([21, 23].includes(state)) return UnifiedShippingStatus.PICKED_UP;
    if ([22, 40, 41].includes(state)) return UnifiedShippingStatus.IN_TRANSIT;

    if (state === 45) return UnifiedShippingStatus.DELIVERED;
    if (state === 46) return UnifiedShippingStatus.RETURNED;
    if (state === 47) return UnifiedShippingStatus.EXCEPTION;
    if (state === 49) return UnifiedShippingStatus.CANCELLED;
    if (state === 48) return UnifiedShippingStatus.TERMINATED;

    if (state === 100) return UnifiedShippingStatus.LOST;
    if (state === 101) return UnifiedShippingStatus.DAMAGED;
    if (state === 60) return UnifiedShippingStatus.RETURNED;

    if (state === 103) return UnifiedShippingStatus.ACTION_REQUIRED;
    if (state === 104) return UnifiedShippingStatus.ARCHIVED;
    if (state === 105) return UnifiedShippingStatus.ON_HOLD;

    return UnifiedShippingStatus.IN_PROGRESS;
  }
}
