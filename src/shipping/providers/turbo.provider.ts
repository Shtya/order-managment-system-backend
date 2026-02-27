// --- File: backend/src/shipping/providers/turbo.provider.ts ---
import { BadRequestException, Injectable } from '@nestjs/common';
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
import { firstValueFrom } from 'rxjs';
import { HttpService } from '@nestjs/axios';

export enum TurboOrderType {
  STANDARD = 0,         // استلام طرد مع التحصيل
  PARTIAL_RETURN = 1,   // مرتجع جزئي
  EXCHANGE = 2,         // مرتجع استبدال
  RETURN_PICKUP = 3,    // مرتجع استرجاع
}

export enum TurboDeliveryType {
  TO_ADDRESS = 0,       // توصيل قياسي إلى عنوان المستلم
  TO_OFFICE = 1,        // التسليم إلى المكتب (الاستلام من الفرع)
}

@Injectable()
export class TurboProvider extends ShippingProvider {
  // Use the backoffice URL for geography as specified in your examples
  private readonly geoBaseUrl = 'https://backoffice.turbo-eg.com';
  // Main platform URL for other operations
  private readonly mainBaseUrl = 'https://platform.turbo.info';

  code: ProviderCode = 'turbo';
  displayName = 'Turbo';

  constructor(private readonly http: HttpService) {
    super();
  }

  /**
   * 1 & 2 - Get Governments (Mapped to Cities)
   * URL: https://backoffice.turbo-eg.com/external-api/get-government
   */
  async getCities(apiKey: string): Promise<UnifiedGeography[]> {
    const url = `${this.geoBaseUrl}/external-api/get-government`;

    const { data } = await firstValueFrom(
      this.http.get(url, {
        params: { authentication_key: apiKey },
      }),
    );

    if (!data.success) return [];

    // Mapping the "feed" array to UnifiedGeography
    return data.feed.map((city: any) => ({
      id: String(city.id),
      nameAr: city.name,
      nameEn: city.name,
      dropOff: true,
      pickup: true,
    }));
  }

  /**
   * 3 - Get Areas (Mapped to Zones)
   * URL: https://backoffice.turbo-eg.com/external-api/get-area/{cityId}
   */
  async getZones(apiKey: string, cityId: string): Promise<UnifiedGeography[]> {
    const url = `${this.geoBaseUrl}/external-api/get-area/${cityId}`;

    const { data } = await firstValueFrom(
      this.http.get(url, {
        params: { authentication_key: apiKey },
      }),
    );

    if (!data.success) return [];

    return data.feed.map((area: any) => ({
      id: String(area.id),
      nameAr: area.name,
      nameEn: area.name,
      parentId: cityId, // Linking back to the city
      dropOff: true,
      pickup: true,
    }));
  }

  async cancelShipment(apiKey: string, providerShipmentId: string, accountId?: string): Promise<boolean> {
    const url = `${this.mainBaseUrl}/external-api/delete-order`;

    try {
      const { data } = await firstValueFrom(
        this.http.post(url, {
          authentication_key: apiKey,
          main_client_code: accountId,
          search_key: String(providerShipmentId), // Turbo expects numeric ID
        })
      );

      // Assuming Turbo returns a success flag or message
      return data?.success === true || data?.message === 'success';
    } catch (error) {
      // Logic for handling failed cancellations (e.g., shipment already out for delivery)
      return false;
    }
  }

