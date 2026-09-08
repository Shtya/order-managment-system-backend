import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import {
  CampaignEntity,
  CampaignProductEntity,
  CampaignRecipientEntity,
} from "entities/campaigns.entity";
import { ClientAddressEntity, ClientEntity } from "entities/clients.entity";
import {
  OrderEntity,
  OrderStatus,
  PaymentMethod,
} from "entities/order.entity";
import { PublicCampaignOrderSubmitDto } from "dto/public-campaign-order.dto";
import { TranslationService } from "common/translation.service";
import { OrdersService } from "src/orders/services/orders.service";

@Injectable()
export class PublicCampaignOrdersService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly translations: TranslationService,
    private readonly ordersService: OrdersService,
    @InjectRepository(CampaignRecipientEntity)
    private readonly recipientRepo: Repository<CampaignRecipientEntity>,
  ) {}

  async getByToken(token: string) {
    const recipient = await this.recipientRepo.findOne({
      where: { accessToken: token },
      relations: {
        campaign: { products: true },
      },
    });
    if (!recipient?.campaign?.enablePurchasePage) {
      throw new NotFoundException(
        this.translations.t("domains.campaigns.order_link_unavailable"),
      );
    }
    const campaign = recipient.campaign;
    const [address, client, order] = await Promise.all([
      recipient.clientId
        ? this.dataSource
            .getRepository(ClientAddressEntity)
            .find({
              where: { clientId: recipient.clientId },
              relations: { cityDetails: true, areaDetails: true },
              order: { isDefault: "DESC", createdAt: "ASC" },
              take: 1,
            })
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      recipient.clientId
        ? this.dataSource.getRepository(ClientEntity).findOne({
            where: { id: recipient.clientId },
          })
        : Promise.resolve(null),
      recipient.orderId
        ? this.dataSource.getRepository(OrderEntity).findOne({
            where: { id: recipient.orderId },
            relations: { cityDetails: true },
          })
        : Promise.resolve(null),
    ]);

    const extras = order
      ? {
          alreadyOrdered: true,
          orderNumber: order.orderNumber,
          customerName: order.customerName || recipient.name || client?.name || "",
          phoneNumber: order.phoneNumber || recipient.phoneNumber,
          address: order.address || "",
          city: order.city || order.cityDetails?.nameEn || "",
          cityId: order.cityId || null,
          area: order.area || "",
          landmark: order.landmark || "",
          customerNotes: order.customerNotes || "",
        }
      : {
          alreadyOrdered: false,
          orderNumber: null,
          customerName: recipient.name || client?.name || "",
          phoneNumber: recipient.phoneNumber,
          address: address?.address || "",
          city: address?.city || address?.cityDetails?.nameEn || "",
          cityId: address?.cityId || null,
          area: address?.area || address?.areaDetails?.nameEn || "",
          landmark: address?.landmark || "",
          customerNotes: "",
        };

    return this.toPublicPayload(recipient, campaign, extras);
  }

  async submit(token: string, dto: PublicCampaignOrderSubmitDto) {
    return this.dataSource.transaction(async (manager) => {
      const recipient = await manager
        .createQueryBuilder(CampaignRecipientEntity, "recipient")
        .setLock("pessimistic_write")
        .where('recipient."accessToken" = :token', { token })
        .getOne();
      if (!recipient) {
        throw new NotFoundException(
          this.translations.t("domains.campaigns.order_link_unavailable"),
        );
      }
      if (recipient.orderId) {
        throw new ConflictException(
          this.translations.t("domains.campaigns.order_link_already_used"),
        );
      }

      const campaign = await manager.findOne(CampaignEntity, {
        where: { id: recipient.campaignId },
        relations: { products: true },
      });
      if (!campaign?.enablePurchasePage) {
        throw new NotFoundException(
          this.translations.t("domains.campaigns.order_link_unavailable"),
        );
      }
      const products = (campaign.products || []).filter((p) => p.variantId);
      if (!products.length) {
        throw new NotFoundException(
          this.translations.t("domains.campaigns.order_link_unavailable"),
        );
      }

      const adminId = recipient.adminId;
      let confirmed;
      try {
        confirmed = await this.ordersService.findStatusByCode(
          OrderStatus.CONFIRMED,
          adminId,
          manager,
        );
      } catch {
        throw new NotFoundException(
          this.translations.t("domains.campaigns.confirmed_status_missing"),
        );
      }
      if (!confirmed) {
        throw new NotFoundException(
          this.translations.t("domains.campaigns.confirmed_status_missing"),
        );
      }

      const me = { id: adminId, adminId };
      const order = await this.ordersService.createWithManager(
        manager,
        adminId,
        me,
        {
          customerName: dto.customerName,
          phoneNumber: recipient.phoneNumber,
          clientId: recipient.clientId || undefined,
          address: dto.address,
          city: dto.city,
          cityId: dto.cityId,
          area: dto.area,
          areaId: dto.areaId,
          landmark: dto.landmark,
          customerNotes: dto.customerNotes,
          paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
          shippingCost: Number(campaign.shippingPrice ?? 0),
          discount: 0,
          items: products.map((p) => ({
            variantId: p.variantId as string,
            quantity: Number(p.quantity || 1),
            unitPrice: Number(p.price || 0),
          })),
        } as any,
        undefined,
        {
          statusCode: OrderStatus.CONFIRMED,
          campaignId: campaign.id,
          skipDuplicateAutoCancel: true,
          markConfirmed: true,
        },
      );

      recipient.orderId = order.id;
      await manager.save(CampaignRecipientEntity, recipient);
      await manager.increment(CampaignEntity, { id: campaign.id }, "ordersCount", 1);
      await manager.query(
        `UPDATE campaigns SET "salesAmount" = COALESCE("salesAmount", 0) + $2, "updatedAt" = NOW() WHERE id = $1`,
        [campaign.id, Number(order.finalTotal || 0)],
      );

      return this.toPublicPayload(recipient, campaign, {
        alreadyOrdered: true,
        orderNumber: order.orderNumber,
        customerName: dto.customerName,
        phoneNumber: recipient.phoneNumber,
        address: dto.address,
        city: dto.city,
        cityId: dto.cityId || null,
        area: dto.area || "",
        landmark: dto.landmark || "",
        customerNotes: dto.customerNotes || "",
      });
    });
  }

  private toPublicPayload(
    recipient: CampaignRecipientEntity,
    campaign: CampaignEntity,
    extras: {
      alreadyOrdered: boolean;
      orderNumber?: string | null;
      customerName: string;
      phoneNumber: string;
      address: string;
      city: string;
      cityId: string | null;
      area: string;
      landmark: string;
      customerNotes?: string;
    },
  ) {
    const products = (campaign.products || []).map((p: CampaignProductEntity) => ({
      name: p.name,
      sku: p.sku,
      image: p.image,
      quantity: Number(p.quantity || 1),
      price: Number(p.price || 0),
    }));
    const itemsTotal = products.reduce(
      (sum, p) => sum + p.price * p.quantity,
      0,
    );
    const shipping = Number(campaign.shippingPrice ?? 0);
    return {
      alreadyOrdered: extras.alreadyOrdered,
      orderNumber: extras.orderNumber || null,
      customerName: extras.customerName,
      phoneNumber: extras.phoneNumber,
      address: extras.address,
      city: extras.city,
      cityId: extras.cityId,
      area: extras.area,
      landmark: extras.landmark,
      customerNotes: extras.customerNotes || "",
      shippingPrice: shipping,
      products,
      total: Math.max(0, itemsTotal + shipping),
    };
  }
}
