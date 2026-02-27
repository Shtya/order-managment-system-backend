// --- File: backend/src/shipping/providers/jt.provider.ts ---
import { Injectable } from '@nestjs/common';
import {
  ProviderCapabilitiesResponse,
  ProviderCode,
  ProviderCreateResult,
  ProviderWebhookResult,
  ShippingProvider,
  UnifiedGeography,
} from './shipping-provider.interface';
import { ShippingIntegrationEntity, UnifiedShippingStatus } from '../../../entities/shipping.entity';
import { OrderEntity } from 'entities/order.entity';
import { CreateShipmentDto } from '../shipping.dto';

@Injectable()
export class JtProvider extends ShippingProvider {


  code: ProviderCode = 'jt';
  displayName = 'J&T Express';


  async createShipment(_apiKey: string, _payload: any): Promise<ProviderCreateResult> {
    throw new Error('J&T provider not implemented yet');
  }

  mapWebhookToUnified(_body: any): ProviderWebhookResult {
    return { unifiedStatus: UnifiedShippingStatus.IN_PROGRESS, rawState: null, trackingNumber: null, providerShipmentId: null };
  }

  async getServices(_apiKey: string): Promise<string[]> {
    return [];
  }
  getCities(apiKey: string): Promise<UnifiedGeography[]> {
    throw new Error('Method not implemented.');
  }
  getDistricts(apiKey: string, cityId: string): Promise<UnifiedGeography[]> {
    throw new Error('Method not implemented.');
  }
  getZones(apiKey: string, districtId: string): Promise<UnifiedGeography[]> {
    throw new Error('Method not implemented.');
  }

  buildDeliveryPayload(order: OrderEntity, dto: CreateShipmentDto, integartion?: ShippingIntegrationEntity): Promise<any> {
    throw new Error('Method not implemented.');
  }

  cancelShipment(apiKey: string, providerShipmentId: string): Promise<boolean> {
    throw new Error('Method not implemented.');
  }
  getShipmentStatus(apiKey: string, trackingNumber: string, accountId?: string): Promise<ProviderWebhookResult> {
    throw new Error('Method not implemented.');
  }
  getPickupLocations(apiKey: string): Promise<any[]> {
    throw new Error('Method not implemented.');
  }

  verifyWebhookAuth(headers: any, body: any, secret: string, headerName?: string): boolean {
    throw new Error('Method not implemented.');
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