  async buildDeliveryPayload(
    order: OrderEntity,
    dto: CreateShipmentDto,
    integration?: ShippingIntegrationEntity
  ): Promise<any> {
    const meta = order.shippingMetadata;

    // التأكد من وجود البيانات الجغرافية (المحافظة والمنطقة)
    // Turbo يتطلب الأسماء كنصوص (Strings) في طلب إضافة الطلب
    if (!meta?.cityId || !meta?.zoneId) {
      throw new BadRequestException(
        "Missing required shipping geography names (Government or Area). Please update the order details."
      );
    }

    // جلب كود العميل الرئيسي من إعدادات التكامل
    const accountId = integration?.credentials?.accountId;
    if (!accountId) {
      throw new BadRequestException("Turbo main_client_code is missing in integration credentials.");
    }
    const isExchange = order.isReplacement;

    const payload: any = {
      main_client_code: accountId,
      receiver: order.customerName,
      phone1: order.phoneNumber,
      government: meta.cityId, // اسم المحافظة بالعربي
      area: meta.zoneId,       // اسم المنطقة بالعربي
      address: order.address,
      notes: [dto.notes, order.customerNotes].filter(Boolean).join(" | "),
      invoice_number: order.orderNumber,
      // تعديل سطر ملخص الطلب في TurboProvider
      order_summary: order.items
        .map(item => {
          const quantity = item.quantity || 1;
          // الوصول لاسم المنتج بناءً على هيكلة البيانات لديك
          const productName = item.variant?.product?.name || 'Product';

          return `${quantity}x ${productName}`;
        })
        .join(", "),
      amount_to_be_collected: order.paymentMethod === PaymentMethod.CASH_ON_DELIVERY ? order.finalTotal - order.shippingCost : 0,
      return_amount: 0, // يمكن تخصيصه في حالة المرتجعات
      is_order: TurboOrderType.STANDARD, // القيمة الافتراضية
      weight: dto.weightKg || 1,
      delivery_type: TurboDeliveryType.TO_ADDRESS,
      remote_order_id: order.id,
    };

    const itemsCount = order.items.reduce((sum, item) => sum + item.quantity, 0);

    if (isExchange) {
      let returnItemsCount = 0;
      let totalReturnAmount = 0; // Fixed: Initialized to 0 to avoid NaN
      let returnInstructions = "The Package details:\n";

      if (order?.replacementResult?.items?.length) {
        const itemLines = order.replacementResult.items.map(ri => {
          returnItemsCount += ri.quantityToReplace;
          const originalItem = ri?.originalOrderItem;

          if (originalItem) {
            const qtyToCalc = Math.min(ri.quantityToReplace, originalItem.quantity);
            totalReturnAmount += (Number(originalItem.unitPrice) || 0) * qtyToCalc;
          }

          const productName = originalItem?.variant?.product?.name || "Product";
          const sku = originalItem?.variant?.sku;

          return `- ${ri.quantityToReplace}x ${productName} (SKU: ${sku})`.trim();
        });

        returnInstructions += itemLines.join("\n");
      } else {
        returnItemsCount = itemsCount;
        returnInstructions += `- ${returnItemsCount} item(s)`;
      }

      payload.is_order = TurboOrderType.EXCHANGE;
      payload.return_amount = totalReturnAmount;
      payload.return_summary = returnInstructions;
    }

    return payload;
  }

  async getShipmentStatus(apiKey: string, trackingNumber: string, mainClientCode: string): Promise<ProviderWebhookResult> {
    const url = `${this.mainBaseUrl}/external-api/search-order`;

    const { data } = await firstValueFrom(
      this.http.post(url, {
        authentication_key: apiKey,
        search_key: trackingNumber,
        main_client_code: mainClientCode
      })
    );

    if (!data.success || !data.result || data.result.length === 0) {
      throw new Error('Shipment not found in Turbo');
    }

    const shipment = data.result[0];

    return {
      unifiedStatus: this.mapTurboStateToUnified(Number(shipment.status_code)),
      rawState: shipment.status_code,
      trackingNumber: shipment.bar_code || shipment.code,
      providerShipmentId: shipment.bar_code || shipment.code,
    };
  }

  /**
   * إرسال طلب إنشاء الشحنة إلى Turbo
   */
  async createShipment(apiKey: string, payload: any): Promise<ProviderCreateResult> {
    const url = `${this.mainBaseUrl}/external-api/add-order`;

    // Turbo يتوقع مفتاح المصادقة داخل الـ Body
    const requestBody = {
      ...payload,
      authentication_key: apiKey
    };

    const { data } = await firstValueFrom(
      this.http.post(url, requestBody, {
        headers: { 'Content-Type': 'application/json' },
      }),
    );


    if (!data?.bar_code && !data?.code) {
      throw new BadRequestException(
        `Turbo Error: ${data?.message || 'Failed to create shipment'}`
      );
    }

    const result = data.result;

    return {
      // نستخدم toString() لأن الواجهة تتوقع string والقيم القادمة أرقام
      // نستخدم bar_code للتتبع و code كمعرف للمزود
      trackingNumber: result?.bar_code?.toString() || result?.code?.toString() || null,
      providerShipmentId: result?.bar_code?.toString() || result?.code?.toString() || null,
      providerRaw: data, // نحتفظ بالرد كامل للرجوع إليه
    };
  }

