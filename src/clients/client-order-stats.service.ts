import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ClientEntity } from "entities/clients.entity";
import { OrderEntity, OrderStatus } from "entities/order.entity";

export type ClientOrderStats = {
  totalOrders: number;
  confirmedCount: number;
  confirmedPercent: number;
  confirmedRate: number;
  totalSales: number;
  deliveredCount: number;
  deliveredPercent: number;
  postponedCount: number;
  deliveredRevenue: number;
  shippedCount: number;
  shippedPercent: number;
  returnedCount: number;
  returnedPercent: number;
  cancelledCount: number;
  cancelledBeforeShippingCount: number;
  cancelledAfterShippingCount: number;
  cancelRate: number;
  beforeShippingCancelRate: number;
  afterShippingCancelRate: number;
  afterShippingCancelRateOfShipped: number;
};

export function deriveLegacyConfirmedCount(
  totalOrders: number,
  confirmedRate: number,
): number {
  if (totalOrders <= 0 || confirmedRate <= 0) return 0;
  return Math.round((confirmedRate / 100) * totalOrders);
}

export function applyThinClientOrderStats(
  client: any,
  stats: ClientOrderStats,
) {
  if (!client) return;
  client.totalOrders = stats.totalOrders;
  client.confirmedCount = stats.confirmedCount;
  client.shippedCount = stats.shippedCount;
  client.deliveredCount = stats.deliveredCount;
  client.returnedCount = stats.returnedCount;
  client.totalSales = stats.totalSales;
  client.primaryNumber = client.primaryContact?.phoneNumber || null;
}

@Injectable()
export class ClientOrderStatsService {
  constructor(
    @InjectRepository(ClientEntity)
    private readonly clientRepo: Repository<ClientEntity>,
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
  ) { }

  async getOrderStatsSnapshot(
    adminId: string,
    clientId: string,
    client?: Pick<
      ClientEntity,
      | "legacyTotalOrders"
      | "legacyConfirmedCount"
      | "legacyConfirmedRate"
      | "legacyDeliveredCount"
      | "legacyReturnedCount"
      | "legacyCancelledCount"
      | "legacyTotalSales"
      | "legacyDeliveredRevenue"
    > | null,
  ): Promise<ClientOrderStats> {
    const [raw, clientRow] = await Promise.all([
      this.queryLiveStats(adminId, clientId),
      client
        ? Promise.resolve(client)
        : this.clientRepo.findOne({
          where: { id: clientId, adminId },
          select: {
            id: true,
            legacyTotalOrders: true,
            legacyConfirmedCount: true,
            legacyConfirmedRate: true,
            legacyDeliveredCount: true,
            legacyReturnedCount: true,
            legacyCancelledCount: true,
            legacyTotalSales: true,
            legacyDeliveredRevenue: true,
          },
        }),
    ]);

    return this.combine(raw, clientRow);
  }

  private async queryLiveStats(adminId: string, clientId: string) {
    return this.orderRepo
      .createQueryBuilder("ord")
      .leftJoin("ord.status", "status")
      .where("ord.adminId = :adminId", { adminId })
      .andWhere("ord.clientId = :clientId", { clientId })
      .select("COUNT(ord.id)", "totalOrders")
      .addSelect(
        "COUNT(CASE WHEN ord.isConfirmed = true THEN 1 END)",
        "allConfirmedCount",
      )
      .addSelect(
        `COUNT(CASE WHEN status.code = :confirmedCode THEN 1 END)`,
        "confirmedCount",
      )
      .addSelect("COALESCE(SUM(ord.finalTotal), 0)", "totalSales")
      .addSelect(
        `COUNT(CASE WHEN status.code = :deliveredCode THEN 1 END)`,
        "deliveredCount",
      )
      .addSelect(
        `COUNT(CASE WHEN status.code = :postponedCode THEN 1 END)`,
        "postponedCount",
      )
      .addSelect(
        `COALESCE(SUM(CASE WHEN status.code = :deliveredCode THEN ord.finalTotal ELSE 0 END), 0)`,
        "deliveredRevenue",
      )
      .addSelect(
        `COUNT(CASE WHEN status.code = :shippedCode THEN 1 END)`,
        "shippedCount",
      )
      .addSelect(
        `(SELECT COUNT(DISTINCT so.id)
            FROM orders so
            INNER JOIN shipments sh ON sh."orderId" = so.id
            WHERE so."clientId" = :clientId
              AND so."adminId" = :adminId
              AND so.deleted_at IS NULL
              AND sh."shippedAt" IS NOT NULL)`,
        "allShippedCount",
      )
      .addSelect(
        `COUNT(CASE WHEN status.code = :returnedCode THEN 1 END)`,
        "returnedCount",
      )
      .addSelect(
        `COUNT(CASE WHEN status.code IN ('${OrderStatus.CANCELLED}') THEN 1 END)`,
        "cancelledCount",
      )
      .addSelect(
        `COUNT(CASE WHEN status.code IN ('${OrderStatus.CANCELLED}') AND COALESCE((
            SELECT occ."cancelledAfterShipping"
            FROM order_cancel_causes occ
            WHERE occ."orderId" = ord.id
            ORDER BY occ.created_at DESC
            LIMIT 1
          ), ord."shippedAt" IS NOT NULL) = false THEN 1 END)`,
        "cancelledBeforeShippingCount",
      )
      .addSelect(
        `COUNT(CASE WHEN status.code IN ('${OrderStatus.CANCELLED}') AND COALESCE((
            SELECT occ."cancelledAfterShipping"
            FROM order_cancel_causes occ
            WHERE occ."orderId" = ord.id
            ORDER BY occ.created_at DESC
            LIMIT 1
          ), ord."shippedAt" IS NOT NULL) = true THEN 1 END)`,
        "cancelledAfterShippingCount",
      )
      .setParameter("deliveredCode", OrderStatus.DELIVERED)
      .setParameter("confirmedCode", OrderStatus.CONFIRMED)
      .setParameter("shippedCode", OrderStatus.SHIPPED)
      .setParameter("returnedCode", OrderStatus.RETURNED)
      .setParameter("postponedCode", OrderStatus.POSTPONED)
      .getRawOne();
  }

