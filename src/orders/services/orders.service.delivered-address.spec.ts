import { describe, expect, test, vi } from "vitest";

vi.mock("common/healpers", () => ({
  generateRandomAlphanumeric: vi.fn(),
  isSuperAdmin: vi.fn().mockReturnValue(false),
}));
vi.mock("entities/order.entity", () => ({
  OrderEntity: class {},
  OrderItemEntity: class {},
  OrderStatusHistoryEntity: class {},
  OrderMessageEntity: class {},
  OrderStatusEntity: class {},
  OrderReplacementEntity: class {},
  OrderReplacementItemEntity: class {},
  OrderScanLogEntity: class {},
  ShipmentManifestEntity: class {},
  OrderActionLogEntity: class {},
  ReturnRequestEntity: class {},
  OrderStatus: {
    DELIVERED: "delivered",
    RETURNED: "returned",
    PARTIALLY_RETURNED: "partially_returned",
  },
  PaymentStatus: {},
  OrderStatusPercentFrom: {},
  OrderConfirmationSource: {},
  PaymentMethod: {},
  ScanReason: {},
  ScanLogType: {},
  OrderActionType: {},
  OrderActionResult: {},
  ShipmentManifestType: {},
  ReturnRequestStatus: {},
  DamageResponsibility: {},
  slugify: (value: string) => value,
}));
vi.mock("entities/clients.entity", () => ({
  ClientAddressEntity: class {},
  ClientEntity: class {},
}));
vi.mock("entities/assignment.entity", () => ({ OrderAssignmentEntity: class {} }));
vi.mock("entities/sku.entity", () => ({ ProductEntity: class {}, ProductVariantEntity: class {} }));
vi.mock("entities/user.entity", () => ({ User: class {} }));
vi.mock("entities/notifications.entity", () => ({ NotificationType: {} }));
vi.mock("entities/stores.entity", () => ({ StoreEntity: class {} }));
vi.mock("entities/shipping.entity", () => ({
  ShipmentEntity: class {},
  ShippingCompanyEntity: class {},
  ShippingIntegrationEntity: class {},
  ShipmentStatus: {},
  UnifiedShippingStatus: {},
}));
vi.mock("entities/plans.entity", () => ({ BulkUploadUsage: class {}, SubscriptionStatus: {} }));
vi.mock("entities/cities.entity", () => ({ AreaEntity: class {}, CityEntity: class {} }));
vi.mock("entities/issue.entity", () => ({ IssueEntity: class {}, IssueStatus: {} }));
vi.mock("entities/automation.entity", () => ({ TriggerEntityType: {}, TriggerType: {} }));
vi.mock("entities/clientSettings.entity", () => ({
  ClientSettingsEntity: class {},
  OrderFlowPath: {},
  StockDeductionStrategy: {},
}));
vi.mock("entities/getting-started.entity", () => ({ GettingStartedAchievementType: {} }));
vi.mock("entities/customers.entity", () => ({ CustomerEntity: class {} }));
vi.mock("dto/order.dto", () => ({}));
vi.mock("common/translation.service", () => ({
  TranslationService: class {},
  RequestTranslationService: class {},
}));
vi.mock("src/wallet/wallet.service", () => ({ WalletService: class {} }));
vi.mock("src/notifications/notification.service", () => ({ NotificationService: class {} }));
vi.mock("src/stores/stores.service", () => ({ StoresService: class {} }));
vi.mock("src/shipping/shipping.service", () => ({ ShippingService: class {} }));
vi.mock("src/queue/queues/order-sync.queue", () => ({ OrderSyncQueueService: class {} }));
vi.mock("src/order-assignment/order-assignment.service", () => ({ OrderAssignmentService: class {} }));
vi.mock("src/queue/queues/auto-assignment.queue", () => ({ AutoAssignmentQueueService: class {} }));
vi.mock("src/automation/engine/triggerDispatcher.service", () => ({ TriggerDispatcherService: class {} }));
vi.mock("src/client-settings/client-settings.service", () => ({ ClientSettingsService: class {} }));
vi.mock("src/queue/queues/onboarding-achievement.queue", () => ({ OnboardingAchievementService: class {} }));
vi.mock("src/cancel-causes/cancel-causes.service", () => ({ CancelCausesService: class {} }));
vi.mock("src/tags/tag-automation.evaluator", () => ({ TagAutomationEvaluator: class {} }));
vi.mock("src/clients/client-order-stats.service", () => ({
  applyThinClientOrderStats: vi.fn(),
  ClientOrderStatsService: class {},
}));

