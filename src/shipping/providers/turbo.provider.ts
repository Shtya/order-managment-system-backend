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

import { firstValueFrom } from 'rxjs';
import { HttpService } from '@nestjs/axios';
import { CreateShipmentDto } from 'dto/shipping.dto';
import { TranslationService } from 'common/translation.service';

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
  private readonly geoBaseUrl = process.env.TURBO_GEO_API_URL;
  // Main platform URL for other operations
  private readonly mainBaseUrl = 'https://platform.turbo.info';

  code: ProviderCode = 'turbo';
  displayName = 'Turbo';

  constructor(
    private readonly http: HttpService,
    private translations: TranslationService,
  ) {
    super();
  }


  async getCities(apiKey: string): Promise<UnifiedGeography[]> {
    const url = `${this.geoBaseUrl}/external-api/get-government`;
    try {

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
    } catch (error) {
      return [];
    }
  }

  /**
   * 3 - Get Areas (Mapped to Zones)
   * URL: https://backoffice.turbo-eg.com/external-api/get-area/{cityId}
   */
  async getZones(apiKey: string, cityId: string): Promise<UnifiedGeography[]> {
    const url = `${this.geoBaseUrl}/external-api/get-area/${cityId}`;
    try {
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
    } catch (error) {
      return [];
    }
  }

  async cancelShipment(apiKey: string, providerShipmentId: string, accountId?: string): Promise<boolean> {
    const url = `${this.mainBaseUrl}/external-api/canceled`;

    try {
      const { data } = await firstValueFrom(
        this.http.post(url, {
          authentication_key: apiKey,
          // main_client_code: accountId,
          id: providerShipmentId, // Turbo expects numeric ID
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

    if (!meta?.cityId) {
      return {
        success: false,
        error: this.translations.t('domains.shipping.turbo_city_required'),
      };
    }

    if (!meta?.zoneId) {
      return {
        success: false,
        error: this.translations.t('domains.shipping.turbo_area_required'),
      };
    }


    // جلب كود العميل الرئيسي من إعدادات التكامل
    const accountId = integration?.credentials?.accountId;
    if (!accountId) {
      return {
        success: false,
        error: this.translations.t('domains.shipping.turbo_account_id_missing'),
      };
    }
    const isExchange = order.isReplacement;

    const payload: any = {
      main_client_code: accountId,
      receiver: order.customerName || "",
      phone1: order.phoneNumber,
      government: meta.cityId, // اسم المحافظة بالعربي
      area: meta.zoneId,       // اسم المنطقة بالعربي
      address: order.address || "",
      notes: order.customerNotes,
      invoice_number: order.orderNumber,
      // تعديل سطر ملخص الطلب في TurboProvider
      order_summary: order.items
        .map(item => {
          const quantity = item.quantity || 1;
          // الوصول لاسم المنتج بناءً على هيكلة البيانات لديك
          const productName = item.variant?.product?.name || this.translations.t('common.product_fallback');

          return `${quantity}x ${productName}`;
        })
        .join(", ") || "",
      amount_to_be_collected: order.paymentMethod === PaymentMethod.CASH_ON_DELIVERY ? Math.max(0, (order.finalTotal - order.deposit) || 0) : 0,
      return_amount: 0, // يمكن تخصيصه في حالة المرتجعات
      is_order: TurboOrderType.STANDARD, // القيمة الافتراضية
      weight: dto.weightKg || 1,
      delivery_type: TurboDeliveryType.TO_ADDRESS,
      remote_order_id: order.id,
    };

    const itemsCount = order.items.reduce((sum, item) => sum + item.quantity, 0);

    if (isExchange) {
      let returnItemsCount = 0;
      let returnInstructions = "The Package details:\n";

      if (order?.replacementResult?.items?.length) {
        const itemLines = order.replacementResult.items.map(ri => {
          returnItemsCount += ri.returnQuantity;

          const originalItem = ri.originalOrderItem;
          const productName = originalItem?.variant?.product?.name || "Product";
          const sku = originalItem?.variant?.sku;

          return `${ri.returnQuantity}x ${productName} (SKU: ${sku})`.trim();
        });

        returnInstructions += itemLines.join("\n - ");
      } else {
        returnItemsCount = itemsCount;
      }

      const codAmount =
        order.paymentMethod === PaymentMethod.CASH_ON_DELIVERY
          ? (order.finalTotal - order.deposit)
          : 0;

      payload.is_order = TurboOrderType.EXCHANGE;

      // Send only the amount to be returned (negative COD), otherwise 0.
      payload.return_amount = codAmount < 0 ? Math.abs(codAmount) : 0;
      payload.return_summary = returnInstructions;
    }

    return { success: true, data: payload };
  }

  async getShipmentStatus(apiKey: string, trackingNumber: string, mainClientCode: string): Promise<ProviderWebhookResult> {
    const url = `${this.mainBaseUrl}/external-api/search-order`;

    try {
      const { data } = await firstValueFrom(
        this.http.post(url, {
          authentication_key: apiKey,
          search_key: trackingNumber,
          main_client_code: mainClientCode
        })
      );

      if (!data.success || !data.result || data.result.length === 0) {
        throw new Error(this.translations.t('domains.shipping.turbo_shipment_not_found'));
      }

      const shipment = data.result[0];

      return {
        unifiedStatus: shipment.status_code ? this.mapTurboStateToUnified(Number(shipment.status_code)) : this.mapTurboTextStateToUnified(shipment.status),
        rawState: shipment.status,
        trackingNumber: shipment.bar_code || shipment.code,
        providerShipmentId: shipment.bar_code || shipment.code,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * إرسال طلب إنشاء الشحنة إلى Turbo
   */
  async createShipment(apiKey: string, payload: any): Promise<ProviderCreateResult> {
    const url = `${this.mainBaseUrl}/external-api/add-order`;
    try {

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


      if (!data?.result?.bar_code && !data?.result?.code) {
        throw new BadRequestException(
          this.translations.t('domains.shipping.turbo_creation_error', { args: { errorMsg: data?.error_msg || data?.message || this.translations.t('domains.shipping.turbo_failed_creation_fallback') } })
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
    } catch (error) {
      throw error;
    }
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
      unifiedStatus: statusCode ? this.mapTurboStateToUnified(statusCode) : this.mapTurboTextStateToUnified(body?.status),
      rawState: statusCode,
      trackingNumber: trackingNumber,
      providerShipmentId: body?.order_number?.toString(),
      notes: body?.notes || body?.exceptionReason || body?.message || "",
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

  async verifyCredentials(apiKey: string, accountId?: string): Promise<{ valid: boolean, message: string }> {
    const url = `${this.mainBaseUrl}/external-api/search-order`;
    if (!apiKey) throw new BadRequestException(this.translations.t('domains.shipping.missing_api_key'));
    if (!accountId) throw new BadRequestException(this.translations.t('domains.shipping.missing_account_id'));

    try {
      const { data } = await firstValueFrom(
        this.http.post(url, {
          authentication_key: apiKey,
          search_key: "FAKE_ID_123", // رقم وهمي للتحقق فقط
          main_client_code: accountId
        })
      );

      return { valid: data?.success === true, message: this.translations.t('domains.shipping.credentials_verified') };

    } catch (error: any) {
      if (error.status !== 404) {
        return { valid: false, message: this.getErrorMessage(error) };
      }
      return { valid: true, message: this.translations.t('domains.shipping.credentials_verified') };
      // في حال كان الخطأ 401 (Unauthorized)

    }
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

    if (state === 3) {
      return UnifiedShippingStatus.IN_PROGRESS;
    }

    // الحالة الافتراضية
    return UnifiedShippingStatus.IN_PROGRESS;
  }

  private mapTurboTextStateToUnified(stateText: string): UnifiedShippingStatus {
    if (!stateText) return UnifiedShippingStatus.IN_PROGRESS;

    // تنظيف النص من المسافات الزائدة قبل المقارنة
    const normalizedState = stateText.trim();

    switch (normalizedState) {
      // 1. حالات جديدة (New)
      // return UnifiedShippingStatus.NEW;

      // 2. تحت الإجراء / تم القبول (In Progress)
      case 'قيد التنفيذ':
      case 'معاد ارسالها':
      case 'غير مكتملة':
      case 'قيد الإنتظار':
        return UnifiedShippingStatus.IN_PROGRESS;

      // 3. خرج للتوصيل (In Transit)
      case 'مسلمة للمندوب':
      case 'الشحن الدولي':
        return UnifiedShippingStatus.IN_TRANSIT;

      // 4. تم التسليم (Delivered)
      case 'تم التسليم':
      case 'تم التوريد':
        return UnifiedShippingStatus.DELIVERED;

      // 5. مرتجعات (Returned)
      case 'مرتجعات فى الشركة':
      case 'مرتجعات وصلت لك':
        return UnifiedShippingStatus.RETURNED;

      // 6. استثناءات ومشاكل (Exception / On Hold)
      case 'مؤجلة مع المندوب':
        return UnifiedShippingStatus.ON_HOLD;

      // 7. مفقودات وتلفيات (Lost / Damaged)
      case 'مرتجعات مفقودة':
        return UnifiedShippingStatus.LOST;

      case 'مرتجعات معدومة':
        return UnifiedShippingStatus.DAMAGED;

      // الحالة الافتراضية لأي نص غير معروف
      default:
        return UnifiedShippingStatus.IN_PROGRESS;
    }
  }
}