  async getPickupLocations(apiKey: string): Promise<UnifiedPickupLocation[]> {
    return [];
  }

  async getDistricts(apiKey: string, cityId: string): Promise<UnifiedGeography[]> {
    return [];
  }

  ///need test
  mapWebhookToUnified(body: any): ProviderWebhookResult {

    const statusCode = Number(body?.status);

    const trackingNumber = body?.order_number?.toString() || body?.order_number?.toString();

    return {
      unifiedStatus: this.mapTurboStateToUnified(statusCode),
      rawState: statusCode,
      trackingNumber: trackingNumber,
      providerShipmentId: body?.order_number?.toString(),
    };
  }

  verifyWebhookAuth(headers: any, _body: any, secret: string, headerName?: string): boolean {
    const key = (headerName || 'Authorization').toLowerCase();
    const authHeader = headers?.[key] ?? headers?.[key.toLowerCase()];

    if (!authHeader) return false;

    // Strip Bearer prefix as seen in Turbo's request
    const token = authHeader.replace(/^Bearer\s+/i, '');

    return token === secret;
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

  // --- File: backend/src/shipping/providers/turbo.provider.ts ---

  async verifyCredentials(apiKey: string, accountId: string): Promise<boolean> {
    const url = `${this.mainBaseUrl}/external-api/search-order`;
    if (!apiKey) throw new BadRequestException('Missing apiKey');
    if (!accountId) throw new BadRequestException('Missing accountId');

    try {
      const { data } = await firstValueFrom(
        this.http.post(url, {
          authentication_key: apiKey,
          search_key: "FAKE_ID_123", // رقم وهمي للتحقق فقط
          main_client_code: accountId
        })
      );

      return data?.success === true;

    } catch (error) {
      // في حال كان الخطأ 401 (Unauthorized)
      if (error.response?.status === 401 || error.response?.status === 403) {
        return false;
      }

    }
    return true;
  }
  /**
 * خريطة تحويل حالات Turbo Express إلى الحالات الموحدة للنظام
 */
  private mapTurboStateToUnified(state: number): UnifiedShippingStatus {
    if (state == null) return UnifiedShippingStatus.IN_PROGRESS;

    // 1. حالات جديدة (New)
    // 1: قيد الانتظار، 7: غير مكتملة
    if ([1, 7].includes(state)) {
      return UnifiedShippingStatus.NEW;
    }

    // 2. تحت الإجراء / تم القبول (In Progress)
    // 2: المقبولة، 25: معاد إرسالها (بانتظار إجراء جديد)
    if ([2, 25].includes(state)) {
      return UnifiedShippingStatus.IN_PROGRESS;
    }

    // 3. خرج للتوصيل (In Transit)
    // 4: مسلمة للمندوب
    if (state === 4) {
      return UnifiedShippingStatus.IN_TRANSIT;
    }

    // 4. تم التسليم (Delivered)
    // 5: تم التسليم، 20: تم التوريد (تحصيل المبلغ)
    if ([5, 20].includes(state)) {
      return UnifiedShippingStatus.DELIVERED;
    }

    // 5. مرتجعات (Returned)
    // 21: مرتجعات وصلت لك، 17: مرتجع إلغاء مع المندوب
    if ([21, 17].includes(state)) {
      return UnifiedShippingStatus.RETURNED;
    }

    // 6. ملغاة (Cancelled)
    // 6: ملغاة
    if (state === 6) {
      return UnifiedShippingStatus.CANCELLED;
    }

    // 7. استثناءات ومشاكل (Exception / On Hold)
    // 9: مؤجلة مع المندوب
    if (state === 9) {
      return UnifiedShippingStatus.ON_HOLD;
    }

    // 8. مفقودات وتلفيات (Lost / Damaged)
    // 23: مرتجعات مفقودة
    if (state === 23) {
      return UnifiedShippingStatus.LOST;
    }
    // 24: مرتجعات معدومة (تالفة)
    if (state === 24) {
      return UnifiedShippingStatus.DAMAGED;
    }

    // الحالة الافتراضية
    return UnifiedShippingStatus.IN_PROGRESS;
  }
}