import { ClientAddressEntity, ClientEntity } from "entities/clients.entity";
import { AreaEntity } from "entities/cities.entity";
import {
  OrderEntity,
  OrderStatus,
  OrderStatusEntity,
  OrderStatusHistoryEntity,
} from "entities/order.entity";
import { ShippingCompanyEntity } from "entities/shipping.entity";
import { OrdersService } from "./orders.service";

function queryBuilder(result: any[]) {
  const builder: any = {
    getRawMany: vi.fn().mockResolvedValue(result),
    getMany: vi.fn().mockResolvedValue(result),
  };
  builder.innerJoin = vi.fn(() => builder);
  builder.select = vi.fn(() => builder);
  builder.where = vi.fn(() => builder);
  builder.andWhere = vi.fn(() => builder);
  builder.orWhere = vi.fn(() => builder);
  builder.orderBy = vi.fn(() => builder);
  builder.setLock = vi.fn(() => builder);
  return builder;
}

function createFixture(options?: {
  statusCode?: string;
  previousDelivery?: boolean;
  existingAddresses?: any[];
  clientId?: string | null;
  address?: string;
  areaId?: string | null;
  areaRows?: any[];
  shippingCompanyId?: string | null;
  shippingCompanyCode?: string | null;
  shippingMetadata?: Record<string, string> | null;
}) {
  const statusId = "10000000-0000-4000-8000-000000000001";
  const orderId = "20000000-0000-4000-8000-000000000001";
  const clientId = options?.clientId === undefined
    ? "30000000-0000-4000-8000-000000000001"
    : options.clientId;
  const save = vi.fn().mockResolvedValue([]);
  const historyQb = queryBuilder(
    options?.previousDelivery ? [{ orderId }] : [],
  );
  const clientQb = queryBuilder(clientId ? [{ id: clientId }] : []);
  const repositories = new Map<any, any>([
    [
      OrderStatusEntity,
      {
        findOne: vi.fn().mockResolvedValue(
          options?.statusCode === "other"
            ? null
            : { id: statusId, code: OrderStatus.DELIVERED },
        ),
      },
    ],
    [OrderStatusHistoryEntity, { createQueryBuilder: () => historyQb }],
    [
      OrderEntity,
      {
        find: vi.fn().mockResolvedValue(
          clientId
            ? [{
                id: orderId,
                adminId: "admin-1",
                clientId,
                address: options?.address ?? "  10 Main   Street ",
                city: " Cairo ",
                cityId: null,
                area: " Nasr City ",
                areaId: options?.areaId ?? null,
                landmark: "Mall",
                shippingCompanyId: options?.shippingCompanyId ?? null,
                shippingMetadata: options?.shippingMetadata ?? null,
                deliveredAt: new Date("2026-01-02T00:00:00.000Z"),
                updated_at: new Date("2026-01-01T00:00:00.000Z"),
              }]
            : [],
        ),
      },
    ],
    [ClientEntity, { createQueryBuilder: () => clientQb }],
    [
      AreaEntity,
      {
        find: vi.fn().mockResolvedValue(
          (options?.areaRows ?? []).filter((area) =>
            options?.areaId ? area.id === options.areaId : true,
          ),
        ),
        createQueryBuilder: () => queryBuilder(options?.areaRows ?? []),
      },
    ],
    [
      ClientAddressEntity,
      {
        find: vi.fn().mockResolvedValue(options?.existingAddresses ?? []),
        create: vi.fn((value) => value),
        save,
      },
    ],
    [
      ShippingCompanyEntity,
      {
        find: vi.fn().mockResolvedValue(
          options?.shippingCompanyId
            ? [{
                id: options.shippingCompanyId,
                code: options.shippingCompanyCode ?? "bosta",
              }]
            : [],
        ),
      },
    ],
  ]);
  const manager = {
    getRepository: (entity: any) => repositories.get(entity),
  };
  const service = Object.create(OrdersService.prototype) as OrdersService;

  return { service, manager, save, statusId, orderId, clientId, clientQb };
}

