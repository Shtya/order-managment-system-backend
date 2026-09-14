import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProductionAutomationAdapter } from "./production.adapters";

vi.mock("src/stores/storesIntegrations/BaseStoreProvider", () => ({
  BaseStoreProvider: class BaseStoreProvider {},
  WebhookOrderPayload: {},
}));

vi.mock("src/orders/services/orders.service", () => ({
  OrdersService: class OrdersService {},
}));

vi.mock("src/whatsapp/services/WhatsappApi.service", () => ({
  WhatsappApiService: class WhatsappApiService {},
}));

vi.mock("src/whatsapp/whatsapp.service", () => ({
  WhatsappService: class WhatsappService {},
}));

vi.mock("src/upsells/upsells.service", () => ({
  UpsellsService: class UpsellsService {},
}));

vi.mock("src/order-assignment/order-assignment.service", () => ({
  OrderAssignmentService: class OrderAssignmentService {},
}));

vi.mock("src/sms/sms.service", () => ({
  SmsService: class SmsService {},
}));

vi.mock("src/issue/issue.service", () => ({
  IssueService: class IssueService {},
}));

vi.mock("src/shipping/shipping.service", () => ({
  ShippingService: class ShippingService {},
}));

vi.mock("src/clients/clients.service", () => ({
  ClientService: class ClientService {},
}));

vi.mock("common/redis/RedisService", () => ({
  RedisService: class RedisService {},
}));

const USER = { adminId: "admin-1", id: "user-1" };
const PHONE = "01001234567";

function buildOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    adminId: "admin-1",
    phoneNumber: PHONE,
    customerName: "Ada",
    email: "ada@example.com",
    clientId: null,
    ...overrides,
  };
}

