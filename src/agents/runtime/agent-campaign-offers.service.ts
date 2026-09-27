import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { CampaignRecipientEntity } from "entities/campaigns.entity";
import { OrderEntity } from "entities/order.entity";
import { normalizeEgyptianPhoneNumber } from "common/whatsapp";
import { PublicCampaignOrdersService } from "src/campaigns/public-campaign-orders.service";
import { AgentToolScope } from "./agent-runtime.constants";

const MAX_OFFERS = 5;

export type AgentCampaignOffer = {
  offerId: string;
  campaignName: string;
  status: "open" | "already_ordered" | "unavailable";
  orderNumber?: string | null;
  products?: Array<{ name: string; quantity: number; price: number }>;
  shipping?: number;
  total?: number;
  currency?: string;
  requiresCityAndArea?: boolean;
  savedCustomerData?: {
    customerName: string;
    address: string;
    city: string;
    area: string;
    landmark: string;
  };
};

@Injectable()
export class AgentCampaignOffersService {
  constructor(
    @InjectRepository(CampaignRecipientEntity)
    private readonly recipientRepo: Repository<CampaignRecipientEntity>,
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    @Inject(forwardRef(() => PublicCampaignOrdersService))
    private readonly publicOrders: PublicCampaignOrdersService,
  ) {}

  /** Offers this customer received (matched by customer id or phone number, never by model input). */
  async listForCustomer(scope: AgentToolScope): Promise<AgentCampaignOffer[]> {
    const recipients = await this.findRecipients(scope);
    return Promise.all(recipients.map((r) => this.describe(scope.adminId, r)));
  }

  async getOwnedRecipient(scope: AgentToolScope, offerId: string) {
    const recipients = await this.findRecipients(scope);
    return recipients.find((r) => r.id === offerId) ?? null;
  }

  async describe(adminId: string, recipient: CampaignRecipientEntity): Promise<AgentCampaignOffer> {
    const campaignName = recipient.campaign?.name ?? "";
    if (recipient.orderId) {
      const order = await this.orderRepo.findOne({
        where: { id: recipient.orderId, adminId },
        select: { id: true, orderNumber: true },
      });
      return {
        offerId: recipient.id,
        campaignName,
        status: "already_ordered",
        orderNumber: order?.orderNumber ?? null,
      };
    }
    if (!recipient.campaign?.enablePurchasePage) {
      return { offerId: recipient.id, campaignName, status: "unavailable" };
    }

    try {
      const [offer, branding] = await Promise.all([
        this.publicOrders.getForRecipient(adminId, recipient.id),
        this.publicOrders.getBrandingFor(adminId),
      ]);
      return {
        offerId: recipient.id,
        campaignName,
        status: offer.alreadyOrdered ? "already_ordered" : "open",
        orderNumber: offer.orderNumber,
        products: offer.products.map((p) => ({
          name: p.name,
          quantity: p.quantity,
          price: p.price,
        })),
        shipping: offer.shippingPrice,
        total: offer.total,
        currency: offer.currency,
        requiresCityAndArea: branding.collectCityArea !== false,
        savedCustomerData: {
          customerName: offer.customerName,
          address: offer.address,
          city: offer.city,
          area: offer.area,
          landmark: offer.landmark,
        },
      };
    } catch {
      return { offerId: recipient.id, campaignName, status: "unavailable" };
    }
  }

  private async findRecipients(scope: AgentToolScope): Promise<CampaignRecipientEntity[]> {
    const phones = Array.from(
      new Set([scope.phoneNumber, normalizeEgyptianPhoneNumber(scope.phoneNumber)].filter(Boolean)),
    );
    return this.recipientRepo
      .createQueryBuilder("recipient")
      .leftJoinAndSelect("recipient.campaign", "campaign")
      .where('recipient."adminId" = :adminId', { adminId: scope.adminId })
      .andWhere('recipient."accessToken" IS NOT NULL')
      .andWhere(
        '(recipient."customerId" = :customerId OR recipient."phoneNumber" IN (:...phones))',
        { customerId: scope.customerId, phones },
      )
      .orderBy("recipient.createdAt", "DESC")
      .take(MAX_OFFERS)
      .getMany();
  }
}