describe("OrdersService delivered client address synchronization", () => {
  test("copies a normalized address on the first delivered transition", async () => {
    const fixture = createFixture();

    await (fixture.service as any).copyFirstDeliveredAddresses({
      adminId: "admin-1",
      changes: [{ orderId: fixture.orderId, toStatusId: fixture.statusId }],
      manager: fixture.manager,
    });

    expect(fixture.clientQb.setLock).toHaveBeenCalledWith("pessimistic_write");
    expect(fixture.save).toHaveBeenCalledWith([
      expect.objectContaining({
        adminId: "admin-1",
        clientId: fixture.clientId,
        address: "10 Main Street",
        city: "Cairo",
        area: "Nasr City",
        areaId: null,
        isDefault: false,
      }),
    ]);
  });

  test("does not copy an address after a previous delivered transition", async () => {
    const fixture = createFixture({ previousDelivery: true });

    await (fixture.service as any).copyFirstDeliveredAddresses({
      adminId: "admin-1",
      changes: [{ orderId: fixture.orderId, toStatusId: fixture.statusId }],
      manager: fixture.manager,
    });

    expect(fixture.save).not.toHaveBeenCalled();
  });

  test("does not duplicate an equivalent saved client address", async () => {
    const fixture = createFixture({
      existingAddresses: [{
        clientId: "30000000-0000-4000-8000-000000000001",
        address: "10 main street",
        city: "cairo",
        area: "nasr   city",
      }],
    });

    await (fixture.service as any).copyFirstDeliveredAddresses({
      adminId: "admin-1",
      changes: [{ orderId: fixture.orderId, toStatusId: fixture.statusId }],
      manager: fixture.manager,
    });

    expect(fixture.save).not.toHaveBeenCalled();
  });

  test("uses the order area id to resolve the saved area", async () => {
    const areaId = "40000000-0000-4000-8000-000000000001";
    const fixture = createFixture({
      areaId,
      areaRows: [{
        id: areaId,
        cityId: null,
        nameEn: "Nasr City",
        nameAr: "مدينة نصر",
      }],
    });

    await (fixture.service as any).copyFirstDeliveredAddresses({
      adminId: "admin-1",
      changes: [{ orderId: fixture.orderId, toStatusId: fixture.statusId }],
      manager: fixture.manager,
    });

    expect(fixture.save).toHaveBeenCalledWith([
      expect.objectContaining({ areaId, area: "مدينة نصر" }),
    ]);
  });

  test("resolves an area by name when the order has no area id", async () => {
    const areaId = "40000000-0000-4000-8000-000000000002";
    const fixture = createFixture({
      areaRows: [{
        id: areaId,
        cityId: null,
        nameEn: "Nasr City",
        nameAr: "مدينة نصر",
      }],
    });

    await (fixture.service as any).copyFirstDeliveredAddresses({
      adminId: "admin-1",
      changes: [{ orderId: fixture.orderId, toStatusId: fixture.statusId }],
      manager: fixture.manager,
    });

    expect(fixture.save).toHaveBeenCalledWith([
      expect.objectContaining({ areaId, area: "مدينة نصر" }),
    ]);
  });

  test("copies bosta geo metadata on first delivery", async () => {
    const shippingCompanyId = "50000000-0000-4000-8000-000000000001";
    const fixture = createFixture({
      shippingCompanyId,
      shippingCompanyCode: "bosta",
      shippingMetadata: {
        cityId: "prov-city-1",
        zoneId: "zone-1",
        districtId: "dist-1",
      },
      areaRows: [{
        id: "40000000-0000-4000-8000-000000000099",
        cityId: null,
        nameEn: "Nasr City",
        nameAr: "مدينة نصر",
      }],
    });

    await (fixture.service as any).copyFirstDeliveredAddresses({
      adminId: "admin-1",
      changes: [{ orderId: fixture.orderId, toStatusId: fixture.statusId }],
      manager: fixture.manager,
    });

    expect(fixture.save).toHaveBeenCalledWith([
      expect.objectContaining({
        shippingProvider: "bosta",
        areaId: null,
        shippingMetadata: {
          cityId: "prov-city-1",
          zoneId: "zone-1",
          districtId: "dist-1",
        },
      }),
    ]);
  });

  test("does not treat a system address as a duplicate of a bosta address", async () => {
    const shippingCompanyId = "50000000-0000-4000-8000-000000000002";
    const fixture = createFixture({
      shippingCompanyId,
      shippingCompanyCode: "bosta",
      shippingMetadata: {
        cityId: "prov-city-1",
        districtId: "dist-1",
      },
      existingAddresses: [{
        clientId: "30000000-0000-4000-8000-000000000001",
        address: "10 main street",
        city: "cairo",
        area: "nasr city",
        shippingProvider: null,
        shippingMetadata: null,
      }],
    });

    await (fixture.service as any).copyFirstDeliveredAddresses({
      adminId: "admin-1",
      changes: [{ orderId: fixture.orderId, toStatusId: fixture.statusId }],
      manager: fixture.manager,
    });

    expect(fixture.save).toHaveBeenCalledWith([
      expect.objectContaining({ shippingProvider: "bosta" }),
    ]);
  });

  test("ignores non-delivered destinations", async () => {
    const fixture = createFixture({ statusCode: "other" });

    await (fixture.service as any).copyFirstDeliveredAddresses({
      adminId: "admin-1",
      changes: [{ orderId: fixture.orderId, toStatusId: fixture.statusId }],
      manager: fixture.manager,
    });

    expect(fixture.save).not.toHaveBeenCalled();
  });
});