  private combine(raw: any, client?: Partial<ClientEntity> | null): ClientOrderStats {
    const liveTotalOrders = Number(raw?.totalOrders ?? 0);
    const liveAllConfirmedCount = Number(raw?.allConfirmedCount ?? 0);
    const liveConfirmedCount = Number(raw?.confirmedCount ?? 0);
    const liveShippedCount = Number(raw?.shippedCount ?? 0);
    const liveCancelledCount = Number(raw?.cancelledCount ?? 0);
    const liveAllShippedCount = Number(raw?.allShippedCount ?? 0);
    const liveCancelledBeforeShippingCount = Number(
      raw?.cancelledBeforeShippingCount ?? 0,
    );
    const liveCancelledAfterShippingCount = Number(
      raw?.cancelledAfterShippingCount ?? 0,
    );
    const liveDeliveredCount = Number(raw?.deliveredCount ?? 0);
    const liveReturnedCount = Number(raw?.returnedCount ?? 0);
    const liveTotalSales = Number(raw?.totalSales ?? 0);
    const liveDeliveredRevenue = Number(raw?.deliveredRevenue ?? 0);
    const livePostponedCount = Number(raw?.postponedCount ?? 0);

    const legacyTotalOrders = Number(client?.legacyTotalOrders ?? 0);
    const legacyConfirmedCount = Number(client?.legacyConfirmedCount ?? 0);
    const legacyDeliveredCount = Number(client?.legacyDeliveredCount ?? 0);
    const legacyReturnedCount = Number(client?.legacyReturnedCount ?? 0);
    const legacyCancelledCount = Number(client?.legacyCancelledCount ?? 0);
    const legacyTotalSales = Number(client?.legacyTotalSales ?? 0);
    const legacyDeliveredRevenue = Number(client?.legacyDeliveredRevenue ?? 0);

    const totalOrders = liveTotalOrders + legacyTotalOrders;
    const confirmedCount = liveConfirmedCount;
    const allConfirmedCount = liveAllConfirmedCount + legacyConfirmedCount;
    const shippedCount = liveShippedCount;
    const cancelledCount = liveCancelledCount + legacyCancelledCount;
    const deliveredCount = liveDeliveredCount + legacyDeliveredCount;
    const returnedCount = liveReturnedCount + legacyReturnedCount;
    const totalSales = liveTotalSales + legacyTotalSales;
    const deliveredRevenue = liveDeliveredRevenue + legacyDeliveredRevenue;

    const rate = (count: number, denominator: number) =>
      denominator > 0 ? Number(((count / denominator) * 100).toFixed(2)) : 0;

    return {
      totalOrders,
      confirmedCount,
      confirmedPercent: rate(confirmedCount, totalOrders),
      confirmedRate: rate(allConfirmedCount, totalOrders),
      totalSales,
      deliveredCount,
      deliveredPercent: rate(deliveredCount, totalOrders),
      postponedCount: livePostponedCount,
      deliveredRevenue,
      shippedCount,
      shippedPercent: rate(shippedCount, totalOrders),
      returnedCount,
      returnedPercent: rate(returnedCount, totalOrders),
      cancelledCount,
      cancelledBeforeShippingCount: liveCancelledBeforeShippingCount,
      cancelledAfterShippingCount: liveCancelledAfterShippingCount,
      cancelRate: rate(cancelledCount, totalOrders),
      beforeShippingCancelRate: rate(
        liveCancelledBeforeShippingCount,
        totalOrders,
      ),
      afterShippingCancelRate: rate(
        liveCancelledAfterShippingCount,
        totalOrders,
      ),
      afterShippingCancelRateOfShipped: rate(
        liveCancelledAfterShippingCount,
        liveAllShippedCount,
      ),
    };
  }
}