void ProductionAutomationAdapter.prototype.attachOrderToClient;
describe("ProductionAutomationAdapter", () => {
  describe("attachOrderToClient", () => {
    let adapter: ProductionAutomationAdapter;
    let redisSet: ReturnType<typeof vi.fn>;
    let redisGet: ReturnType<typeof vi.fn>;
    let redisDel: ReturnType<typeof vi.fn>;
    let findClientIdByPhone: ReturnType<typeof vi.fn>;
    let createClient: ReturnType<typeof vi.fn>;
    let updateOrder: ReturnType<typeof vi.fn>;
    let lockToken: string | undefined;

    beforeEach(() => {
      lockToken = undefined;
      redisSet = vi.fn(async (_key: string, token: string) => {
        lockToken = token;
        return "OK";
      });
      redisGet = vi.fn(async () => lockToken);
      redisDel = vi.fn(async () => 1);
      findClientIdByPhone = vi.fn().mockResolvedValue(null);
      createClient = vi.fn(async () => ({ id: "client-1" }));
      updateOrder = vi.fn(async () => ({}));

      adapter = new ProductionAutomationAdapter(
        { update: updateOrder } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { findClientIdByPhone, create: createClient } as never,
        { redisClient: { set: redisSet, get: redisGet, del: redisDel } } as never,
      );
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    test("skips when phone number is missing", async () => {
      const result = await adapter.attachOrderToClient(
        USER,
        buildOrder({ phoneNumber: "  " }) as never,
        {},
      );

      expect(result).toEqual({
        success: true,
        skipped: true,
        reason: "Missing phone number",
        clientId: null,
      });
      expect(redisSet).not.toHaveBeenCalled();
    });

    test("preserves linked client when phone number is missing", async () => {
      const result = await adapter.attachOrderToClient(
        USER,
        buildOrder({ phoneNumber: null, clientId: "client-9" }) as never,
        {},
      );

      expect(result).toMatchObject({ skipped: true, clientId: "client-9" });
    });

    test("skips when no client is found without creation", async () => {
      const result = await adapter.attachOrderToClient(
        USER,
        buildOrder() as never,
        {},
      );

      expect(result).toEqual({
        success: true,
        skipped: true,
        reason: "No client found",
        clientId: null,
        clientCreated: false,
      });
      expect(createClient).not.toHaveBeenCalled();
      expect(updateOrder).not.toHaveBeenCalled();
    });

    test("creates a client when missing with creation enabled", async () => {
      const result = await adapter.attachOrderToClient(
        USER,
        buildOrder() as never,
        { createIfMissing: true },
      );

      expect(createClient).toHaveBeenCalledTimes(1);
      expect(createClient).toHaveBeenCalledWith(
        { id: "admin-1", adminId: "admin-1", role: { name: "admin" } },
        {
          name: "Ada",
          email: "ada@example.com",
          contacts: [{ phoneNumber: PHONE, isPrimary: true }],
        },
      );
      expect(result).toEqual({
        success: true,
        clientId: "client-1",
        clientCreated: true,
      });
    });

    test("falls back to phone number when customer name is missing", async () => {
      await adapter.attachOrderToClient(
        USER,
        buildOrder({ customerName: "  " }) as never,
        { createIfMissing: true },
      );

      const [, dto] = createClient.mock.calls[0] as [unknown, { name: string }];
      expect(dto.name).toBe(PHONE);
    });

    test("skips when order is already linked to this client", async () => {
      findClientIdByPhone.mockResolvedValue("client-1");

      const result = await adapter.attachOrderToClient(
        USER,
        buildOrder({ clientId: "client-1" }) as never,
        {},
      );

      expect(result).toMatchObject({
        success: true,
        skipped: true,
        clientId: "client-1",
      });
      expect(updateOrder).not.toHaveBeenCalled();
    });

    test("fails when order is linked to a different client", async () => {
      findClientIdByPhone.mockResolvedValue("client-1");

      const result = await adapter.attachOrderToClient(
        USER,
        buildOrder({ clientId: "client-9" }) as never,
        {},
      );

      expect(result).toEqual({
        success: false,
        error: "Order already linked to a different client",
      });
      expect(updateOrder).not.toHaveBeenCalled();
    });

    test("links order to the found client", async () => {
      findClientIdByPhone.mockResolvedValue("client-1");

      const result = await adapter.attachOrderToClient(
        USER,
        buildOrder() as never,
        {},
      );

      expect(updateOrder).toHaveBeenCalledWith(
        { id: "admin-1", adminId: "admin-1", role: { name: "admin" } },
        "order-1",
        { clientId: "client-1" },
      );
      expect(result).toEqual({
        success: true,
        clientId: "client-1",
        clientCreated: false,
      });
    });

    test("uses user admin id when order has none", async () => {
      findClientIdByPhone.mockResolvedValue("client-1");

      await adapter.attachOrderToClient(
        { adminId: "admin-9", id: "user-9" },
        buildOrder({ adminId: null }) as never,
        {},
      );

      expect(redisSet).toHaveBeenCalledWith(
        `client:create:admin-9:${PHONE}`,
        expect.any(String),
        "EX",
        30,
        "NX",
      );
      expect(findClientIdByPhone).toHaveBeenCalledWith("admin-9", PHONE);
    });

    test("releases the lock after success", async () => {
      findClientIdByPhone.mockResolvedValue("client-1");

      await adapter.attachOrderToClient(USER, buildOrder() as never, {});

      expect(redisDel).toHaveBeenCalledWith(`client:create:admin-1:${PHONE}`);
    });

    test("keeps a foreign lock when token mismatches", async () => {
      findClientIdByPhone.mockResolvedValue("client-1");
      redisGet.mockResolvedValue("someone-else-token");

      await adapter.attachOrderToClient(USER, buildOrder() as never, {});

      expect(redisDel).not.toHaveBeenCalled();
    });

    test("retries lock acquisition when busy", async () => {
      findClientIdByPhone.mockResolvedValue("client-1");
      redisSet
        .mockResolvedValueOnce(null)
        .mockImplementation(async (_key: string, token: string) => {
          lockToken = token;
          return "OK";
        });

      const result = await adapter.attachOrderToClient(
        USER,
        buildOrder() as never,
        {},
      );

      expect(redisSet).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ success: true, clientId: "client-1" });
    });

    test("times out when the lock never frees", async () => {
      vi.useFakeTimers();
      redisSet.mockResolvedValue(null);

      const pending = adapter.attachOrderToClient(
        USER,
        buildOrder() as never,
        {},
      );
      await vi.advanceTimersByTimeAsync(21_000);
      const result = await pending;

      expect(result).toEqual({
        success: false,
        error: "Timed out waiting to attach order to client",
      });
    });
  });
});
