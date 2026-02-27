import { BadRequestException, Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import {
  ProviderCapabilitiesResponse,
  ProviderCode,
  ProviderCreateResult,
  ProviderWebhookResult,
  ShippingProvider,
  UnifiedGeography,
  UnifiedPickupLocation,
} from './shipping-provider.interface';
import { ShippingIntegrationEntity, UnifiedShippingStatus } from '../../../entities/shipping.entity';
import { OrderEntity, PaymentMethod } from 'entities/order.entity';
import { CreateShipmentDto } from '../shipping.dto';

type BostaEnv = 'stg' | 'prod';

function getBostaBaseUrl(env: BostaEnv) {
  if (env === 'stg') return 'https://stg-app.bosta.co/api/v2';
  return 'https://app.bosta.co/api/v2';
}

export enum BostaDeliveryType {
  Deliver = 10,
  CashCollection = 15,
  CustomerReturnPickup = 25,
  Exchange = 30,
}


@Injectable()
export class BostaProvider extends ShippingProvider {

  code: ProviderCode = 'bosta';
  displayName = 'Bosta';

  private baseUrl: string;
  private EGYPT_ID: string;
  constructor(private http: HttpService) {
    super();
    const env = (process.env.BOSTA_ENV as BostaEnv) || 'prod';
    this.baseUrl = getBostaBaseUrl(env);
    this.EGYPT_ID = (process.env.EGYPT_ID_ENV as BostaEnv) || '60e4482c7cb7d4bc4849c4d5';
  }

  async getCities(apiKey: string, countryId: string = this.EGYPT_ID): Promise<UnifiedGeography[]> {
    const url = `${this.baseUrl}/cities`;


    const { data } = await firstValueFrom(
      this.http.get(url, {
        params: { countryId },
        headers: { Authorization: apiKey }
      })
    );

    const res = data.data.list.map(city => ({
      id: city._id,
      nameEn: city.name,
      nameAr: city.nameAr,
      dropOff: city.dropOffAvailability,
      pickup: city.pickupAvailability
    }));

    return res;

  }
  async cancelShipment(apiKey: string, trackingNumber: string): Promise<boolean> {
    // Use the dynamic baseUrl which handles stg/prod environments
    const url = `${this.baseUrl}/deliveries/business/${trackingNumber}/terminate`;

    try {
      const { data } = await firstValueFrom(
        this.http.delete(url, {
          headers: {
            Authorization: apiKey,
            'Content-Type': 'application/json'
          },
        }),
      );


      return !!data;
    } catch (error) {
      return false;
    }
  }
  /**
   * Fetch zones for a specific city code
   */
  async getZones(apiKey: string, cityCode: string): Promise<UnifiedGeography[]> {
    const url = `${this.baseUrl}/cities/${cityCode}/zones`;
    const { data } = await firstValueFrom(
      this.http.get(url, {
        headers: { Authorization: apiKey }
      })
    );
    return data.data.map(z => ({
      id: z._id,
      nameEn: z.name,
      nameAr: z.nameAr,
      dropOff: z.dropOffAvailability,
      pickup: z.pickupAvailability
    }));
  }

  /**
   * Fetch districts for a specific city code
   */
  async getDistricts(apiKey: string, cityCode: string): Promise<UnifiedGeography[]> {
    const url = `${this.baseUrl}/cities/${cityCode}/districts`;
    const { data } = await firstValueFrom(
      this.http.get(url, {
        headers: { Authorization: apiKey }
      })
    );
    return data.data.map(area => ({
      id: area.districtId,
      nameAr: area.districtOtherName,
      nameEn: area.districtName,
      parentId: area.zoneId,
      dropOff: area.dropOffAvailability,
      pickup: area.pickupAvailability
    }));
  }


  // backend/src/shipping/providers/bosta.provider.ts

  async getPickupLocations(apiKey: string): Promise<UnifiedPickupLocation[]> {
    const url = `${this.baseUrl}/pickup-locations`;

    const { data } = await firstValueFrom(
      this.http.get(url, {
        headers: { Authorization: apiKey }
      })
    );
    return data.data.list.map(l => ({
      id: l._id,
      nameAr: l.locationName,
      namEn: l.locationName,
    }));
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
    const providerRaw = data?.data || data || null;

    return {
      trackingNumber,
      providerShipmentId,
      providerRaw,
    };
  }



  async buildDeliveryPayload(order: OrderEntity, dto: CreateShipmentDto, integartion?: ShippingIntegrationEntity): Promise<any> {
    const itemsCount = order.items.reduce((sum, item) => sum + item.quantity, 0);
    // ✅ Check if this order is a replacement for another order
    const isExchange = order.isReplacement;

    const headerName = integartion.credentials?.webhookHeaderName || 'Authorization';
    const secretValue = integartion.credentials?.webhookSecret || '';
    const webhookUrl = this.buildPublicWebhookUrl(this.code)

    const webhookCustomHeaders: Record<string, string> = {
      [headerName]: secretValue
    };
    const meta = order.shippingMetadata;

    if (!meta?.cityId || !meta?.districtId || !meta?.zoneId) {
      throw new BadRequestException(
        "Missing required shipping geography (City, District, or Zone). Please update the order details."
      );
    }
    const payload = {
      type: isExchange ? BostaDeliveryType.Exchange : BostaDeliveryType.Deliver,
      businessReference: order.orderNumber,
      uniqueBusinessReference: order.orderNumber,
      notes: [dto.notes, order.customerNotes].filter(Boolean).join(" |\n "),
      cod: order.paymentMethod === PaymentMethod.CASH_ON_DELIVERY ? order.finalTotal - order.shippingCost : 0,
      specs: {
        packageType: "Parcel",
        size: dto.size || "SMALL",
        packageDetails: {
          itemsCount: itemsCount,
        },
      },
      dropOffAddress: {
        city: order.shippingMetadata?.cityId,
        districtId: order?.shippingMetadata?.districtId,
        zoneId: order?.shippingMetadata?.zoneId,
        firstLine: order.address,
        secondLine: order.area || "",
      },
      receiver: {
        firstName: order.customerName.split(" ")[0],
        lastName: order.customerName.split(" ").slice(1).join(" ") || "",
        phone: order.phoneNumber,
        email: order.email,
      },

      // IMPORTANT:
      // Bosta docs: if webhook configured in dashboard, no need to include webhookUrl in creation. :contentReference[oaicite:6]{index=6}
      // So we do NOT inject env webhook by default anymore.
      // If you still want fallback per-admin (optional), you can add it later.
      webhookUrl,
      webhookCustomHeaders,
      businessLocationId: order?.shippingMetadata?.locationId,
      returnSpecs: null,
    };


    if (isExchange) {
      let returnItemsCount = 0;
      let totalReturnAmount;
      let returnInstructions = "The Package details:\n";

      if (order?.replacementResult?.items?.length) {
        const itemLines = order?.replacementResult?.items.map(ri => {
          returnItemsCount += ri.quantityToReplace;//Error
          const originalItem = ri?.originalOrderItem;

          if (originalItem) {
            const qtyToCalc = Math.min(ri.quantityToReplace, originalItem.quantity);
            totalReturnAmount += (Number(originalItem.unitPrice) || 0) * qtyToCalc;
          }
          const productName = ri.originalOrderItem?.variant?.product?.name || "Product";
          const sku = ri.originalOrderItem?.variant?.sku;

          return `- ${ri.quantityToReplace}x ${productName} (SKU: ${sku})`.trim();
        });

        returnInstructions += itemLines.join("\n");
      } else {
        returnItemsCount = itemsCount;
        returnInstructions += `- ${returnItemsCount} item(s)`;
      }

      payload.returnSpecs = {
        packageType: "Parcel",
        size: dto.size || "SMALL",
        packageDetails: {
          itemsCount: returnItemsCount,
          description: returnInstructions

        }
      };
    }

    return payload;
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

  // --- File: backend/src/shipping/providers/bosta.provider.ts ---

  verifyWebhookAuth(headers: any, _body: any, secret: string, headerName?: string): boolean {
    // Fallback to 'x-bosta-signature' if no custom name is provided in credentials
    const key = (headerName || 'Authorization').toLowerCase();

    // Look up the header (case-insensitive check)
    const incomingSecret = headers?.[key] ?? headers?.[key.toLowerCase()];

    if (!incomingSecret) return false;

    return String(incomingSecret).trim() === String(secret).trim();
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

  async verifyCredentials(apiKey: string, accountId: string): Promise<boolean> {
    if (!apiKey) throw new BadRequestException('Missing apiKey');

    try {
      // We call a profile endpoint to check if the key is authorized.
      const url = `${this.baseUrl}/users/fullData`;
      await firstValueFrom(
        this.http.get(url, {
          headers: {
            Authorization: apiKey,
            'Content-Type': 'application/json'
          },
        }),
      );
      return true;
    } catch (error) {
      // If the status is 401 (Unauthorized), the key is definitely wrong
      return false;
    }
  }

  async getShipmentStatus(apiKey: string, trackingNumber: string): Promise<ProviderWebhookResult> {
    const url = `${this.baseUrl}/deliveries/business/${trackingNumber}`;

    const { data } = await firstValueFrom(
      this.http.get(url, {
        headers: { Authorization: apiKey }
      })
    );

    if (!data.success || !data.data) {
      throw new Error('Shipment not found in Bosta');
    }

    const shipment = data.data;

    return {
      unifiedStatus: this.mapBostaStateToUnified(Number(shipment.state.code)),
      rawState: shipment.state.code,
      trackingNumber: shipment.trackingNumber,
      providerShipmentId: shipment._id,
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
