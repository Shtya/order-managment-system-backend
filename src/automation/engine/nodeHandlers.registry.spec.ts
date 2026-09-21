import { NotFoundException } from "@nestjs/common";
import { Language } from "entities/clientSettings.entity";
import {
  OrderConfirmationSource,
  OrderEntity,
  OrderStatus,
} from "entities/order.entity";
import {
  MessageActionIntent,
  MessageStatus,
  TemplateStatus,
} from "entities/whatsapp.entity";
import { SmsSendStatus } from "entities/sms.entity";
import { SystemRole } from "entities/user.entity";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  ActionAssignOrderToClientHandler,
  ActionAssignOrderToEmployeeHandler,
  ActionAssignShippingProviderHandler,
  ActionCreateIssueHandler,
  ActionSendSmsHandler,
  ActionSendUpsellHandler,
  ActionSendWhatsappMessageHandler,
  ActionSendWhatsappTemplateMessageHandler,
  ActionUpdateOrderStatusHandler,
  ActionWaitHandler,
  checkMessageStatus,
  computeOffsetDate,
  ConditionOrderCheckHandler,
  ConditionAiAddressCompletenessHandler,
  ConditionQuickOrderStatusHandler,
  FlowNodeHandler,
  formatDateWithFormat,
  GlobalContext,
  loadGlobalData,
  NodeHandlerResponse,
  resolveGlobalVariablePath,
  shouldUseSpecialShippingCompany,
} from "./nodeHandlers.registry";

vi.mock("src/stores/storesIntegrations/BaseStoreProvider", () => ({
  BaseStoreProvider: class BaseStoreProvider { },
  WebhookOrderPayload: {},
}));

vi.mock("src/clients/clients.service", () => ({
  ClientService: class ClientService { },
}));

vi.mock("./adapters/production.adapters", () => ({
  ProductionAutomationAdapter: class ProductionAutomationAdapter { },
}));

vi.mock("src/orders/services/orders.service", () => ({
  OrdersService: class OrdersService { },
}));

vi.mock("src/whatsapp/whatsapp.service", () => ({
  WhatsappService: class WhatsappService { },
}));

vi.mock("src/client-settings/client-settings.service", () => ({
  ClientSettingsService: class ClientSettingsService { },
}));

vi.mock("src/queue/queues/automations.queue", () => ({
  AutomationQueueService: class AutomationQueueService { },
}));

vi.mock("src/ai/orchestrator/ai-orchestrator.service", () => ({
  AiOrchestratorService: class AiOrchestratorService { },
}));

vi.mock("src/ai/orchestrator/provider-selector.service", () => ({
  AiProviderSelectorService: class AiProviderSelectorService { },
}));

vi.mock("src/shipping-assigning/shipping-assigning.service", () => ({
  ShippingAssigningService: class ShippingAssigningService { },
}));

const realSetTimeout = globalThis.setTimeout.bind(globalThis);

// Automation handlers await a real 4s post-send wait. Firing those timers
// immediately keeps the suite in milliseconds instead of minutes.
function skipHandlerWaits() {
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    ms?: number,
  ) => {
    if (ms === 4000) {
      callback();
      return 0 as unknown as NodeJS.Timeout;
    }
    return realSetTimeout(callback, ms as number);
  }) as typeof setTimeout);
}

class TestHandler extends FlowNodeHandler {
  async execute(): Promise<NodeHandlerResponse> {
    return { success: true };
  }

  public replace(data: any, orderData: any, globalData?: GlobalContext) {
    return this.deepReplaceVariables(data, orderData, globalData);
  }
}

void FlowNodeHandler.prototype.getOrder;
describe("FlowNodeHandler", () => {
  describe("getOrder", () => {
    let handler: TestHandler;
    let findOne: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      findOne = vi.fn();

      handler = new TestHandler({ findOne } as never);
    });

    test("returns mocked order without repository call when mock flag is set", async () => {
      const mocked = { id: "order-1", __mock: true } as never;

      const result = await handler.getOrder(mocked);

      expect(result).toBe(mocked);
      expect(findOne).not.toHaveBeenCalled();
    });

    test("throws not-found when order id is missing", async () => {
      let thrown: unknown;
      try {
        await handler.getOrder({} as never);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(NotFoundException);
      expect((thrown as NotFoundException).message).toBe(
        "Order ID is required",
      );
    });

    test("throws not-found when order data is null", async () => {
      let thrown: unknown;
      try {
        await handler.getOrder(null as never);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(NotFoundException);
      expect((thrown as NotFoundException).message).toBe(
        "Order ID is required",
      );
    });

    test("throws error when repository is unavailable", async () => {
      const withoutRepo = new TestHandler(undefined as never);

      let thrown: unknown;
      try {
        await withoutRepo.getOrder({ id: "order-1" } as never);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(NotFoundException);
      expect((thrown as Error).message).toBe(
        "Order repository is not available",
      );
    });

    test("returns order from repository when found", async () => {
      const stored = { id: "order-1" } as OrderEntity;
      findOne.mockResolvedValue(stored);

      const result = await handler.getOrder({ id: "order-1" } as never);

      expect(result).toBe(stored);
      expect(findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "order-1" } }),
      );
    });

    test("throws not-found with id when repository returns nothing", async () => {
      findOne.mockResolvedValue(null);

      let thrown: unknown;
      try {
        await handler.getOrder({ id: "order-1" } as never);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(NotFoundException);
      expect((thrown as NotFoundException).message).toBe(
        "Order with ID order-1 not found",
      );
    });
  });

  void TestHandler.prototype.replace;
  describe("deepReplaceVariables", () => {
    let handler: TestHandler;

    beforeEach(() => {
      handler = new TestHandler({} as never);
    });

    test("replaces a single order placeholder with its value", () => {
      expect(handler.replace("Hello {{name}}", { name: "Ada" })).toBe(
        "Hello Ada",
      );
    });

    test("replaces a nested order path", () => {
      expect(
        handler.replace("Hello {{customer.name}}", {
          customer: { name: "Ada" },
        }),
      ).toBe("Hello Ada");
    });

    test("trims whitespace inside placeholders", () => {
      expect(handler.replace("Hello {{  name  }}", { name: "Ada" })).toBe(
        "Hello Ada",
      );
    });

    test("returns empty string when value is missing", () => {
      expect(handler.replace("Hello {{missing}}", { name: "Ada" })).toBe(
        "Hello ",
      );
    });

    test("returns empty string when value is null", () => {
      expect(handler.replace("Hello {{name}}", { name: null })).toBe("Hello ");
    });

    test("stringifies numeric values", () => {
      expect(
        handler.replace("Total {{finalTotal}}", { finalTotal: 150 }),
      ).toBe("Total 150");
    });

    test("formats Date values as day-month-year", () => {
      expect(
        handler.replace("{{createdAt}}", {
          createdAt: new Date(2026, 6, 22),
        }),
      ).toBe("22/07/2026");
    });

    test("formats date-like strings as day-month-year", () => {
      expect(
        handler.replace("{{createdAt}}", {
          createdAt: "2026-07-22T12:00:00",
        }),
      ).toBe("22/07/2026");
    });

    test("leaves strings without placeholders untouched", () => {
      expect(handler.replace("no variables here", { name: "Ada" })).toBe(
        "no variables here",
      );
    });

    test("resolves global values from context map", () => {
      expect(
        handler.replace("Welcome to {{global.brandName}}", { "brandName": "Ada" }, {
          values: { "global.brandName": "Acme" },
        } as unknown as GlobalContext),
      ).toBe("Welcome to Acme");
    });

    test("returns empty string for global path without context", () => {
      expect(
        handler.replace("Welcome to {{global.brandName}}", { name: "Ada" }),
      ).toBe("Welcome to ");
    });

    test("replaces placeholders inside nested objects", () => {
      expect(
        handler.replace(
          { body: { text: "Hi {{name}}" } },
          { name: "Ada" },
        ),
      ).toEqual({ body: { text: "Hi Ada" } });
    });

    test("maps placeholders inside arrays", () => {
      expect(handler.replace(["{{a}}", "x"], { a: "Ada" })).toEqual([
        "Ada",
        "x",
      ]);
    });

    test("returns primitive values unchanged", () => {
      expect(handler.replace(42, {})).toBe(42);
      expect(handler.replace(null, {})).toBeNull();
    });
  });
});


void formatDateWithFormat;
describe("formatDateWithFormat", () => {
  const wednesday = new Date(2026, 6, 22);

  test("formats DD-MM-YYYY", () => {
    expect(formatDateWithFormat(wednesday, "DD-MM-YYYY")).toBe("22-07-2026");
  });

  test("formats DD/MM/YYYY", () => {
    expect(formatDateWithFormat(wednesday, "DD/MM/YYYY")).toBe("22/07/2026");
  });

  test("formats YYYY-MM-DD", () => {
    expect(formatDateWithFormat(wednesday, "YYYY-MM-DD")).toBe("2026-07-22");
  });

  test("formats MM-DD-YYYY", () => {
    expect(formatDateWithFormat(wednesday, "MM-DD-YYYY")).toBe("07-22-2026");
  });

  test("formats DD.MM.YYYY", () => {
    expect(formatDateWithFormat(wednesday, "DD.MM.YYYY")).toBe("22.07.2026");
  });

  test("formats short weekday and month", () => {
    expect(
      formatDateWithFormat(wednesday, "WeekdayShort D MonthShort"),
    ).toBe("Wed 22 Jul");
  });

  test("formats weekday, day, and month", () => {
    expect(
      formatDateWithFormat(wednesday, "Weekday D Month"),
    ).toBe("Wednesday 22 July");
  });

  test("formats weekday, day, month, and year", () => {
    expect(
      formatDateWithFormat(wednesday, "Weekday D Month YYYY"),
    ).toBe("Wednesday 22 July 2026");
  });

  test("formats day and month", () => {
    expect(formatDateWithFormat(wednesday, "D Month")).toBe("22 July");
  });

  test("formats day, month, and year", () => {
    expect(formatDateWithFormat(wednesday, "D Month YYYY")).toBe(
      "22 July 2026",
    );
  });

  test("localizes weekday and month in Arabic", () => {
    expect(
      formatDateWithFormat(
        wednesday,
        "Weekday D Month YYYY",
        Language.AR,
      ),
    ).toBe("الأربعاء 22 يوليو 2026");
  });

  test("formats short weekday and month in Arabic", () => {
    expect(
      formatDateWithFormat(
        wednesday,
        "WeekdayShort D MonthShort",
        Language.AR,
      ),
    ).toBe("الأربعاء 22 يوليو");
  });

  test("uses English for unknown language", () => {
    expect(
      formatDateWithFormat(wednesday, "Weekday Month", "fr" as never),
    ).toBe("Wednesday July");
  });

  test("passes unknown characters through", () => {
    expect(
      formatDateWithFormat(wednesday, "this is a test ## DD.MM.YYYY !!"),
    ).toBe("this is a test ## 22.07.2026 !!");
  });
});

void computeOffsetDate;
describe("computeOffsetDate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 22, 12));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function dayParts(date: Date): [number, number, number] {
    return [date.getFullYear(), date.getMonth(), date.getDate()];
  }

  test("returns today for zero offset", () => {
    expect(dayParts(computeOffsetDate(0))).toEqual([2026, 6, 22]);
  });

  test("adds calendar days for positive offset", () => {
    expect(dayParts(computeOffsetDate(3))).toEqual([2026, 6, 25]);
  });

  test("subtracts calendar days for negative offset", () => {
    expect(dayParts(computeOffsetDate(-2))).toEqual([2026, 6, 20]);
  });

  test("counts weekends without exclusion", () => {
    expect(dayParts(computeOffsetDate(2))).toEqual([2026, 6, 24]);
  });

  test("skips weekends when excluded", () => {
    expect(dayParts(computeOffsetDate(2, true))).toEqual([2026, 6, 26]);
  });

  test("returns today for non-finite offset", () => {
    expect(dayParts(computeOffsetDate(NaN))).toEqual([2026, 6, 22]);
  });

  test("ignores weekend exclusion for past offsets", () => {
    expect(dayParts(computeOffsetDate(-3, true))).toEqual([2026, 6, 19]);
  });

  test("lands on Saturday for past offsets when excluded", () => {
    const result = computeOffsetDate(-4, true);

    expect(dayParts(result)).toEqual([2026, 6, 18]);
    expect(result.getDay()).toBe(6);
  });

  test("lands on Friday for past offsets when excluded", () => {
    const result = computeOffsetDate(-5, true);

    expect(dayParts(result)).toEqual([2026, 6, 17]);
    expect(result.getDay()).toBe(5);
  });

  test("crosses weekends with plain arithmetic for past offsets", () => {
    expect(dayParts(computeOffsetDate(-10, true))).toEqual([2026, 6, 12]);
  });
});

void resolveGlobalVariablePath;
describe("resolveGlobalVariablePath", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 22, 12));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function context(
    values: Record<string, string> = {},
    overrides: Partial<GlobalContext> = {},
  ): GlobalContext {
    return { values, lang: Language.EN, ...overrides };
  }

  test("reads pre-loaded values", () => {
    expect(
      resolveGlobalVariablePath(
        "global.brandName",
        context({ "global.brandName": "Acme" }),
      ),
    ).toBe("Acme");
  });

  test("returns empty string for unknown path", () => {
    expect(resolveGlobalVariablePath("global.unknown", context({}))).toBe("");
  });

  test("returns empty string without context", () => {
    expect(resolveGlobalVariablePath("global.brandName")).toBe("");
  });

  test("resolves today date path", () => {
    expect(
      resolveGlobalVariablePath("global.date.0.DD-MM-YYYY", context()),
    ).toBe("22-07-2026");
  });

  test("applies offset in date path", () => {
    expect(
      resolveGlobalVariablePath("global.date.1.DD-MM-YYYY", context()),
    ).toBe("23-07-2026");
  });

  test("localizes date names with admin language", () => {
    expect(
      resolveGlobalVariablePath(
        "global.date.0.Weekday D Month YYYY",
        context({}, { lang: Language.AR }),
      ),
    ).toBe("الأربعاء 22 يوليو 2026");
  });

  test("skips weekends in date path when excluded", () => {
    expect(
      resolveGlobalVariablePath(
        "global.date.2.DD-MM-YYYY",
        context({}, { excludeWeekends: true }),
      ),
    ).toBe("26-07-2026");
  });
});

void loadGlobalData;
describe("loadGlobalData", () => {
  let findOne: ReturnType<typeof vi.fn>;
  let getCachedSettings: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    findOne = vi.fn();
    getCachedSettings = vi.fn().mockResolvedValue({ defaultLang: "en" });
  });

  test("returns undefined without repositories", async () => {
    await expect(loadGlobalData()).resolves.toBeUndefined();
  });

  test("returns undefined without admin id", async () => {
    await expect(
      loadGlobalData({ findOne } as never, undefined, {
        getCachedSettings,
      } as never),
    ).resolves.toBeUndefined();
  });

  test("returns undefined when admin is missing", async () => {
    findOne.mockResolvedValue(null);

    const result = await loadGlobalData({ findOne } as never, "admin-1", {
      getCachedSettings,
    } as never);

    expect(result).toBeUndefined();
  });

  test("maps company fields with admin language", async () => {
    findOne.mockResolvedValue({
      id: "admin-1",
      name: "Ada",
      email: "ada@example.com",
      company: {
        name: "Acme",
        website: "https://acme.test",
        phone: "010",
        address: "Cairo",
        currency: "EGP",
      },
    });
    getCachedSettings.mockResolvedValue({ defaultLang: "ar" });

    const result = await loadGlobalData({ findOne } as never, "admin-1", {
      getCachedSettings,
    } as never);

    expect(result?.values).toEqual({
      "global.brandName": "Acme",
      "global.companyEmail": "ada@example.com",
      "global.companyWebsite": "https://acme.test",
      "global.companyPhone": "010",
      "global.companyAddress": "Cairo",
      "global.companyCurrency": "EGP",
    });
    expect(result?.lang).toBe("ar");
  });

  test("falls back to user name when company is missing", async () => {
    findOne.mockResolvedValue({
      id: "admin-1",
      name: "Ada",
      email: "ada@example.com",
    });

    const result = await loadGlobalData({ findOne } as never, "admin-1", {
      getCachedSettings,
    } as never);

    expect(result?.values?.["global.brandName"]).toBe("Ada");
  });

  test("falls back to English when settings lookup fails", async () => {
    findOne.mockResolvedValue({ id: "admin-1", name: "Ada" });
    getCachedSettings.mockRejectedValue(new Error("cache down"));

    const result = await loadGlobalData({ findOne } as never, "admin-1", {
      getCachedSettings,
    } as never);

    expect(result?.lang).toBe("en");
    expect(result?.values?.["global.brandName"]).toBe("Ada");
  });

  test("returns undefined when user lookup throws", async () => {
    findOne.mockRejectedValue(new Error("db down"));

    const result = await loadGlobalData({ findOne } as never, "admin-1", {
      getCachedSettings,
    } as never);

    expect(result).toBeUndefined();
  });
});

void checkMessageStatus;
describe("checkMessageStatus", () => {
  let findOne: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.fn>;
  let error: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    findOne = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  });

  function logger() {
    return { warn, error } as never;
  }

  test("warns without lookup when message id is missing", async () => {
    await checkMessageStatus("", { findOne } as never, logger());

    expect(warn).toHaveBeenCalledTimes(1);
    expect(findOne).not.toHaveBeenCalled();
  });

  test("warns when message is missing", async () => {
    findOne.mockResolvedValue(null);

    await checkMessageStatus("msg-1", { findOne } as never, logger());

    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("throws provider error when status is failed", async () => {
    findOne.mockResolvedValue({
      status: MessageStatus.FAILED,
      error: "no route",
    });

    await expect(
      checkMessageStatus("msg-1", { findOne } as never, logger()),
    ).rejects.toThrow("Failed to send WhatsApp message: no route");
  });

  test("uses default message when failed without error text", async () => {
    findOne.mockResolvedValue({ status: MessageStatus.FAILED, error: null });

    await expect(
      checkMessageStatus("msg-1", { findOne } as never, logger()),
    ).rejects.toThrow("Message sending failed");
  });

  test("stays silent for delivered messages", async () => {
    findOne.mockResolvedValue({ status: MessageStatus.DELIVERED });

    await checkMessageStatus("msg-1", { findOne } as never, logger());

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

void ConditionOrderCheckHandler.prototype.execute;
describe("ConditionOrderCheckHandler", () => {
  describe("execute", () => {
    let handler: ConditionOrderCheckHandler;
    let findOne: ReturnType<typeof vi.fn>;
    let isStockSufficientForOrder: ReturnType<typeof vi.fn>;
    let getOrderStatsSnapshot: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      findOne = vi.fn();
      isStockSufficientForOrder = vi.fn().mockResolvedValue(true);
      getOrderStatsSnapshot = vi.fn().mockResolvedValue({});

      handler = new ConditionOrderCheckHandler(
        { findOne } as never,
        { isStockSufficientForOrder } as never,
        { getOrderStatsSnapshot } as never,
      );
    });

    function check(field: string, operator: string, targetValue: unknown) {
      return { field, fieldLabel: field, operator, targetValue };
    }

    function runWith(output: unknown) {
      return { executionState: { trigger: { output } } } as never;
    }

    function mockOrder(overrides: Record<string, unknown> = {}) {
      return {
        id: "order-1",
        orderNumber: "A-1",
        __mock: true,
        ...overrides,
      } as never;
    }

    test("chooses true branch when all checks pass", async () => {
      const result = await handler.execute(
        { checks: [check("status", "==", "s-1")] } as never,
        runWith(mockOrder({ statusId: "s-1" })),
      );

      expect(result.success).toBe(true);
      expect(result.shouldPause).toBe(false);
      expect(result.chosenBranch).toBe("true");
      expect(result.output).toMatchObject({
        evaluatedChecksCount: 1,
        passed: true,
        orderId: "order-1",
        orderNumber: "A-1",
      });
    });

    test("chooses false branch when a check fails", async () => {
      const result = await handler.execute(
        { checks: [check("status", "==", "s-1")] } as never,
        runWith(mockOrder({ statusId: "s-2" })),
      );

      expect(result.success).toBe(true);
      expect(result.chosenBranch).toBe("false");
      expect(result.output).toMatchObject({ passed: false });
    });

    test("requires every check to pass", async () => {
      const result = await handler.execute(
        {
          checks: [
            check("status", "==", "s-1"),
            check("cityId", "==", "c-2"),
          ],
        } as never,
        runWith(mockOrder({ statusId: "s-1", cityId: "c-1" })),
      );

      expect(result.chosenBranch).toBe("false");
      expect(result.output).toMatchObject({
        evaluatedChecksCount: 2,
        passed: false,
      });
    });

    test("supports numeric operators on item count", async () => {
      const result = await handler.execute(
        { checks: [check("items_count", ">", 2)] } as never,
        runWith(mockOrder({ items: [{}, {}, {}] })),
      );

      expect(result.chosenBranch).toBe("true");
    });

    test("resolves client stats for client fields", async () => {
      findOne.mockResolvedValue({
        id: "order-1",
        orderNumber: "A-1",
        clientId: "client-1",
        adminId: "admin-1",
      });
      getOrderStatsSnapshot.mockResolvedValue({ orders: 5 });

      const result = await handler.execute(
        { checks: [check("client.orders", "==", 5)] } as never,
        runWith({ id: "order-1" }),
      );

      expect(getOrderStatsSnapshot).toHaveBeenCalledWith("admin-1", "client-1");
      expect(result.chosenBranch).toBe("true");
    });

    test("skips client stats lookup for preview orders", async () => {
      const result = await handler.execute(
        { checks: [check("client.orders", "==", 0)] } as never,
        runWith(
          mockOrder({ clientId: "client-1", adminId: "admin-1" }),
        ),
      );

      expect(getOrderStatsSnapshot).not.toHaveBeenCalled();
      expect(result.chosenBranch).toBe("true");
    });

    test("treats preview orders as in-stock without service call", async () => {
      const result = await handler.execute(
        { checks: [check("hasEnoughStock", "==", true)] } as never,
        runWith(mockOrder()),
      );

      expect(isStockSufficientForOrder).not.toHaveBeenCalled();
      expect(result.chosenBranch).toBe("true");
    });

    test("delegates stock check for real orders", async () => {
      findOne.mockResolvedValue({ id: "order-1", orderNumber: "A-1" });
      isStockSufficientForOrder.mockResolvedValue(false);

      const result = await handler.execute(
        { checks: [check("hasEnoughStock", "==", true)] } as never,
        runWith({ id: "order-1" }),
      );

      expect(isStockSufficientForOrder).toHaveBeenCalledTimes(1);
      expect(result.chosenBranch).toBe("false");
    });

    test("treats preview orders as having no active shipment", async () => {
      const result = await handler.execute(
        { checks: [check("hasActiveShipment", "==", false)] } as never,
        runWith(mockOrder()),
      );

      expect(findOne).not.toHaveBeenCalled();
      expect(result.chosenBranch).toBe("true");
    });

    test("detects an active shipment from its status", async () => {
      findOne.mockResolvedValue({
        id: "order-1",
        orderNumber: "A-1",
        shipments: [{ status: "out_for_delivery" }, { status: "delivered" }],
      });

      const result = await handler.execute(
        { checks: [check("hasActiveShipment", "==", true)] } as never,
        runWith({ id: "order-1" }),
      );

      expect(result.chosenBranch).toBe("true");
    });

    test("reports no active shipment when all are terminal", async () => {
      findOne.mockResolvedValue({
        id: "order-1",
        orderNumber: "A-1",
        shipments: [{ status: "delivered" }, { status: "cancelled" }],
      });

      const result = await handler.execute(
        { checks: [check("hasActiveShipment", "==", true)] } as never,
        runWith({ id: "order-1" }),
      );

      expect(result.chosenBranch).toBe("false");
    });

    test("reports no active shipment when the order has none", async () => {
      findOne.mockResolvedValue({ id: "order-1", orderNumber: "A-1" });

      const result = await handler.execute(
        { checks: [check("hasActiveShipment", "==", true)] } as never,
        runWith({ id: "order-1" }),
      );

      expect(result.chosenBranch).toBe("false");
    });

    test("wraps missing order data as evaluation failure", async () => {
      const result = await handler.execute(
        { checks: [check("status", "==", "s-1")] } as never,
        runWith({}),
      );

      expect(result.success).toBe(false);
      expect(result.shouldPause).toBe(false);
      expect(result.error).toBe(
        "Condition evaluation failed: Order ID is required",
      );
    });

    test("wraps repository errors as evaluation failure", async () => {
      findOne.mockRejectedValue(new Error("db down"));

      const result = await handler.execute(
        { checks: [check("status", "==", "s-1")] } as never,
        runWith({ id: "order-1" }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Condition evaluation failed: db down");
    });
  });
});

void ConditionAiAddressCompletenessHandler.prototype.execute;
describe("ConditionAiAddressCompletenessHandler", () => {
  describe("execute", () => {
    let handler: ConditionAiAddressCompletenessHandler;
    let findOne: ReturnType<typeof vi.fn>;
    let decide: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      findOne = vi.fn();
      decide = vi.fn();
      handler = new ConditionAiAddressCompletenessHandler(
        { findOne } as never,
        { decide } as never,
      );
    });

    function runWith(output: unknown, extras: Record<string, unknown> = {}) {
      return {
        id: "run-1",
        adminId: "admin-1",
        currentNodeId: "n-addr",
        executionState: { trigger: { output } },
        ...extras,
      } as never;
    }

    function mockOrder(overrides: Record<string, unknown> = {}) {
      return {
        id: "order-1",
        orderNumber: "A-1",
        __mock: true,
        city: "Cairo",
        area: "Nasr City",
        address: "12 Abbas El Akkad St, apt 7",
        ...overrides,
      } as never;
    }

    function jevAnswers(noul: number, choice: string) {
      return {
        answers: {
          address_valid: { type: "noul", noul },
          main_problem: { type: "choice", choice, confidence: 0.9, probabilities: {} },
        },
        modelVersion: "jev-1.13.0",
      };
    }

    test("chooses valid when score is high and main problem is none", async () => {
      decide.mockResolvedValue(jevAnswers(0.92, "none"));

      const result = await handler.execute({} as never, runWith(mockOrder()));

      expect(decide).toHaveBeenCalledWith(
        expect.objectContaining({
          me: expect.objectContaining({ id: "admin-1", adminId: "admin-1" }),
          idempotencyKey: "run-1:n-addr:address-completeness",
          model: "jev-1.13.0",
          note: "domains.automation.ai_address_completeness",
          state: {
            city: "Cairo",
            area: "Nasr City",
            address: "12 Abbas El Akkad St, apt 7",
          },
        }),
      );
      expect(result).toMatchObject({
        success: true,
        chosenBranch: "valid",
        output: {
          orderId: "order-1",
          problems: [],
        },
      });
      expect(result.output.main_problem).toBeUndefined();
      expect(result.output.answers).toBeUndefined();
    });

    test("exposes main_problem as problems, not the raw Jev choice object", async () => {
      decide.mockResolvedValue(jevAnswers(0.2, "missing_street"));

      const result = await handler.execute({} as never, runWith(mockOrder()));

      expect(result.chosenBranch).toBe("not_valid");
      expect(result.output.problems).toEqual(["missing_street"]);
      expect(result.output.main_problem).toBeUndefined();
    });

    test("chooses not_sure for mid-range scores", async () => {
      decide.mockResolvedValue(jevAnswers(0.7, "none"));

      const result = await handler.execute({} as never, runWith(mockOrder()));

      expect(result.chosenBranch).toBe("not_sure");
      expect(result.output.problems).toEqual([]);
    });

    test("wraps AI decision failures", async () => {
      decide.mockRejectedValue(new Error("wallet empty"));

      const result = await handler.execute({} as never, runWith(mockOrder()));

      expect(result.success).toBe(false);
      expect(result.error).toBe("wallet empty");
    });
  });
});

void ConditionQuickOrderStatusHandler.prototype.execute;
describe("ConditionQuickOrderStatusHandler", () => {
  describe("execute", () => {
    let handler: ConditionQuickOrderStatusHandler;
    let findOne: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      findOne = vi.fn();

      handler = new ConditionQuickOrderStatusHandler({ findOne } as never);
    });

    function runWith(output: unknown) {
      return { executionState: { trigger: { output } } } as never;
    }

    function mockOrder(overrides: Record<string, unknown> = {}) {
      return {
        id: "order-1",
        orderNumber: "A-1",
        __mock: true,
        statusId: "s-1",
        ...overrides,
      } as never;
    }

    test("chooses true branch when statuses match", async () => {
      const result = await handler.execute(
        { statusId: "s-1" } as never,
        runWith(mockOrder()),
      );

      expect(result.success).toBe(true);
      expect(result.shouldPause).toBe(false);
      expect(result.chosenBranch).toBe("true");
      expect(result.output).toMatchObject({
        orderId: "order-1",
        orderNumber: "A-1",
        currentStatusId: "s-1",
        targetStatusId: "s-1",
        matched: true,
      });
    });

    test("chooses false branch on mismatch", async () => {
      const result = await handler.execute(
        { statusId: "s-2" } as never,
        runWith(mockOrder()),
      );

      expect(result.success).toBe(true);
      expect(result.chosenBranch).toBe("false");
      expect(result.output).toMatchObject({ matched: false });
    });

    test("chooses false branch when target status is missing", async () => {
      const result = await handler.execute(
        {} as never,
        runWith(mockOrder()),
      );

      expect(result.chosenBranch).toBe("false");
      expect(result.output.matched).toBeFalsy();
    });

    test("chooses false branch when current status is missing", async () => {
      const result = await handler.execute(
        { statusId: "s-1" } as never,
        runWith(mockOrder({ statusId: null })),
      );

      expect(result.chosenBranch).toBe("false");
    });

    test("wraps errors as evaluation failure", async () => {
      const result = await handler.execute(
        { statusId: "s-1" } as never,
        runWith({}),
      );

      expect(result.success).toBe(false);
      expect(result.shouldPause).toBe(false);
      expect(result.error).toBe(
        "The order status condition could not be evaluated successfully.",
      );
    });
  });
});

void ActionUpdateOrderStatusHandler.prototype.execute;
describe("ActionUpdateOrderStatusHandler", () => {
  describe("execute", () => {
    let handler: ActionUpdateOrderStatusHandler;
    let findOne: ReturnType<typeof vi.fn>;
    let findStatusById: ReturnType<typeof vi.fn>;
    let changeStatus: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      findOne = vi.fn();
      findStatusById = vi.fn();
      changeStatus = vi.fn().mockResolvedValue(undefined);

      handler = new ActionUpdateOrderStatusHandler(
        { findStatusById, changeStatus } as never,
        { findOne } as never,
      );
    });

    function runWith(output: unknown) {
      return {
        executionState: { trigger: { output } },
        initialPayload: { adminId: "admin-1", userId: "user-1" },
      } as never;
    }

    function mockOrder(overrides: Record<string, unknown> = {}) {
      return {
        id: "order-1",
        orderNumber: "A-1",
        __mock: true,
        statusId: "s-old",
        adminId: "admin-1",
        ...overrides,
      } as never;
    }

    test("returns failure when status no longer exists", async () => {
      findStatusById.mockResolvedValue(null);

      const result = await handler.execute(
        { newStatusId: "s-new" } as never,
        runWith(mockOrder()),
      );

      expect(result.success).toBe(false);
      expect(result.shouldPause).toBe(false);
      expect(result.error).toBe(
        "The selected order status no longer exists or is unavailable.",
      );
      expect(changeStatus).not.toHaveBeenCalled();
    });

    test("skips update when order already has target status", async () => {
      findStatusById.mockResolvedValue({ id: "s-old", name: "Old" });

      const result = await handler.execute(
        { newStatusId: "s-old" } as never,
        runWith(mockOrder()),
      );

      expect(changeStatus).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.output).toMatchObject({
        skipped: true,
        orderId: "order-1",
        statusId: "s-old",
      });
    });

    test("delegates update with expected payload", async () => {
      findStatusById.mockResolvedValue({ id: "s-new", name: "Confirmed" });

      const result = await handler.execute(
        { newStatusId: "s-new" } as never,
        runWith(mockOrder()),
      );

      expect(changeStatus).toHaveBeenCalledWith(
        { adminId: "admin-1", id: "user-1" },
        "order-1",
        {
          statusId: "s-new",
          notes: "Updated automatically via automation",
          confirmationSource: OrderConfirmationSource.WHATSAPP,
        },
      );
      expect(result.success).toBe(true);
      expect(result.output).toMatchObject({
        orderId: "order-1",
        orderNumber: "A-1",
        previousStatusId: "s-old",
        newStatusId: "s-new",
        newStatusName: "Confirmed",
      });
    });

    test("includes cancel cause for cancelled status", async () => {
      findStatusById.mockResolvedValue({
        id: "s-x",
        name: "Cancelled",
        code: OrderStatus.CANCELLED,
      });

      await handler.execute(
        { newStatusId: "s-x", cancelCauseId: "cause-1" } as never,
        runWith(mockOrder()),
      );

      const [, , payload] = changeStatus.mock.calls[0] as [
        unknown,
        unknown,
        { cancelCauseId?: string },
      ];
      expect(payload.cancelCauseId).toBe("cause-1");
    });

    test("omits cancel cause for non-cancelled status", async () => {
      findStatusById.mockResolvedValue({
        id: "s-new",
        name: "Confirmed",
        code: OrderStatus.CONFIRMED,
      });

      await handler.execute(
        { newStatusId: "s-new", cancelCauseId: "cause-1" } as never,
        runWith(mockOrder()),
      );

      const [, , payload] = changeStatus.mock.calls[0] as [
        unknown,
        unknown,
        Record<string, unknown>,
      ];
      expect(payload).not.toHaveProperty("cancelCauseId");
    });

    test("wraps errors as update failure", async () => {
      findStatusById.mockResolvedValue({ id: "s-new", name: "Confirmed" });
      changeStatus.mockRejectedValue(new Error("db down"));

      const result = await handler.execute(
        { newStatusId: "s-new" } as never,
        runWith(mockOrder()),
      );

      expect(result.success).toBe(false);
      expect(result.shouldPause).toBe(false);
      expect(result.error).toBe(
        "The order status could not be updated successfully.",
      );
    });
  });
});

void shouldUseSpecialShippingCompany;
describe("shouldUseSpecialShippingCompany", () => {
  test("returns true when flag is true", () => {
    expect(
      shouldUseSpecialShippingCompany({
        useSpecialShippingCompany: true,
      } as never),
    ).toBe(true);
  });

  test("returns false when flag is false despite company id", () => {
    expect(
      shouldUseSpecialShippingCompany({
        useSpecialShippingCompany: false,
        shippingCompanyId: "c-1",
      } as never),
    ).toBe(false);
  });

  test("returns true when company id is present without flag", () => {
    expect(
      shouldUseSpecialShippingCompany({ shippingCompanyId: "c-1" } as never),
    ).toBe(true);
  });

  test("returns false when company id is missing without flag", () => {
    expect(shouldUseSpecialShippingCompany({} as never)).toBe(false);
  });

  test("returns false when config is missing", () => {
    expect(shouldUseSpecialShippingCompany(undefined as never)).toBe(false);
  });
});

void ActionAssignShippingProviderHandler.prototype.execute;
describe("ActionAssignShippingProviderHandler", () => {
  describe("execute", () => {
    let handler: ActionAssignShippingProviderHandler;
    let findOne: ReturnType<typeof vi.fn>;
    let createShipment: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      findOne = vi.fn();
      createShipment = vi.fn().mockResolvedValue({ id: "shipment-1" });

      handler = new ActionAssignShippingProviderHandler(
        { findOne } as never,
        { createShipment } as never,
      );
    });

    function runWith(output: unknown) {
      return {
        executionState: { trigger: { output } },
        initialPayload: { adminId: "admin-1", userId: "user-1" },
      } as never;
    }

    function mockOrder(overrides: Record<string, unknown> = {}) {
      return {
        id: "order-1",
        orderNumber: "A-1",
        __mock: true,
        adminId: "admin-1",
        shippingCompanyId: "c-9",
        shippingCompany: { code: "aramex", name: "Aramex" },
        ...overrides,
      } as never;
    }

    test("distributes with configured provider when special", async () => {
      const result = await handler.execute(
        {
          useSpecialShippingCompany: true,
          provider: "bosta",
          shippingCompanyId: "c-1",
          shippingCompany: "Bosta",
        } as never,
        runWith(mockOrder()),
      );

      expect(createShipment).toHaveBeenCalledWith(
        { adminId: "admin-1", id: "user-1", role: SystemRole.ADMIN },
        "bosta",
        {},
        "order-1",
        { emitSocket: false },
      );
      expect(result.success).toBe(true);
      expect(result.chosenBranch).toBe("distributed");
      expect(result.output).toMatchObject({
        orderId: "order-1",
        shippingCompanyId: "c-1",
        shippingCompany: "Bosta",
        provider: "bosta",
        shipment: { id: "shipment-1" },
      });
    });

    test("uses order shipping company when not special", async () => {
      const result = await handler.execute(
        {} as never,
        runWith(mockOrder()),
      );

      expect(createShipment).toHaveBeenCalledWith(
        expect.anything(),
        "aramex",
        {},
        "order-1",
        { emitSocket: false },
      );
      expect(result.output).toMatchObject({
        shippingCompanyId: "c-9",
        shippingCompany: "Aramex",
        provider: "aramex",
      });
    });

    test("fails when special provider is unavailable", async () => {
      const result = await handler.execute(
        { useSpecialShippingCompany: true } as never,
        runWith(mockOrder()),
      );

      expect(createShipment).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.chosenBranch).toBe("failed_to_distribute");
      expect(result.error).toBe("Selected shipping provider is unavailable");
    });

    test("fails when order has no shipping company", async () => {
      const result = await handler.execute(
        {} as never,
        runWith(
          mockOrder({ shippingCompanyId: null, shippingCompany: null }),
        ),
      );

      expect(createShipment).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.chosenBranch).toBe("failed_to_distribute");
      expect(result.error).toBe(
        "Order has no shipping company to distribute with",
      );
    });

    test("falls back to run admin id when order has none", async () => {
      await handler.execute(
        {
          useSpecialShippingCompany: true,
          provider: "bosta",
          shippingCompanyId: "c-1",
        } as never,
        {
          executionState: {
            trigger: { output: mockOrder({ adminId: null }) },
          },
          initialPayload: { adminId: "admin-9", userId: "user-9" },
        } as never,
      );

      const [me] = createShipment.mock.calls[0] as [
        { adminId: string; id: string | null },
      ];
      expect(me).toMatchObject({ adminId: "admin-9", id: "user-9" });
    });

    test("uses order admin id when run user id is missing", async () => {
      await handler.execute(
        {
          useSpecialShippingCompany: true,
          provider: "bosta",
          shippingCompanyId: "c-1",
        } as never,
        {
          executionState: {
            trigger: { output: mockOrder({ adminId: "admin-1" }) },
          },
          initialPayload: { adminId: "admin-1" },
        } as never,
      );

      const [me] = createShipment.mock.calls[0] as [
        { adminId: string; id: string | null },
      ];
      expect(me).toMatchObject({ adminId: "admin-1", id: "admin-1" });
    });

    test("uses run admin id when user id and order admin id are missing", async () => {
      await handler.execute(
        {
          useSpecialShippingCompany: true,
          provider: "bosta",
          shippingCompanyId: "c-1",
        } as never,
        {
          executionState: {
            trigger: { output: mockOrder({ adminId: null }) },
          },
          initialPayload: { adminId: "admin-9" },
        } as never,
      );

      const [me] = createShipment.mock.calls[0] as [
        { adminId: string; id: string | null },
      ];
      expect(me).toMatchObject({ adminId: "admin-9", id: "admin-9" });
    });

    test("uses run role when present", async () => {
      await handler.execute(
        {
          useSpecialShippingCompany: true,
          provider: "bosta",
          shippingCompanyId: "c-1",
        } as never,
        {
          executionState: { trigger: { output: mockOrder() } },
          initialPayload: {
            adminId: "admin-1",
            userId: "user-1",
            role: { name: "manager" },
          },
        } as never,
      );

      const [me] = createShipment.mock.calls[0] as [{ role: unknown }];
      expect(me.role).toEqual({ name: "manager" });
    });

    test("defaults actor role to admin when run role is missing", async () => {
      await handler.execute(
        {
          useSpecialShippingCompany: true,
          provider: "bosta",
          shippingCompanyId: "c-1",
        } as never,
        runWith(mockOrder()),
      );

      const [me] = createShipment.mock.calls[0] as [{ role: unknown }];
      expect(me.role).toBe(SystemRole.ADMIN);
    });

    test("wraps errors as distribution failure", async () => {
      createShipment.mockRejectedValue(new Error("provider down"));

      const result = await handler.execute(
        {
          useSpecialShippingCompany: true,
          provider: "bosta",
          shippingCompanyId: "c-1",
        } as never,
        runWith(mockOrder()),
      );

      expect(result.success).toBe(false);
      expect(result.chosenBranch).toBe("failed_to_distribute");
      expect(result.error).toBe("provider down");
    });

    test("wraps missing order as distribution failure", async () => {
      const result = await handler.execute({} as never, runWith({}));

      expect(result.success).toBe(false);
      expect(result.chosenBranch).toBe("failed_to_distribute");
      expect(result.error).toBe("Order ID is required");
    });
  });
});

describe("ActionSendWhatsappTemplateMessageHandler", () => {
  void ActionSendWhatsappTemplateMessageHandler.prototype.truncateToMaxLength;
  describe("truncateToMaxLength", () => {
    let handler: ActionSendWhatsappTemplateMessageHandler;

    beforeEach(() => {
      handler = new ActionSendWhatsappTemplateMessageHandler(
        {} as never,
        {} as never,
        {} as never,
      );
    });

    test("returns short text unchanged", () => {
      expect(handler.truncateToMaxLength("hello", 30)).toBe("hello");
    });

    test("returns text at exact limit unchanged", () => {
      expect(handler.truncateToMaxLength("12345", 5)).toBe("12345");
    });

    test("drops trailing words until it fits", () => {
      expect(handler.truncateToMaxLength("aaa bbb ccc", 7)).toBe("aaa bbb");
    });

    test("drops the second word when the limit falls inside it", () => {
      expect(handler.truncateToMaxLength("hello world", 8)).toBe("hello");
    });

    test("hard-cuts a single long word", () => {
      expect(handler.truncateToMaxLength("abcdefghijklmnop", 10)).toBe(
        "abcdefghij",
      );
    });

    test("returns empty string unchanged", () => {
      expect(handler.truncateToMaxLength("", 30)).toBe("");
    });
  });

  void ActionSendWhatsappTemplateMessageHandler.prototype.mapVariablesToValues;
  describe("mapVariablesToValues", () => {
    let handler: ActionSendWhatsappTemplateMessageHandler;

    beforeEach(() => {
      handler = new ActionSendWhatsappTemplateMessageHandler(
        {} as never,
        {} as never,
        {} as never,
      );
    });

    test("maps direct values as-is", () => {
      expect(
        handler.mapVariablesToValues(
          { v1: { type: "direct", value: "hello" } },
          {} as never,
        ),
      ).toEqual({ v1: "hello" });
    });

    test("throws when direct value is missing", () => {
      let thrown: unknown;
      try {
        handler.mapVariablesToValues(
          { v1: { type: "direct", value: "" } },
          {} as never,
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(
        'Variable "v1" is direct type but has no value',
      );
    });

    test("maps order variable paths", () => {
      expect(
        handler.mapVariablesToValues(
          { v1: { type: "variable", variablePath: "customer.name" } },
          { customer: { name: "Ada" } } as never,
        ),
      ).toEqual({ v1: "Ada" });
    });

    test("joins array values with comma", () => {
      expect(
        handler.mapVariablesToValues(
          { v1: { type: "variable", variablePath: "tags" } },
          { tags: ["a", "b"] } as never,
        ),
      ).toEqual({ v1: "a, b" });
    });

    test("formats Date values", () => {
      expect(
        handler.mapVariablesToValues(
          { v1: { type: "variable", variablePath: "createdAt" } },
          { createdAt: new Date(2026, 6, 22) } as never,
        ),
      ).toEqual({ v1: "22/07/2026" });
    });

    test("throws when order path is missing", () => {
      let thrown: unknown;
      try {
        handler.mapVariablesToValues(
          { v1: { type: "variable", variablePath: "missing" } },
          {} as never,
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(
        'Variable "v1" not found at path "missing" in order data',
      );
    });

    test("resolves global paths without throwing when missing", () => {
      expect(
        handler.mapVariablesToValues(
          { v1: { type: "variable", variablePath: "global.brandName" } },
          {} as never,
        ),
      ).toEqual({ v1: "" });
    });

    test("truncates values to thirty characters", () => {
      const result = handler.mapVariablesToValues(
        { v1: { type: "direct", value: "word ".repeat(10).trim() } },
        {} as never,
      );

      expect(result.v1.length).toBeLessThanOrEqual(30);
    });

    test("maps unknown types to empty string", () => {
      expect(
        handler.mapVariablesToValues(
          { v1: { type: "other" } },
          {} as never,
        ),
      ).toEqual({ v1: "" });
    });
  });

  void ActionSendWhatsappTemplateMessageHandler.prototype.execute;
  describe("execute", () => {
    let handler: ActionSendWhatsappTemplateMessageHandler;
    let findOne: ReturnType<typeof vi.fn>;
    let getTemplateById: ReturnType<typeof vi.fn>;
    let sendTemplate: ReturnType<typeof vi.fn>;
    let enqueueWaitResume: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      findOne = vi.fn();
      getTemplateById = vi.fn();
      sendTemplate = vi.fn().mockResolvedValue({ messageId: "msg-1" });
      enqueueWaitResume = vi.fn().mockResolvedValue(undefined);

      handler = new ActionSendWhatsappTemplateMessageHandler(
        { getTemplateById, sendTemplate } as never,
        { findOne } as never,
        {} as never,
        {} as never,
        {} as never,
        { enqueueWaitResume } as never,
      );
    });

    function mockOrder(overrides: Record<string, unknown> = {}) {
      return {
        id: "order-1",
        orderNumber: "A-1",
        __mock: true,
        adminId: "admin-1",
        normalizedPhoneNumber: "201001234567",
        ...overrides,
      } as never;
    }

    function runWith(output: unknown, overrides: Record<string, unknown> = {}) {
      return {
        id: "run-1",
        automationFlowId: "flow-1",
        versionId: "v-1",
        adminId: "admin-1",
        currentNodeId: "node-1",
        executionState: { trigger: { output } },
        whatsappAccountId: "acc-1",
        ...overrides,
      } as never;
    }

    function template(overrides: Record<string, unknown> = {}) {
      return {
        id: "tpl-1",
        name: "Order",
        adminId: null,
        accountId: "acc-1",
        status: TemplateStatus.APPROVED,
        templateConfig: { buttons: [], examples: ["{{1}}"] },
        ...overrides,
      };
    }

    function config(overrides: Record<string, unknown> = {}) {
      return {
        templateId: "tpl-1",
        bodyVariables: { v1: { type: "direct", value: "hello" } },
        branches: [],
        ...overrides,
      } as never;
    }

    test("sends template with mapped variables", async () => {
      getTemplateById.mockResolvedValue(template());

      const result = await handler.execute(
        config(),
        runWith(mockOrder()),
      );

      expect(sendTemplate).toHaveBeenCalledWith(
        "acc-1",
        expect.objectContaining({
          to: "201001234567",
          templateId: "tpl-1",
          bodyVariables: { v1: "hello" },
        }),
        "admin-1",
      );
      expect(result.success).toBe(true);
      expect(result.shouldPause).toBe(false);
      expect(result.resumeAfter).toBe(4000);
      expect(result.output).toMatchObject({
        messageId: "msg-1",
        recipient: "201001234567",
        templateId: "tpl-1",
        templateName: "Order",
      });
    });

    test("sends the template from the run WhatsApp account", async () => {
      getTemplateById.mockResolvedValue(template());

      await handler.execute(
        config(),
        runWith(mockOrder(), { whatsappAccountId: "acc-run" }),
      );

      expect(sendTemplate).toHaveBeenCalledWith(
        "acc-run",
        expect.objectContaining({ templateId: "tpl-1" }),
        "admin-1",
      );
    });

    test("returns template-not-found when adapter has none", async () => {
      getTemplateById.mockResolvedValue(null);

      const result = await handler.execute(
        config(),
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        error: "WhatsApp template not found",
      });
      expect(sendTemplate).not.toHaveBeenCalled();
    });

    test("returns account-not-found when admin template lacks account", async () => {
      getTemplateById.mockResolvedValue(
        template({ adminId: "admin-1", account: null }),
      );

      const result = await handler.execute(
        config(),
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        error: "WhatsApp account not found",
      });
    });

    test("returns not-approved for unapproved admin template", async () => {
      getTemplateById.mockResolvedValue(
        template({
          adminId: "admin-1",
          account: { id: "acc-1" },
          status: TemplateStatus.PENDING,
        }),
      );

      const result = await handler.execute(
        config(),
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        error: "WhatsApp template is not approved",
      });
    });

    test("skips account checks for shared template without admin id", async () => {
      getTemplateById.mockResolvedValue(
        template({ adminId: null, status: TemplateStatus.PENDING }),
      );

      const result = await handler.execute(
        config(),
        runWith(mockOrder()),
      );

      expect(result.success).toBe(true);
    });

    test("rejects mismatched custom-button counts", async () => {
      getTemplateById.mockResolvedValue(
        template({
          adminId: "admin-1",
          account: { id: "acc-1" },
          templateConfig: { buttons: [{ type: "CUSTOM" }], examples: ["{{1}}"] },
        }),
      );

      const result = await handler.execute(
        config(),
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        error:
          "WhatsApp template buttons and configuration buttons count do not match",
      });
    });

    test("ignores no-response branches in button validation", async () => {
      getTemplateById.mockResolvedValue(
        template({
          adminId: "admin-1",
          account: { id: "acc-1" },
          templateConfig: { buttons: [{ type: "CUSTOM" }], examples: ["{{1}}"] },
        }),
      );

      const result = await handler.execute(
        config({ branches: [{ stepId: "s-1" }, { isNoResponse: true }] }),
        runWith(mockOrder()),
      );

      expect(result.success).toBe(true);
    });

    test("rejects mismatched body variables count", async () => {
      getTemplateById.mockResolvedValue(
        template({
          templateConfig: { buttons: [], examples: ["{{1}}", "{{2}}"] },
        }),
      );

      const result = await handler.execute(
        config(),
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        error: "WhatsApp template body variables count does not match",
      });
    });

    test("supports array-form examples", async () => {
      getTemplateById.mockResolvedValue(
        template({
          templateConfig: { buttons: [], examples: ["{{1}}", "{{2}}"] },
        }),
      );

      const result = await handler.execute(
        config({
          bodyVariables: {
            v1: { type: "direct", value: "a" },
            v2: { type: "direct", value: "b" },
          },
        }),
        runWith(mockOrder()),
      );

      expect(result.success).toBe(true);
    });

    test("rejects mismatched header variables count", async () => {
      getTemplateById.mockResolvedValue(
        template({ templateConfig: { buttons: [], examples: ["{{1}}"], headerExample: "Hi" } }),
      );

      const result = await handler.execute(
        config(),
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        error: "WhatsApp template header variables count does not match",
      });
    });

    test("rejects mismatched dynamic button variables count", async () => {
      getTemplateById.mockResolvedValue(
        template({
          templateConfig: {
            buttons: [{ type: "VISIT_WEBSITE", urlType: "Dynamic" }],
            examples: ["{{1}}"],
          },
        }),
      );

      const result = await handler.execute(
        config(),
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        error:
          "WhatsApp template dynamic buttons variables count does not match",
      });
    });

    test("wraps variable mapping errors", async () => {
      getTemplateById.mockResolvedValue(template());

      const result = await handler.execute(
        config({ bodyVariables: { v1: { type: "direct", value: "" } } }),
        runWith(mockOrder()),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Variable "v1" is direct type');
    });

    test("resolves recipient from explicit number", async () => {
      getTemplateById.mockResolvedValue(template());

      await handler.execute(
        config({ recipientNumber: "01001234567" }),
        runWith(mockOrder({ normalizedPhoneNumber: null, phoneNumber: null })),
      );

      const [, payload] = sendTemplate.mock.calls[0] as [
        unknown,
        { to: string },
      ];
      expect(payload.to).toBe("201001234567");
    });

    test("falls back to order phone number", async () => {
      getTemplateById.mockResolvedValue(template());

      await handler.execute(
        config(),
        runWith(
          mockOrder({ normalizedPhoneNumber: null, phoneNumber: "01001234567" }),
        ),
      );

      const [, payload] = sendTemplate.mock.calls[0] as [
        unknown,
        { to: string },
      ];
      expect(payload.to).toBe("201001234567");
    });

    test("fails without any recipient", async () => {
      getTemplateById.mockResolvedValue(template());

      const result = await handler.execute(
        config(),
        runWith(
          mockOrder({ normalizedPhoneNumber: null, phoneNumber: null }),
        ),
      );

      expect(result).toEqual({
        success: false,
        error: "Recipient phone number not found",
      });
      expect(sendTemplate).not.toHaveBeenCalled();
    });

    test("uses product image for image headers", async () => {
      getTemplateById.mockResolvedValue(
        template({
          templateConfig: {
            buttons: [],
            examples: ["{{1}}"],
            headerType: "IMAGE",
          },
        }),
      );

      await handler.execute(
        config({
          useOrderFirstItemImage: true,
          headerUrl: "https://cdn.test/fallback.png",
        }),
        runWith(
          mockOrder({
            items: [{ variant: { product: { mainImage: "https://cdn.test/p.png" } } }],
          }),
        ),
      );

      const [, payload] = sendTemplate.mock.calls[0] as [
        unknown,
        { headerUrl: string },
      ];
      expect(payload.headerUrl).toBe("https://cdn.test/p.png");
    });

    test("falls back to config url without product image", async () => {
      getTemplateById.mockResolvedValue(
        template({
          templateConfig: {
            buttons: [],
            examples: ["{{1}}"],
            headerType: "IMAGE",
          },
        }),
      );

      await handler.execute(
        config({
          useOrderFirstItemImage: true,
          headerUrl: "https://cdn.test/fallback.png",
        }),
        runWith(mockOrder({ items: [] })),
      );

      const [, payload] = sendTemplate.mock.calls[0] as [
        unknown,
        { headerUrl: string },
      ];
      expect(payload.headerUrl).toBe("https://cdn.test/fallback.png");
    });

    test("maps location data for location headers", async () => {
      getTemplateById.mockResolvedValue(
        template({ templateConfig: { buttons: [], examples: ["{{1}}"], headerType: "LOCATION" } }),
      );

      await handler.execute(
        config({
          locationData: {
            latitude: 30.1,
            longitude: 31.2,
            name: { type: "direct", value: "Store" },
            address: { type: "direct", value: "Cairo" },
          },
        }),
        runWith(mockOrder()),
      );

      const [, payload] = sendTemplate.mock.calls[0] as [
        unknown,
        {
          locationData: {
            latitude: string;
            longitude: string;
            name: string;
            address: string;
          };
        },
      ];
      expect(payload.locationData).toEqual({
        latitude: "30.1",
        longitude: "31.2",
        name: "Store",
        address: "Cairo",
      });
    });

    test("schedules wait-resume for no-response timeout", async () => {
      getTemplateById.mockResolvedValue(template());

      const result = await handler.execute(
        config({ branches: [{ isNoResponse: true, timeoutMinutes: 5 }] }),
        runWith(mockOrder()),
      );

      expect(enqueueWaitResume).toHaveBeenCalledWith(
        "run-1",
        "flow-1",
        "v-1",
        "admin-1",
        "node-1",
        5 * 60 * 1000,
      );
      expect(result.shouldPause).toBe(true);
      expect(result.output).toMatchObject({ waitMinutes: 5, waitMs: 5 * 60 * 1000 });
    });

    test("skips wait-resume for preview runs", async () => {
      getTemplateById.mockResolvedValue(template());

      const result = await handler.execute(
        config({ branches: [{ isNoResponse: true, timeoutMinutes: 5 }] }),
        runWith(mockOrder(), { previewId: "preview-1" }),
      );

      expect(enqueueWaitResume).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    test("wraps adapter errors", async () => {
      getTemplateById.mockResolvedValue(template());
      sendTemplate.mockRejectedValue(new Error("meta down"));

      const result = await handler.execute(
        config(),
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        error: "WhatsApp send failed: meta down",
      });
    });

    test("wraps missing order", async () => {
      getTemplateById.mockResolvedValue(template());

      const result = await handler.execute(config(), runWith({}));

      expect(result).toEqual({
        success: false,
        error: "WhatsApp send failed: Order ID is required",
      });
    });

    test("sends for admin-owned approved template", async () => {
      getTemplateById.mockResolvedValue(
        template({
          adminId: "admin-1",
          account: { id: "acc-1" },
          status: TemplateStatus.APPROVED,
        }),
      );

      const result = await handler.execute(config(), runWith(mockOrder()));

      expect(result.success).toBe(true);
      expect(result.output).toMatchObject({ templateId: "tpl-1" });
    });

    test("returns not-approved for rejected admin template", async () => {
      getTemplateById.mockResolvedValue(
        template({
          adminId: "admin-1",
          account: { id: "acc-1" },
          status: TemplateStatus.REJECTED,
        }),
      );

      const result = await handler.execute(config(), runWith(mockOrder()));

      expect(result).toEqual({
        success: false,
        error: "WhatsApp template is not approved",
      });
    });

    test("wraps missing template config", async () => {
      getTemplateById.mockResolvedValue(template({ templateConfig: null }));

      const result = await handler.execute(config(), runWith(mockOrder()));

      expect(result.success).toBe(false);
      expect(result.error).toContain("WhatsApp send failed:");
    });

    test("passes with zero custom buttons and zero branches", async () => {
      getTemplateById.mockResolvedValue(
        template({
          adminId: "admin-1",
          account: { id: "acc-1" },
          templateConfig: { buttons: [], examples: ["{{1}}"] },
        }),
      );

      const result = await handler.execute(
        config({ branches: [] }),
        runWith(mockOrder()),
      );

      expect(result.success).toBe(true);
    });

    test("passes when custom buttons match exactly", async () => {
      getTemplateById.mockResolvedValue(
        template({
          templateConfig: { buttons: [{ type: "CUSTOM" }], examples: ["{{1}}"] },
        }),
      );

      const result = await handler.execute(
        config({ branches: [{ stepId: "s-1" }] }),
        runWith(mockOrder()),
      );

      expect(result.success).toBe(true);
    });

    test("passes when multiple custom buttons match", async () => {
      getTemplateById.mockResolvedValue(
        template({
          templateConfig: {
            buttons: [{ type: "CUSTOM" }, { type: "CUSTOM" }],
            examples: ["{{1}}"],
          },
        }),
      );

      const result = await handler.execute(
        config({ branches: [{ stepId: "s-1" }, { stepId: "s-2" }] }),
        runWith(mockOrder()),
      );

      expect(result.success).toBe(true);
    });

    test("passes when branches are undefined", async () => {
      getTemplateById.mockResolvedValue(template());

      const result = await handler.execute(
        config({ branches: undefined }),
        runWith(mockOrder()),
      );

      expect(result.success).toBe(true);
      expect(result.shouldPause).toBe(false);
    });

    test("supports object-form examples", async () => {
      getTemplateById.mockResolvedValue(
        template({
          templateConfig: { buttons: [], examples: { "1": "a", "2": "b" } },
        }),
      );

      const result = await handler.execute(
        config({
          bodyVariables: {
            v1: { type: "direct", value: "a" },
            v2: { type: "direct", value: "b" },
          },
        }),
        runWith(mockOrder()),
      );

      expect(result.success).toBe(true);
    });

    test("rejects body variables when examples are null", async () => {
      getTemplateById.mockResolvedValue(
        template({ templateConfig: { buttons: [], examples: null } }),
      );

      const result = await handler.execute(config(), runWith(mockOrder()));

      expect(result).toEqual({
        success: false,
        error: "WhatsApp template body variables count does not match",
      });
    });

    test("rejects header variables without header example", async () => {
      getTemplateById.mockResolvedValue(template());

      const result = await handler.execute(
        config({ headerVariables: { h1: { type: "direct", value: "Hi" } } }),
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        error: "WhatsApp template header variables count does not match",
      });
    });

    test("passes with empty header variables and no example", async () => {
      getTemplateById.mockResolvedValue(template());

      const result = await handler.execute(
        config({ headerVariables: {} }),
        runWith(mockOrder()),
      );

      expect(result.success).toBe(true);
    });

    test("passes when button variables match dynamic buttons", async () => {
      getTemplateById.mockResolvedValue(
        template({
          templateConfig: {
            buttons: [{ type: "VISIT_WEBSITE", urlType: "Dynamic" }],
            examples: ["{{1}}"],
          },
        }),
      );

      const result = await handler.execute(
        config({ buttonVariables: { b1: { type: "direct", value: "go" } } }),
        runWith(mockOrder()),
      );

      expect(result.success).toBe(true);
    });

    test("counts copy-code buttons as dynamic", async () => {
      getTemplateById.mockResolvedValue(
        template({
          templateConfig: {
            buttons: [{ type: "COPY_CODE" }],
            examples: ["{{1}}"],
          },
        }),
      );

      const result = await handler.execute(config(), runWith(mockOrder()));

      expect(result).toEqual({
        success: false,
        error:
          "WhatsApp template dynamic buttons variables count does not match",
      });
    });

    test("ignores static website buttons in dynamic count", async () => {
      getTemplateById.mockResolvedValue(
        template({
          templateConfig: {
            buttons: [{ type: "VISIT_WEBSITE", urlType: "Static" }],
            examples: ["{{1}}"],
          },
        }),
      );

      const result = await handler.execute(config(), runWith(mockOrder()));

      expect(result.success).toBe(true);
    });

    test("falls through empty recipient number to order", async () => {
      getTemplateById.mockResolvedValue(template());

      await handler.execute(
        config({ recipientNumber: "" }),
        runWith(mockOrder()),
      );

      const [, payload] = sendTemplate.mock.calls[0] as [
        unknown,
        { to: string },
      ];
      expect(payload.to).toBe("201001234567");
    });

    test("fails for invalid explicit recipient number", async () => {
      getTemplateById.mockResolvedValue(template());

      const result = await handler.execute(
        config({ recipientNumber: "abc" }),
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        error: "Recipient phone number not found",
      });
      expect(sendTemplate).not.toHaveBeenCalled();
    });

    test("falls through empty stored number to phone", async () => {
      getTemplateById.mockResolvedValue(template());

      await handler.execute(
        config(),
        runWith(
          mockOrder({
            normalizedPhoneNumber: "",
            phoneNumber: "01001234567",
          }),
        ),
      );

      const [, payload] = sendTemplate.mock.calls[0] as [
        unknown,
        { to: string },
      ];
      expect(payload.to).toBe("201001234567");
    });

    test("fails for invalid order phone number", async () => {
      getTemplateById.mockResolvedValue(template());

      const result = await handler.execute(
        config(),
        runWith(
          mockOrder({ normalizedPhoneNumber: null, phoneNumber: "abc" }),
        ),
      );

      expect(result).toEqual({
        success: false,
        error: "Recipient phone number not found",
      });
    });

    test("prefers explicit number over stored number", async () => {
      getTemplateById.mockResolvedValue(template());

      await handler.execute(
        config({ recipientNumber: "01001234567" }),
        runWith(mockOrder({ normalizedPhoneNumber: "201999999999" })),
      );

      const [, payload] = sendTemplate.mock.calls[0] as [
        unknown,
        { to: string },
      ];
      expect(payload.to).toBe("201001234567");
    });

    test("ignores product image when flag is off", async () => {
      getTemplateById.mockResolvedValue(
        template({
          templateConfig: {
            buttons: [],
            examples: ["{{1}}"],
            headerType: "IMAGE",
          },
        }),
      );

      await handler.execute(
        config({
          useOrderFirstItemImage: false,
          headerUrl: "https://cdn.test/fallback.png",
        }),
        runWith(
          mockOrder({
            items: [
              { variant: { product: { mainImage: "https://cdn.test/p.png" } } },
            ],
          }),
        ),
      );

      const [, payload] = sendTemplate.mock.calls[0] as [
        unknown,
        { headerUrl: string },
      ];
      expect(payload.headerUrl).toBe("https://cdn.test/fallback.png");
    });

    test("ignores product image for non-image headers", async () => {
      getTemplateById.mockResolvedValue(
        template({
          templateConfig: {
            buttons: [],
            examples: ["{{1}}"],
            headerType: "TEXT",
          },
        }),
      );

      await handler.execute(
        config({
          useOrderFirstItemImage: true,
          headerUrl: "https://cdn.test/fallback.png",
        }),
        runWith(
          mockOrder({
            items: [
              { variant: { product: { mainImage: "https://cdn.test/p.png" } } },
            ],
          }),
        ),
      );

      const [, payload] = sendTemplate.mock.calls[0] as [
        unknown,
        { headerUrl: string },
      ];
      expect(payload.headerUrl).toBe("https://cdn.test/fallback.png");
    });

    test("falls back to config url when first item has no image", async () => {
      getTemplateById.mockResolvedValue(
        template({
          templateConfig: {
            buttons: [],
            examples: ["{{1}}"],
            headerType: "IMAGE",
          },
        }),
      );

      await handler.execute(
        config({
          useOrderFirstItemImage: true,
          headerUrl: "https://cdn.test/fallback.png",
        }),
        runWith(mockOrder({ items: [{}] })),
      );

      const [, payload] = sendTemplate.mock.calls[0] as [
        unknown,
        { headerUrl: string },
      ];
      expect(payload.headerUrl).toBe("https://cdn.test/fallback.png");
    });

    test("passes undefined header url without image or fallback", async () => {
      getTemplateById.mockResolvedValue(
        template({
          templateConfig: {
            buttons: [],
            examples: ["{{1}}"],
            headerType: "IMAGE",
          },
        }),
      );

      const result = await handler.execute(
        config({ useOrderFirstItemImage: true }),
        runWith(mockOrder({ items: [] })),
      );

      const [, payload] = sendTemplate.mock.calls[0] as [
        unknown,
        { headerUrl: string },
      ];
      expect(payload.headerUrl).toBeUndefined();
      expect(result.success).toBe(true);
    });

    test("leaves location data undefined without location input", async () => {
      getTemplateById.mockResolvedValue(
        template({
          templateConfig: {
            buttons: [],
            examples: ["{{1}}"],
            headerType: "LOCATION",
          },
        }),
      );

      await handler.execute(config(), runWith(mockOrder()));

      const [, payload] = sendTemplate.mock.calls[0] as [
        unknown,
        { locationData: unknown },
      ];
      expect(payload.locationData).toBeUndefined();
    });

    test("stringifies string coordinates", async () => {
      getTemplateById.mockResolvedValue(
        template({
          templateConfig: {
            buttons: [],
            examples: ["{{1}}"],
            headerType: "LOCATION",
          },
        }),
      );

      await handler.execute(
        config({
          locationData: {
            latitude: "30.1",
            longitude: "31.2",
            name: { type: "direct", value: "Store" },
            address: { type: "direct", value: "Cairo" },
          },
        }),
        runWith(mockOrder()),
      );

      const [, payload] = sendTemplate.mock.calls[0] as [
        unknown,
        { locationData: { latitude: string; longitude: string } },
      ];
      expect(payload.locationData.latitude).toBe("30.1");
      expect(payload.locationData.longitude).toBe("31.2");
    });

    test("keeps empty global location names", async () => {
      getTemplateById.mockResolvedValue(
        template({
          templateConfig: {
            buttons: [],
            examples: ["{{1}}"],
            headerType: "LOCATION",
          },
        }),
      );

      await handler.execute(
        config({
          locationData: {
            latitude: 30.1,
            longitude: 31.2,
            name: { type: "variable", variablePath: "global.missing" },
            address: { type: "direct", value: "Cairo" },
          },
        }),
        runWith(mockOrder()),
      );

      const [, payload] = sendTemplate.mock.calls[0] as [
        unknown,
        { locationData: { name: string } },
      ];
      expect(payload.locationData.name).toBe("");
    });

    test("matches lowercase location header type", async () => {
      getTemplateById.mockResolvedValue(
        template({
          templateConfig: {
            buttons: [],
            examples: ["{{1}}"],
            headerType: "location",
          },
        }),
      );

      await handler.execute(
        config({
          locationData: {
            latitude: 30.1,
            longitude: 31.2,
            name: { type: "direct", value: "Store" },
            address: { type: "direct", value: "Cairo" },
          },
        }),
        runWith(mockOrder()),
      );

      const [, payload] = sendTemplate.mock.calls[0] as [
        unknown,
        { locationData: { name: string } },
      ];
      expect(payload.locationData.name).toBe("Store");
    });

    test("wraps unresolvable location variables", async () => {
      getTemplateById.mockResolvedValue(
        template({
          templateConfig: {
            buttons: [],
            examples: ["{{1}}"],
            headerType: "LOCATION",
          },
        }),
      );

      const result = await handler.execute(
        config({
          locationData: {
            latitude: 30.1,
            longitude: 31.2,
            name: { type: "variable", variablePath: "missing" },
            address: { type: "direct", value: "Cairo" },
          },
        }),
        runWith(mockOrder()),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("WhatsApp send failed:");
    });

    test("uses first no-response branch when several exist", async () => {
      getTemplateById.mockResolvedValue(template());

      await handler.execute(
        config({
          branches: [
            { isNoResponse: true, timeoutMinutes: 5 },
            { isNoResponse: true, timeoutMinutes: 10 },
          ],
        }),
        runWith(mockOrder()),
      );

      expect(enqueueWaitResume).toHaveBeenCalledWith(
        "run-1",
        "flow-1",
        "v-1",
        "admin-1",
        "node-1",
        5 * 60 * 1000,
      );
    });

    test("skips wait-resume for zero timeout", async () => {
      getTemplateById.mockResolvedValue(template());

      const result = await handler.execute(
        config({ branches: [{ isNoResponse: true, timeoutMinutes: 0 }] }),
        runWith(mockOrder()),
      );

      expect(enqueueWaitResume).not.toHaveBeenCalled();
      expect(result.output.waitMs).toBeUndefined();
    });

    test("supports string timeout minutes", async () => {
      getTemplateById.mockResolvedValue(template());

      await handler.execute(
        config({ branches: [{ isNoResponse: true, timeoutMinutes: "5" }] }),
        runWith(mockOrder()),
      );

      expect(enqueueWaitResume).toHaveBeenCalledWith(
        "run-1",
        "flow-1",
        "v-1",
        "admin-1",
        "node-1",
        5 * 60 * 1000,
      );
    });

    test("pauses without wait fields for plain branches", async () => {
      getTemplateById.mockResolvedValue(
        template({
          templateConfig: { buttons: [{ type: "CUSTOM" }], examples: ["{{1}}"] },
        }),
      );

      const result = await handler.execute(
        config({ branches: [{ stepId: "s-1" }] }),
        runWith(mockOrder()),
      );

      expect(enqueueWaitResume).not.toHaveBeenCalled();
      expect(result.shouldPause).toBe(true);
      expect(result.output.waitMs).toBeUndefined();
    });

    test("sends without queue service configured", async () => {
      getTemplateById.mockResolvedValue(template());
      const withoutQueue = new ActionSendWhatsappTemplateMessageHandler(
        { getTemplateById, sendTemplate } as never,
        { findOne } as never,
        {} as never,
        {} as never,
        {} as never,
        undefined as never,
      );

      const result = await withoutQueue.execute(
        config({ branches: [{ isNoResponse: true, timeoutMinutes: 5 }] }),
        runWith(mockOrder()),
      );

      expect(result.success).toBe(true);
    });

    test("wraps queue errors", async () => {
      getTemplateById.mockResolvedValue(template());
      enqueueWaitResume.mockRejectedValue(new Error("queue down"));

      const result = await handler.execute(
        config({ branches: [{ isNoResponse: true, timeoutMinutes: 5 }] }),
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        error: "WhatsApp send failed: queue down",
      });
    });

    test("reports mapped variables in output", async () => {
      getTemplateById.mockResolvedValue(template());

      const result = await handler.execute(
        config({
          bodyVariables: { v1: { type: "direct", value: "hello" } },
        }),
        runWith(mockOrder()),
      );

      expect(result.output.variables).toMatchObject({
        body: { v1: "hello" },
      });
      expect(result.output.variables.header).toBeUndefined();
      expect(result.output.variables.button).toBeUndefined();
    });

    test("omits wait fields without no-response branch", async () => {
      getTemplateById.mockResolvedValue(template());

      const result = await handler.execute(config(), runWith(mockOrder()));

      expect(result.output.waitMs).toBeUndefined();
      expect(result.output.waitMinutes).toBeUndefined();
      expect(result.output.resumeAt).toBeUndefined();
    });

    test("reports resume time as valid ISO string", async () => {
      getTemplateById.mockResolvedValue(template());
      const before = Date.now();

      const result = await handler.execute(
        config({ branches: [{ isNoResponse: true, timeoutMinutes: 5 }] }),
        runWith(mockOrder()),
      );

      const resumeAt = Date.parse(result.output.resumeAt);
      expect(resumeAt).toBeGreaterThanOrEqual(before + 5 * 60 * 1000);
    });

    test("wraps template lookup errors", async () => {
      getTemplateById.mockRejectedValue(new Error("db down"));

      const result = await handler.execute(config(), runWith(mockOrder()));

      expect(result).toEqual({
        success: false,
        error: "WhatsApp send failed: db down",
      });
    });

    test("continues when global data lookup fails", async () => {
      getTemplateById.mockResolvedValue(template());
      const failingUserRepo = {
        findOne: vi.fn().mockRejectedValue(new Error("db down")),
      };
      const withFailingRepo = new ActionSendWhatsappTemplateMessageHandler(
        { getTemplateById, sendTemplate } as never,
        { findOne } as never,
        {} as never,
        failingUserRepo as never,
        {} as never,
        { enqueueWaitResume } as never,
      );

      const result = await withFailingRepo.execute(
        config(),
        runWith(mockOrder()),
      );

      expect(result.success).toBe(true);
    });
    
    test("wraps errors without message", async () => {
      getTemplateById.mockResolvedValue(template());
      sendTemplate.mockRejectedValue({});
      
      const result = await handler.execute(config(), runWith(mockOrder()));
      
      expect(result).toEqual({
        success: false,
        error: "WhatsApp send failed: undefined",
      });
    });
  });
});

void ActionSendWhatsappMessageHandler.prototype.execute;
describe("ActionSendWhatsappMessageHandler", () => {
  describe("execute", () => {
    let handler: ActionSendWhatsappMessageHandler;
    let getWhatsappAccount: ReturnType<typeof vi.fn>;
    let sendMessage: ReturnType<typeof vi.fn>;
    let messageFindOne: ReturnType<typeof vi.fn>;
    let enqueueWaitResume: ReturnType<typeof vi.fn>;

    afterEach(() => {
      vi.useRealTimers();
    });

    beforeEach(() => {
      skipHandlerWaits();
      getWhatsappAccount = vi.fn().mockResolvedValue({ id: "acc-1" });
      sendMessage = vi.fn().mockResolvedValue({ messages: [{ id: "m-1" }] });
      messageFindOne = vi
        .fn()
        .mockResolvedValue({ status: MessageStatus.DELIVERED });
      enqueueWaitResume = vi.fn().mockResolvedValue(undefined);

      handler = new ActionSendWhatsappMessageHandler(
        { getWhatsappAccount } as never,
        {} as never,
        { findOne: messageFindOne } as never,
        { sendMessage } as never,
        {} as never,
        {} as never,
        { enqueueWaitResume } as never,
      );
    });

    function mockOrder(overrides: Record<string, unknown> = {}) {
      return {
        id: "order-1",
        orderNumber: "A-1",
        __mock: true,
        adminId: "admin-1",
        normalizedPhoneNumber: "201001234567",
        name: "Ada",
        ...overrides,
      } as never;
    }

    function runWith(output: unknown, overrides: Record<string, unknown> = {}) {
      return {
        id: "run-1",
        automationFlowId: "flow-1",
        versionId: "v-1",
        adminId: "admin-1",
        currentNodeId: "node-1",
        executionState: { trigger: { output } },
        whatsappAccountId: "acc-1",
        ...overrides,
      } as never;
    }

    function config(overrides: Record<string, unknown> = {}) {
      return {
        accountId: "acc-1",
        messageData: { type: "text", text: "Hi {{name}}" },
        branches: [],
        ...overrides,
      } as never;
    }

    test("sends message with hydrated payload in production", async () => {
      const result = await handler.execute(
        config(),
        runWith(mockOrder()),
      );
      
      expect(sendMessage).toHaveBeenCalledWith(
        { adminId: "admin-1" },
        expect.objectContaining({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: "201001234567",
          text: "Hi Ada",
        }),
        "acc-1",
        null,
        MessageActionIntent.NONE,
        "order-1",
      );
      expect(result.success).toBe(true);
      expect(result.shouldPause).toBe(false);
      expect(result.output).toMatchObject({
        messageId: "m-1",
        recipient: "201001234567",
      });
    });

    test("excludes weekends in global dates when configured", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 6, 22, 12));
      try {
        const pending = handler.execute(
          config({
            messageData: { text: "{{global.date.2.DD-MM-YYYY}}" },
            businessConfig: { excludeWeekends: true },
          }),
          runWith(mockOrder()),
        );
        await vi.advanceTimersByTimeAsync(5000);
        await pending;
      } finally {
        vi.useRealTimers();
      }

      const [, payload] = sendMessage.mock.calls[0] as [
        unknown,
        { text: string },
      ];
      expect(payload.text).toBe("26-07-2026");
    });

    test("counts weekends in global dates without flag", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 6, 22, 12));
      try {
        const pending = handler.execute(
          config({ messageData: { text: "{{global.date.2.DD-MM-YYYY}}" } }),
          runWith(mockOrder()),
        );
        await vi.advanceTimersByTimeAsync(5000);
        await pending;
      } finally {
        vi.useRealTimers();
      }

      const [, payload] = sendMessage.mock.calls[0] as [
        unknown,
        { text: string },
      ];
      expect(payload.text).toBe("24-07-2026");
    });

    test("attaches business metadata when configured", async () => {
      await handler.execute(
        config({
          businessConfig: { excludeWeekends: false },
          businessUseCase: "promo",
          businessCommand: "send",
        }),
        runWith(mockOrder()),
      );

      const [, payload] = sendMessage.mock.calls[0] as [
        unknown,
        { metadata: unknown },
      ];
      expect(payload.metadata).toEqual({
        businessConfig: { excludeWeekends: false },
        businessUseCase: "promo",
        businessCommand: "send",
      });
    });

    test("omits metadata without business fields", async () => {
      await handler.execute(config(), runWith(mockOrder()));

      const [, payload] = sendMessage.mock.calls[0] as [
        unknown,
        Record<string, unknown>,
      ];
      expect(payload).not.toHaveProperty("metadata");
    });

    test("returns account-not-found without sending", async () => {
      getWhatsappAccount.mockResolvedValue(null);

      const result = await handler.execute(config(), runWith(mockOrder()));

      expect(result).toEqual({
        success: false,
        error: "WhatsApp account not found",
      });
      expect(sendMessage).not.toHaveBeenCalled();
    });

    test("wraps account lookup errors", async () => {
      getWhatsappAccount.mockRejectedValue(new Error("db down"));

      const result = await handler.execute(config(), runWith(mockOrder()));

      expect(result).toEqual({
        success: false,
        error: "WhatsApp send failed: db down",
      });
      expect(sendMessage).not.toHaveBeenCalled();
    });

    test("fails without a run or step account", async () => {
      getWhatsappAccount.mockResolvedValue(null);

      const result = await handler.execute(
        config({ accountId: undefined }),
        runWith(mockOrder(), { whatsappAccountId: undefined }),
      );

      expect(getWhatsappAccount).toHaveBeenCalledWith(undefined);
      expect(result).toEqual({
        success: false,
        error: "WhatsApp account not found",
      });
      expect(sendMessage).not.toHaveBeenCalled();
    });

    test("uses the run WhatsApp account over the step config", async () => {
      await handler.execute(
        config({ accountId: "acc-step" }),
        runWith(mockOrder(), { whatsappAccountId: "acc-run" }),
      );

      expect(getWhatsappAccount).toHaveBeenCalledWith("acc-run");
      const [, , accountId] = sendMessage.mock.calls[0] as unknown[];
      expect(accountId).toBe("acc-run");
    });

    test("fails without any recipient", async () => {
      const result = await handler.execute(
        config(),
        runWith(
          mockOrder({ normalizedPhoneNumber: null, phoneNumber: null }),
        ),
      );

      expect(result).toEqual({
        success: false,
        error: "Recipient phone number not found",
      });
      expect(sendMessage).not.toHaveBeenCalled();
    });

    test("resolves explicit recipient number", async () => {
      await handler.execute(
        config({ recipientNumber: "01001234567" }),
        runWith(mockOrder({ normalizedPhoneNumber: null, phoneNumber: null })),
      );

      const [, payload] = sendMessage.mock.calls[0] as [
        unknown,
        { to: string },
      ];
      expect(payload.to).toBe("201001234567");
    });

    test("falls back to order phone number", async () => {
      await handler.execute(
        config(),
        runWith(
          mockOrder({
            normalizedPhoneNumber: null,
            phoneNumber: "01001234567",
          }),
        ),
      );

      const [, payload] = sendMessage.mock.calls[0] as [
        unknown,
        { to: string },
      ];
      expect(payload.to).toBe("201001234567");
    });

    test("defaults action intent to none", async () => {
      await handler.execute(config(), runWith(mockOrder()));

      const [, , , , intent] = sendMessage.mock.calls[0] as unknown[];
      expect(intent).toBe(MessageActionIntent.NONE);
    });

    test("passes custom action intent", async () => {
      await handler.execute(
        config({ actionIntent: MessageActionIntent.BRANCHES }),
        runWith(mockOrder()),
      );

      const [, , , , intent] = sendMessage.mock.calls[0] as unknown[];
      expect(intent).toBe(MessageActionIntent.BRANCHES);
    });

    test("pauses with branches", async () => {
      const result = await handler.execute(
        config({ branches: [{ stepId: "s-1" }] }),
        runWith(mockOrder()),
      );

      expect(result.success).toBe(true);
      expect(result.shouldPause).toBe(true);
    });

    test("schedules wait-resume for no-response timeout", async () => {
      const result = await handler.execute(
        config({ branches: [{ isNoResponse: true, timeoutMinutes: 5 }] }),
        runWith(mockOrder()),
      );

      expect(enqueueWaitResume).toHaveBeenCalledWith(
        "run-1",
        "flow-1",
        "v-1",
        "admin-1",
        "node-1",
        5 * 60 * 1000,
      );
      expect(result.output).toMatchObject({
        waitMinutes: 5,
        waitMs: 5 * 60 * 1000,
      });
    });

    test("skips wait-resume for preview runs", async () => {
      const result = await handler.execute(
        config({ branches: [{ isNoResponse: true, timeoutMinutes: 5 }] }),
        runWith(mockOrder(), { previewId: "preview-1" }),
      );

      expect(enqueueWaitResume).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    test("returns preview id without side effects when service is missing", async () => {
      const previewHandler = new ActionSendWhatsappMessageHandler(
        { getWhatsappAccount } as never,
        {} as never,
        { findOne: messageFindOne } as never,
        undefined as never,
        {} as never,
        {} as never,
        { enqueueWaitResume } as never,
      );

      const result = await previewHandler.execute(
        config(),
        runWith(mockOrder()),
      );

      expect(result.success).toBe(true);
      expect(result.output.messageId).toMatch(/^preview-/);
      expect(messageFindOne).not.toHaveBeenCalled();
    });

    test("skips status check without message id", async () => {
      sendMessage.mockResolvedValue({ messages: [] });

      const result = await handler.execute(config(), runWith(mockOrder()));

      expect(messageFindOne).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.output.messageId).toBeUndefined();
    });

    test("wraps failed message status", async () => {
      messageFindOne.mockResolvedValue({
        status: MessageStatus.FAILED,
        error: "no route",
      });

      const result = await handler.execute(config(), runWith(mockOrder()));

      expect(result.success).toBe(false);
      expect(result.error).toContain("no route");
    });

    test("wraps adapter errors", async () => {
      sendMessage.mockRejectedValue(new Error("meta down"));

      const result = await handler.execute(config(), runWith(mockOrder()));

      expect(result).toEqual({
        success: false,
        error: "WhatsApp send failed: meta down",
      });
    });

    test("wraps missing order", async () => {
      const result = await handler.execute(config(), runWith({}));

      expect(result).toEqual({
        success: false,
        error: "WhatsApp send failed: Order ID is required",
      });
    });
  });
});

void ActionSendUpsellHandler.prototype.execute;
describe("ActionSendUpsellHandler", () => {
  describe("execute", () => {
    let handler: ActionSendUpsellHandler;
    let getUpsellsForProducts: ReturnType<typeof vi.fn>;
    let sendUpsell: ReturnType<typeof vi.fn>;
    let messageFindOne: ReturnType<typeof vi.fn>;
    let enqueueWaitResume: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      skipHandlerWaits();
      getUpsellsForProducts = vi.fn().mockResolvedValue([]);
      sendUpsell = vi
        .fn()
        .mockResolvedValue({ id: "h-1", messageId: "m-1" });
      messageFindOne = vi
        .fn()
        .mockResolvedValue({ status: MessageStatus.DELIVERED });
      enqueueWaitResume = vi.fn().mockResolvedValue(undefined);

      handler = new ActionSendUpsellHandler(
        { getUpsellsForProducts, sendUpsell } as never,
        {} as never,
        { findOne: messageFindOne } as never,
        {} as never,
        {} as never,
        { enqueueWaitResume } as never,
      );
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function mockOrder(overrides: Record<string, unknown> = {}) {
      return {
        id: "order-1",
        orderNumber: "A-1",
        __mock: true,
        adminId: "admin-1",
        phoneNumber: "01001234567",
        items: [{ variantId: "v-1", variant: { productId: "p-1" } }],
        ...overrides,
      } as never;
    }

    function runWith(output: unknown, overrides: Record<string, unknown> = {}) {
      return {
        id: "run-1",
        automationFlowId: "flow-1",
        versionId: "v-1",
        adminId: "admin-1",
        currentNodeId: "node-1",
        executionState: { trigger: { output } },
        whatsappAccountId: "acc-1",
        ...overrides,
      } as never;
    }

    function upsell(overrides: Record<string, unknown> = {}) {
      return {
        id: "u-1",
        triggerProductId: "p-1",
        upsellProductId: "p-2",
        messageConfig: { text: "Hi {{name}}" },
        ...overrides,
      };
    }

    test("skips when order has no products", async () => {
      const result = await handler.execute(
        { branches: [] } as never,
        runWith(mockOrder({ items: [] })),
      );

      expect(result).toEqual({
        success: true,
        shouldPause: false,
        chosenBranch: "skipped",
        output: { reason: "No products in order" },
      });
      expect(getUpsellsForProducts).not.toHaveBeenCalled();
    });

    test("skips when no upsells are found", async () => {
      const result = await handler.execute(
        { branches: [] } as never,
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: true,
        shouldPause: false,
        chosenBranch: "skipped",
        output: { reason: "No upsells found for products" },
      });
    });

    test("passes variant ids excluding order items", async () => {
      getUpsellsForProducts.mockResolvedValue([]);

      await handler.execute({ branches: [] } as never, runWith(mockOrder()));

      expect(getUpsellsForProducts).toHaveBeenCalledWith(
        ["p-1"],
        "admin-1",
        ["v-1"],
      );
    });

    test("sends upsells with hydrated message config", async () => {
      getUpsellsForProducts.mockResolvedValue([
        upsell({ messageConfig: { text: "Hi {{name}}" } }),
      ]);

      const result = await handler.execute(
        { branches: [] } as never,
        runWith(mockOrder({ name: "Ada" })),
      );

      expect(sendUpsell).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "u-1",
          messageConfig: { text: "Hi Ada" },
        }),
        expect.objectContaining({ id: "order-1" }),
        expect.anything(),
      );
      expect(result.success).toBe(true);
      expect(result.shouldPause).toBe(true);
      expect(result.output).toMatchObject({
        sentUpsellsCount: 1,
        sentUpsells: [
          {
            upsellId: "u-1",
            historyId: "h-1",
            messageId: "m-1",
            triggerProductId: "p-1",
            upsellProductId: "p-2",
          },
        ],
        recipient: "01001234567",
      });
    });

    test("keeps message config as-is when absent", async () => {
      const bare = upsell();
      delete (bare as Record<string, unknown>).messageConfig;
      getUpsellsForProducts.mockResolvedValue([bare]);

      await handler.execute({ branches: [] } as never, runWith(mockOrder()));

      const [sent] = sendUpsell.mock.calls[0] as [
        { messageConfig: unknown },
      ];
      expect(sent.messageConfig).toBeUndefined();
    });

    test("skips falsy histories", async () => {
      getUpsellsForProducts.mockResolvedValue([upsell()]);
      sendUpsell.mockResolvedValue(null);

      const result = await handler.execute(
        { branches: [] } as never,
        runWith(mockOrder()),
      );

      expect(result.output).toMatchObject({
        sentUpsellsCount: 0,
        sentUpsells: [],
      });
      expect(messageFindOne).not.toHaveBeenCalled();
    });

    test("checks status of sent messages", async () => {
      getUpsellsForProducts.mockResolvedValue([upsell()]);

      await handler.execute({ branches: [] } as never, runWith(mockOrder()));

      expect(messageFindOne).toHaveBeenCalledWith({
        where: { messageId: "m-1" },
      });
    });

    test("skips status check without message id", async () => {
      getUpsellsForProducts.mockResolvedValue([upsell()]);
      sendUpsell.mockResolvedValue({ id: "h-1", messageId: null });

      const result = await handler.execute(
        { branches: [] } as never,
        runWith(mockOrder()),
      );

      expect(messageFindOne).not.toHaveBeenCalled();
      expect(result.output).toMatchObject({ sentUpsellsCount: 1 });
    });

    test("wraps failed message status", async () => {
      getUpsellsForProducts.mockResolvedValue([upsell()]);
      messageFindOne.mockResolvedValue({
        status: MessageStatus.FAILED,
        error: "no route",
      });

      const result = await handler.execute(
        { branches: [] } as never,
        runWith(mockOrder()),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("no route");
    });

    test("schedules wait-resume for no-response timeout", async () => {
      getUpsellsForProducts.mockResolvedValue([upsell()]);

      const result = await handler.execute(
        { branches: [{ isNoResponse: true, timeoutMinutes: 5 }] } as never,
        runWith(mockOrder()),
      );

      expect(enqueueWaitResume).toHaveBeenCalledWith(
        "run-1",
        "flow-1",
        "v-1",
        "admin-1",
        "node-1",
        5 * 60 * 1000,
      );
      expect(result.output).toMatchObject({
        waitMinutes: 5,
        waitMs: 5 * 60 * 1000,
      });
    });

    test("skips wait-resume for preview runs", async () => {
      getUpsellsForProducts.mockResolvedValue([upsell()]);

      const result = await handler.execute(
        { branches: [{ isNoResponse: true, timeoutMinutes: 5 }] } as never,
        runWith(mockOrder(), { previewId: "preview-1" }),
      );

      expect(enqueueWaitResume).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    test("wraps adapter errors", async () => {
      getUpsellsForProducts.mockRejectedValue(new Error("upsell down"));

      const result = await handler.execute(
        { branches: [] } as never,
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        error: "Upsell send failed: upsell down",
      });
    });

    test("wraps missing order", async () => {
      const result = await handler.execute(
        { branches: [] } as never,
        runWith({}),
      );

      expect(result).toEqual({
        success: false,
        error: "Upsell send failed: Order ID is required",
      });
    });
  });
});

void ActionAssignOrderToEmployeeHandler.prototype.execute;
describe("ActionAssignOrderToEmployeeHandler", () => {
  describe("execute", () => {
    let handler: ActionAssignOrderToEmployeeHandler;
    let assignmentFindOne: ReturnType<typeof vi.fn>;
    let manualAssign: ReturnType<typeof vi.fn>;
    let processAutoAssignment: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      assignmentFindOne = vi.fn().mockResolvedValue(null);
      manualAssign = vi.fn().mockResolvedValue("assigned");
      processAutoAssignment = vi
        .fn()
        .mockResolvedValue({ assignedCount: 0 });

      handler = new ActionAssignOrderToEmployeeHandler(
        { manualAssign, processAutoAssignment } as never,
        {} as never,
        { findOne: assignmentFindOne } as never,
        {
          ALLOWED_STATUS_CODES_FOR_ASSIGNMENT: new Set(["confirmed"]),
        } as never,
      );
    });

    function mockOrder(overrides: Record<string, unknown> = {}) {
      return {
        id: "order-1",
        orderNumber: "A-1",
        __mock: true,
        adminId: "admin-1",
        status: { code: "confirmed" },
        ...overrides,
      } as never;
    }

    function runWith(output: unknown) {
      return { executionState: { trigger: { output } } } as never;
    }

    test("rejects ineligible status", async () => {
      const result = await handler.execute(
        { employeeId: "e-1" } as never,
        runWith(mockOrder({ status: { code: "shipped" } })),
      );

      expect(result).toEqual({
        success: true,
        shouldPause: false,
        chosenBranch: "not_eligable",
        output: {
          reason: "Order status not allowed for assignment",
          orderId: "order-1",
        },
      });
      expect(manualAssign).not.toHaveBeenCalled();
      expect(processAutoAssignment).not.toHaveBeenCalled();
    });

    test("proceeds without status", async () => {
      const order = mockOrder();
      delete (order as Record<string, unknown>).status;

      await handler.execute({ employeeId: "e-1" } as never, runWith(order));

      expect(manualAssign).toHaveBeenCalledTimes(1);
    });

    test("returns existing assignment", async () => {
      assignmentFindOne.mockResolvedValue({ employeeId: "e-9" });

      const result = await handler.execute(
        { employeeId: "e-1" } as never,
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: true,
        shouldPause: false,
        chosenBranch: "assigned",
        output: {
          reason: "Order already assigned",
          orderId: "order-1",
          employeeId: "e-9",
        },
      });
      expect(manualAssign).not.toHaveBeenCalled();
    });

    test("assigns manually to configured employee", async () => {
      const order = mockOrder();
      const result = await handler.execute(
        { employeeId: "e-1" } as never,
        runWith(order),
      );

      expect(manualAssign).toHaveBeenCalledWith("e-1", order, "admin-1");
      expect(result).toMatchObject({
        success: true,
        shouldPause: false,
        chosenBranch: "assigned",
        output: { orderId: "order-1", employeeId: "e-1" },
      });
    });

    test("treats none as auto assignment", async () => {
      processAutoAssignment.mockResolvedValue({
        assignedCount: 1,
        results: [{ orderId: "order-1" }],
      });

      await handler.execute({ employeeId: "none" } as never, runWith(mockOrder()));

      expect(manualAssign).not.toHaveBeenCalled();
      expect(processAutoAssignment).toHaveBeenCalledTimes(1);
    });

    test("assigns automatically with results", async () => {
      processAutoAssignment.mockResolvedValue({
        assignedCount: 1,
        results: [{ orderId: "order-1", employeeId: "e-2" }],
      });

      const result = await handler.execute(
        {} as never,
        runWith(mockOrder()),
      );

      expect(processAutoAssignment).toHaveBeenCalledWith("admin-1", [
        expect.objectContaining({ id: "order-1" }),
      ]);
      expect(result).toMatchObject({
        success: true,
        shouldPause: false,
        chosenBranch: "assigned",
        output: {
          orderId: "order-1",
          results: [{ orderId: "order-1", employeeId: "e-2" }],
        },
      });
    });

    test("reports no matching rules", async () => {
      processAutoAssignment.mockResolvedValue({
        assignedCount: 0,
        message: "No active rules",
      });

      const result = await handler.execute(
        {} as never,
        runWith(mockOrder()),
      );

      expect(result).toMatchObject({
        success: true,
        shouldPause: false,
        chosenBranch: "no_roles_match",
        output: { orderId: "order-1", reason: "No active rules" },
      });
    });

    test("defaults reason without adapter message", async () => {
      const result = await handler.execute(
        {} as never,
        runWith(mockOrder()),
      );

      expect(result).toMatchObject({
        success: true,
        shouldPause: false,
        chosenBranch: "no_roles_match",
        output: { reason: "No matching assignment rules" },
      });
    });

    test("wraps errors generically", async () => {
      manualAssign.mockRejectedValue(new Error("db down"));

      const result = await handler.execute(
        { employeeId: "e-1" } as never,
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        shouldPause: false,
        error: "Failed to assign order",
      });
    });

    test("wraps missing order", async () => {
      const result = await handler.execute({} as never, runWith({}));

      expect(result).toEqual({
        success: false,
        shouldPause: false,
        error: "Failed to assign order",
      });
    });

    test("returns unavailable when order id is missing", async () => {
      const result = await handler.execute(
        {} as never,
        runWith({ __mock: true }),
      );

      expect(result).toEqual({
        success: false,
        shouldPause: false,
        error: "Order data not available for assignment",
      });
      expect(manualAssign).not.toHaveBeenCalled();
    });

    test("passes undefined admin without order admin id", async () => {
      const order = mockOrder({ adminId: null });

      await handler.execute({ employeeId: "e-1" } as never, runWith(order));

      expect(manualAssign).toHaveBeenCalledWith("e-1", order, null);
    });

    test("rejects status without code", async () => {
      const result = await handler.execute(
        { employeeId: "e-1" } as never,
        runWith(mockOrder({ status: {} })),
      );

      expect(result).toMatchObject({
        success: true,
        shouldPause: false,
        chosenBranch: "not_eligable",
      });
    });

    test("rejects every status with empty allowed set", async () => {
      const strict = new ActionAssignOrderToEmployeeHandler(
        { manualAssign, processAutoAssignment } as never,
        {} as never,
        { findOne: assignmentFindOne } as never,
        { ALLOWED_STATUS_CODES_FOR_ASSIGNMENT: new Set() } as never,
      );

      const result = await strict.execute(
        { employeeId: "e-1" } as never,
        runWith(mockOrder()),
      );

      expect(result).toMatchObject({ chosenBranch: "not_eligable" });
      expect(manualAssign).not.toHaveBeenCalled();
    });

    test("wraps assignment lookup errors", async () => {
      assignmentFindOne.mockRejectedValue(new Error("db down"));

      const result = await handler.execute(
        { employeeId: "e-1" } as never,
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        shouldPause: false,
        error: "Failed to assign order",
      });
    });

    test("returns existing assignment without employee id", async () => {
      assignmentFindOne.mockResolvedValue({ id: "a-1" });

      const result = await handler.execute(
        { employeeId: "e-1" } as never,
        runWith(mockOrder()),
      );

      expect(result).toMatchObject({
        chosenBranch: "assigned",
        output: { orderId: "order-1" },
      });
      expect(result.output.employeeId).toBeUndefined();
    });

    test("returns manual branch verbatim", async () => {
      manualAssign.mockResolvedValue("escalated");

      const result = await handler.execute(
        { employeeId: "e-1" } as never,
        runWith(mockOrder()),
      );

      expect(result).toMatchObject({
        success: true,
        shouldPause: false,
        chosenBranch: "escalated",
      });
    });

    test("passes undefined manual branch through", async () => {
      manualAssign.mockResolvedValue(undefined);

      const result = await handler.execute(
        { employeeId: "e-1" } as never,
        runWith(mockOrder()),
      );

      expect(result.success).toBe(true);
      expect(result.chosenBranch).toBeUndefined();
    });

    test("treats empty employee id as auto assignment", async () => {
      await handler.execute({ employeeId: "" } as never, runWith(mockOrder()));

      expect(manualAssign).not.toHaveBeenCalled();
      expect(processAutoAssignment).toHaveBeenCalledTimes(1);
    });

    test("calls manual assign with whitespace employee id", async () => {
      await handler.execute(
        { employeeId: " " } as never,
        runWith(mockOrder()),
      );

      expect(manualAssign).toHaveBeenCalledTimes(1);
      expect(processAutoAssignment).not.toHaveBeenCalled();
    });

    test("wraps auto assignment errors", async () => {
      processAutoAssignment.mockRejectedValue(new Error("rules down"));

      const result = await handler.execute(
        {} as never,
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        shouldPause: false,
        error: "Failed to assign order",
      });
    });

    test("passes undefined auto results through", async () => {
      processAutoAssignment.mockResolvedValue({ assignedCount: 2 });

      const result = await handler.execute(
        {} as never,
        runWith(mockOrder()),
      );

      expect(result).toMatchObject({
        chosenBranch: "assigned",
        output: { orderId: "order-1" },
      });
      expect(result.output.results).toBeUndefined();
    });

    test("defaults reason for empty adapter message", async () => {
      processAutoAssignment.mockResolvedValue({
        assignedCount: 0,
        message: "",
      });

      const result = await handler.execute(
        {} as never,
        runWith(mockOrder()),
      );

      expect(result).toMatchObject({
        output: { reason: "No matching assignment rules" },
      });
    });

    test("reports no match for negative assigned count", async () => {
      processAutoAssignment.mockResolvedValue({ assignedCount: -1 });

      const result = await handler.execute(
        {} as never,
        runWith(mockOrder()),
      );

      expect(result).toMatchObject({ chosenBranch: "no_roles_match" });
    });

    test("wraps message-less errors generically", async () => {
      manualAssign.mockRejectedValue({});

      const result = await handler.execute(
        { employeeId: "e-1" } as never,
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        shouldPause: false,
        error: "Failed to assign order",
      });
    });

    test("wraps non-error rejections generically", async () => {
      manualAssign.mockRejectedValue("boom-string");

      const result = await handler.execute(
        { employeeId: "e-1" } as never,
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        shouldPause: false,
        error: "Failed to assign order",
      });
    });
  });
});

void ActionSendUpsellHandler.prototype.execute;
describe("ActionSendUpsellHandler edges", () => {
  describe("execute", () => {
    let handler: ActionSendUpsellHandler;
    let getUpsellsForProducts: ReturnType<typeof vi.fn>;
    let sendUpsell: ReturnType<typeof vi.fn>;
    let messageFindOne: ReturnType<typeof vi.fn>;
    let enqueueWaitResume: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      skipHandlerWaits();
      getUpsellsForProducts = vi.fn().mockResolvedValue([]);
      sendUpsell = vi
        .fn()
        .mockResolvedValue({ id: "h-1", messageId: "m-1" });
      messageFindOne = vi
        .fn()
        .mockResolvedValue({ status: MessageStatus.DELIVERED });
      enqueueWaitResume = vi.fn().mockResolvedValue(undefined);

      handler = new ActionSendUpsellHandler(
        { getUpsellsForProducts, sendUpsell } as never,
        {} as never,
        { findOne: messageFindOne } as never,
        {} as never,
        {} as never,
        { enqueueWaitResume } as never,
      );
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function mockOrder(overrides: Record<string, unknown> = {}) {
      return {
        id: "order-1",
        orderNumber: "A-1",
        __mock: true,
        adminId: "admin-1",
        phoneNumber: "01001234567",
        items: [{ variantId: "v-1", variant: { productId: "p-1" } }],
        ...overrides,
      } as never;
    }

    function runWith(output: unknown, overrides: Record<string, unknown> = {}) {
      return {
        id: "run-1",
        automationFlowId: "flow-1",
        versionId: "v-1",
        adminId: "admin-1",
        currentNodeId: "node-1",
        executionState: { trigger: { output } },
        whatsappAccountId: "acc-1",
        ...overrides,
      } as never;
    }

    function upsell(overrides: Record<string, unknown> = {}) {
      return {
        id: "u-1",
        triggerProductId: "p-1",
        upsellProductId: "p-2",
        messageConfig: { text: "Hi" },
        ...overrides,
      };
    }

    test("skips when items are missing", async () => {
      const order = mockOrder();
      delete (order as Record<string, unknown>).items;

      const result = await handler.execute(
        { branches: [] } as never,
        runWith(order),
      );

      expect(result).toMatchObject({
        chosenBranch: "skipped",
        output: { reason: "No products in order" },
      });
    });

    test("skips when variants lack product ids", async () => {
      const result = await handler.execute(
        { branches: [] } as never,
        runWith(mockOrder({ items: [{}, { variant: {} }] })),
      );

      expect(result).toMatchObject({
        chosenBranch: "skipped",
        output: { reason: "No products in order" },
      });
      expect(getUpsellsForProducts).not.toHaveBeenCalled();
    });

    test("passes only valid product ids", async () => {
      await handler.execute(
        { branches: [] } as never,
        runWith(
          mockOrder({
            items: [
              { variantId: "v-1", variant: { productId: "p-1" } },
              {},
              { variantId: "v-2", variant: {} },
              { variantId: "v-3", variant: { productId: "p-3" } },
            ],
          }),
        ),
      );

      expect(getUpsellsForProducts).toHaveBeenCalledWith(
        ["p-1", "p-3"],
        "admin-1",
        ["v-1", "v-2", "v-3"],
      );
    });

    test("passes empty variant list without variant ids", async () => {
      getUpsellsForProducts.mockResolvedValue([]);

      await handler.execute(
        { branches: [] } as never,
        runWith(
          mockOrder({ items: [{ variant: { productId: "p-1" } }] }),
        ),
      );

      expect(getUpsellsForProducts).toHaveBeenCalledWith(
        ["p-1"],
        "admin-1",
        [],
      );
    });

    test("wraps null upsell lookup result", async () => {
      getUpsellsForProducts.mockResolvedValue(null);

      const result = await handler.execute(
        { branches: [] } as never,
        runWith(mockOrder()),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Upsell send failed:");
    });

    test("sends every upsell in the list", async () => {
      getUpsellsForProducts.mockResolvedValue([
        upsell({ id: "u-1" }),
        upsell({ id: "u-2" }),
      ]);
      sendUpsell
        .mockResolvedValueOnce({ id: "h-1", messageId: "m-1" })
        .mockResolvedValueOnce({ id: "h-2", messageId: "m-2" });

      const result = await handler.execute(
        { branches: [] } as never,
        runWith(mockOrder()),
      );

      expect(sendUpsell).toHaveBeenCalledTimes(2);
      expect(result.output).toMatchObject({
        sentUpsellsCount: 2,
        sentUpsells: [
          expect.objectContaining({ upsellId: "u-1", historyId: "h-1" }),
          expect.objectContaining({ upsellId: "u-2", historyId: "h-2" }),
        ],
      });
    });

    test("keeps only successful sends in the list", async () => {
      getUpsellsForProducts.mockResolvedValue([
        upsell({ id: "u-1" }),
        upsell({ id: "u-2" }),
      ]);
      sendUpsell
        .mockResolvedValueOnce({ id: "h-1", messageId: "m-1" })
        .mockResolvedValueOnce(null);

      const result = await handler.execute(
        { branches: [] } as never,
        runWith(mockOrder()),
      );

      expect(result.output).toMatchObject({
        sentUpsellsCount: 1,
        sentUpsells: [expect.objectContaining({ upsellId: "u-1" })],
      });
    });

    test("wraps partial send failure", async () => {
      getUpsellsForProducts.mockResolvedValue([
        upsell({ id: "u-1" }),
        upsell({ id: "u-2" }),
      ]);
      sendUpsell
        .mockResolvedValueOnce({ id: "h-1", messageId: "m-1" })
        .mockRejectedValueOnce(new Error("second down"));

      const result = await handler.execute(
        { branches: [] } as never,
        runWith(mockOrder()),
      );

      expect(sendUpsell).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        success: false,
        error: "Upsell send failed: second down",
      });
    });

    test("passes null message config as-is", async () => {
      getUpsellsForProducts.mockResolvedValue([
        upsell({ messageConfig: null }),
      ]);

      await handler.execute({ branches: [] } as never, runWith(mockOrder()));

      const [sent] = sendUpsell.mock.calls[0] as [
        { messageConfig: unknown },
      ];
      expect(sent.messageConfig).toBeNull();
    });

    test("hydrates nested message structures", async () => {
      getUpsellsForProducts.mockResolvedValue([
        upsell({
          messageConfig: {
            body: { text: "Hi {{name}}" },
            buttons: ["{{name}}"],
          },
        }),
      ]);

      await handler.execute(
        { branches: [] } as never,
        runWith(mockOrder({ name: "Ada" })),
      );

      const [sent] = sendUpsell.mock.calls[0] as [
        { messageConfig: { body: { text: string }; buttons: string[] } },
      ];
      expect(sent.messageConfig).toEqual({
        body: { text: "Hi Ada" },
        buttons: ["Ada"],
      });
    });

    test("resolves global paths in message config", async () => {
      getUpsellsForProducts.mockResolvedValue([
        upsell({ messageConfig: { text: "{{global.brandName}}" } }),
      ]);

      await handler.execute({ branches: [] } as never, runWith(mockOrder()));

      const [sent] = sendUpsell.mock.calls[0] as [
        { messageConfig: { text: string } },
      ];
      expect(sent.messageConfig).toEqual({ text: "" });
    });

    test("wraps hydration errors", async () => {
      const explosive: Record<string, unknown> = {};
      Object.defineProperty(explosive, "text", {
        enumerable: true,
        get() {
          throw new Error("boom");
        },
      });
      getUpsellsForProducts.mockResolvedValue([
        upsell({ messageConfig: explosive }),
      ]);

      const result = await handler.execute(
        { branches: [] } as never,
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        error: "Upsell send failed: boom",
      });
    });

    test("checks only histories with message ids", async () => {
      getUpsellsForProducts.mockResolvedValue([
        upsell({ id: "u-1" }),
        upsell({ id: "u-2" }),
      ]);
      sendUpsell
        .mockResolvedValueOnce({ id: "h-1", messageId: "m-1" })
        .mockResolvedValueOnce({ id: "h-2", messageId: null });

      await handler.execute({ branches: [] } as never, runWith(mockOrder()));

      expect(messageFindOne).toHaveBeenCalledTimes(1);
      expect(messageFindOne).toHaveBeenCalledWith({
        where: { messageId: "m-1" },
      });
    });

    test("wraps status lookup errors", async () => {
      getUpsellsForProducts.mockResolvedValue([upsell()]);
      messageFindOne.mockRejectedValue(new Error("db down"));

      const result = await handler.execute(
        { branches: [] } as never,
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        error: "Upsell send failed: db down",
      });
    });

    test("stays silent for missing status records", async () => {
      getUpsellsForProducts.mockResolvedValue([upsell()]);
      messageFindOne.mockResolvedValue(null);

      const result = await handler.execute(
        { branches: [] } as never,
        runWith(mockOrder()),
      );

      expect(result.success).toBe(true);
      expect(result.output).toMatchObject({ sentUpsellsCount: 1 });
    });

    test("stays silent for sent status", async () => {
      getUpsellsForProducts.mockResolvedValue([upsell()]);
      messageFindOne.mockResolvedValue({ status: MessageStatus.SENT });

      const result = await handler.execute(
        { branches: [] } as never,
        runWith(mockOrder()),
      );

      expect(result.success).toBe(true);
    });

    test("skips wait-resume for zero timeout", async () => {
      getUpsellsForProducts.mockResolvedValue([upsell()]);

      const result = await handler.execute(
        { branches: [{ isNoResponse: true, timeoutMinutes: 0 }] } as never,
        runWith(mockOrder()),
      );

      expect(enqueueWaitResume).not.toHaveBeenCalled();
      expect(result.output.waitMs).toBeUndefined();
    });

    test("skips wait-resume for negative timeout", async () => {
      getUpsellsForProducts.mockResolvedValue([upsell()]);

      await handler.execute(
        { branches: [{ isNoResponse: true, timeoutMinutes: -3 }] } as never,
        runWith(mockOrder()),
      );

      expect(enqueueWaitResume).not.toHaveBeenCalled();
    });

    test("supports string timeout minutes", async () => {
      getUpsellsForProducts.mockResolvedValue([upsell()]);

      await handler.execute(
        { branches: [{ isNoResponse: true, timeoutMinutes: "5" }] } as never,
        runWith(mockOrder()),
      );

      expect(enqueueWaitResume).toHaveBeenCalledWith(
        "run-1",
        "flow-1",
        "v-1",
        "admin-1",
        "node-1",
        5 * 60 * 1000,
      );
    });

    test("uses first no-response branch when several exist", async () => {
      getUpsellsForProducts.mockResolvedValue([upsell()]);

      await handler.execute(
        {
          branches: [
            { isNoResponse: true, timeoutMinutes: 5 },
            { isNoResponse: true, timeoutMinutes: 10 },
          ],
        } as never,
        runWith(mockOrder()),
      );

      expect(enqueueWaitResume).toHaveBeenCalledWith(
        "run-1",
        "flow-1",
        "v-1",
        "admin-1",
        "node-1",
        5 * 60 * 1000,
      );
    });

    test("sends without queue service configured", async () => {
      getUpsellsForProducts.mockResolvedValue([upsell()]);
      const withoutQueue = new ActionSendUpsellHandler(
        { getUpsellsForProducts, sendUpsell } as never,
        {} as never,
        { findOne: messageFindOne } as never,
        {} as never,
        {} as never,
        undefined as never,
      );

      const result = await withoutQueue.execute(
        { branches: [{ isNoResponse: true, timeoutMinutes: 5 }] } as never,
        runWith(mockOrder()),
      );

      expect(result.success).toBe(true);
    });

    test("wraps queue errors", async () => {
      getUpsellsForProducts.mockResolvedValue([upsell()]);
      enqueueWaitResume.mockRejectedValue(new Error("queue down"));

      const result = await handler.execute(
        { branches: [{ isNoResponse: true, timeoutMinutes: 5 }] } as never,
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        error: "Upsell send failed: queue down",
      });
    });

    test("pauses for every send", async () => {
      getUpsellsForProducts.mockResolvedValue([upsell()]);

      const result = await handler.execute(
        { branches: [] } as never,
        runWith(mockOrder()),
      );

      expect(result.shouldPause).toBe(true);
    });

    test("reports raw phone number as recipient", async () => {
      getUpsellsForProducts.mockResolvedValue([upsell()]);

      const result = await handler.execute(
        { branches: [] } as never,
        runWith(
          mockOrder({
            phoneNumber: "01001234567",
            normalizedPhoneNumber: "201001234567",
          }),
        ),
      );

      expect(result.output).toMatchObject({ recipient: "01001234567" });
    });

    test("omits wait fields without no-response branch", async () => {
      getUpsellsForProducts.mockResolvedValue([upsell()]);

      const result = await handler.execute(
        { branches: [] } as never,
        runWith(mockOrder()),
      );

      expect(result.output.waitMs).toBeUndefined();
      expect(result.output.waitMinutes).toBeUndefined();
      expect(result.output.resumeAt).toBeUndefined();
    });

    test("reports resume time as valid ISO string", async () => {
      getUpsellsForProducts.mockResolvedValue([upsell()]);
      const before = Date.now();

      const result = await handler.execute(
        { branches: [{ isNoResponse: true, timeoutMinutes: 5 }] } as never,
        runWith(mockOrder()),
      );

      const resumeAt = Date.parse(result.output.resumeAt);
      expect(resumeAt).toBeGreaterThanOrEqual(before + 5 * 60 * 1000);
    });

    test("wraps errors without message", async () => {
      getUpsellsForProducts.mockRejectedValue({});

      const result = await handler.execute(
        { branches: [] } as never,
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        error: "Upsell send failed: undefined",
      });
    });
  });
});

void ActionSendSmsHandler.prototype.execute;
describe("ActionSendSmsHandler", () => {
  describe("execute", () => {
    let handler: ActionSendSmsHandler;
    let sendSms: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      sendSms = vi.fn().mockResolvedValue({
        log: {
          id: "log-1",
          status: SmsSendStatus.SENT,
          toNumber: "201001234567",
          sender: { name: "Sys" },
          error: null,
          providerResponse: { ok: true },
          providerCode: "smseg",
        },
      });

      handler = new ActionSendSmsHandler(
        { sendSms } as never,
        {} as never,
        {} as never,
        {} as never,
      );
    });

    function mockOrder(overrides: Record<string, unknown> = {}) {
      return {
        id: "order-1",
        orderNumber: "A-1",
        __mock: true,
        adminId: "admin-1",
        normalizedPhoneNumber: "201001234567",
        phoneNumber: "01001234567",
        name: "Ada",
        ...overrides,
      } as never;
    }

    function runWith(output: unknown) {
      return { executionState: { trigger: { output } } } as never;
    }

    function config(overrides: Record<string, unknown> = {}) {
      return {
        providerCode: "smseg",
        message: "Hi {{name}}",
        ...overrides,
      } as never;
    }

    test("sends sms with hydrated message", async () => {
      const result = await handler.execute(
        config(),
        runWith(mockOrder()),
      );

      expect(sendSms).toHaveBeenCalledWith(
        { id: "admin-1", adminId: "admin-1" },
        "smseg",
        {
          toNumber: "201001234567",
          message: "Hi Ada",
          senderId: null,
        },
      );
      expect(result).toMatchObject({
        success: true,
        shouldPause: false,
        chosenBranch: "sent",
        output: {
          logId: "log-1",
          status: SmsSendStatus.SENT,
          toNumber: "201001234567",
          message: "Hi Ada",
        },
      });
    });

    test("requires provider code", async () => {
      const result = await handler.execute(
        config({ providerCode: undefined }),
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        shouldPause: false,
        error: "SMS providerCode is required",
      });
      expect(sendSms).not.toHaveBeenCalled();
    });

    test("resolves explicit to number", async () => {
      await handler.execute(
        config({ toNumber: "01001234567" }),
        runWith(mockOrder({ normalizedPhoneNumber: null, phoneNumber: null })),
      );

      const [, , dto] = sendSms.mock.calls[0] as [
        unknown,
        unknown,
        { toNumber: string },
      ];
      expect(dto.toNumber).toBe("201001234567");
    });

    test("falls back to order phone number", async () => {
      await handler.execute(
        config(),
        runWith(
          mockOrder({
            normalizedPhoneNumber: null,
            phoneNumber: "01001234567",
          }),
        ),
      );

      const [, , dto] = sendSms.mock.calls[0] as [
        unknown,
        unknown,
        { toNumber: string },
      ];
      expect(dto.toNumber).toBe("201001234567");
    });

    test("fails without any recipient", async () => {
      const result = await handler.execute(
        config(),
        runWith(mockOrder({ normalizedPhoneNumber: null, phoneNumber: null })),
      );

      expect(result).toEqual({
        success: false,
        shouldPause: false,
        error: "Recipient phone number not found",
      });
      expect(sendSms).not.toHaveBeenCalled();
    });

    test("passes sender id when configured", async () => {
      await handler.execute(
        config({ senderId: "Shop" }),
        runWith(mockOrder()),
      );

      const [, , dto] = sendSms.mock.calls[0] as [
        unknown,
        unknown,
        { senderId: string },
      ];
      expect(dto.senderId).toBe("Shop");
    });

    test("chooses failed branch for non-sent status", async () => {
      sendSms.mockResolvedValue({
        log: { id: "log-1", status: SmsSendStatus.FAILED },
      });

      const result = await handler.execute(
        config(),
        runWith(mockOrder()),
      );

      expect(result).toMatchObject({ success: true, chosenBranch: "failed" });
    });

    test("falls back to computed number without log number", async () => {
      sendSms.mockResolvedValue({
        log: { id: "log-1", status: SmsSendStatus.SENT },
      });

      const result = await handler.execute(
        config(),
        runWith(mockOrder()),
      );

      expect(result.output).toMatchObject({ toNumber: "201001234567" });
    });

    test("reports provider fields from log", async () => {
      const result = await handler.execute(
        config(),
        runWith(mockOrder()),
      );

      expect(result.output).toMatchObject({
        logId: "log-1",
        status: SmsSendStatus.SENT,
        sender: "Sys",
        erorr: null,
        response: { ok: true },
        providerCode: "smseg",
      });
    });

    test("falls back to config provider code", async () => {
      sendSms.mockResolvedValue({
        log: { id: "log-1", status: SmsSendStatus.SENT },
      });

      const result = await handler.execute(
        config({ providerCode: "other" }),
        runWith(mockOrder()),
      );

      expect(result.output).toMatchObject({ providerCode: "other" });
    });

    test("wraps missing log", async () => {
      sendSms.mockResolvedValue({});

      const result = await handler.execute(
        config(),
        runWith(mockOrder()),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("SMS send failed:");
    });

    test("wraps adapter errors", async () => {
      sendSms.mockRejectedValue(new Error("sms down"));

      const result = await handler.execute(
        config(),
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        shouldPause: false,
        error: "SMS send failed: sms down",
      });
    });

    test("wraps missing order", async () => {
      const result = await handler.execute(config(), runWith({}));

      expect(result).toEqual({
        success: false,
        shouldPause: false,
        error: "SMS send failed: Order ID is required",
      });
    });
  });
});

void ActionCreateIssueHandler.prototype.execute;
describe("ActionCreateIssueHandler", () => {
  describe("execute", () => {
    let handler: ActionCreateIssueHandler;
    let createIssue: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      createIssue = vi.fn().mockResolvedValue({
        success: true,
        issueId: "issue-1",
        issue: { id: "issue-1" },
      });

      handler = new ActionCreateIssueHandler(
        { createIssue } as never,
        {} as never,
        {} as never,
        {} as never,
      );
    });

    function mockOrder(overrides: Record<string, unknown> = {}) {
      return {
        id: "order-1",
        orderNumber: "A-1",
        __mock: true,
        adminId: "admin-1",
        name: "Ada",
        ...overrides,
      } as never;
    }

    function runWith(output: unknown) {
      return { executionState: { trigger: { output } } } as never;
    }

    function config(overrides: Record<string, unknown> = {}) {
      return {
        title: "Fix {{name}}",
        description: "Desc {{name}}",
        assignedRoleId: "role-1",
        ...overrides,
      } as never;
    }

    test("creates issue with hydrated fields", async () => {
      const result = await handler.execute(
        config(),
        runWith(mockOrder()),
      );

      expect(createIssue).toHaveBeenCalledWith(
        { adminId: "admin-1", id: "admin-1" },
        {
          title: "Fix Ada",
          description: "Desc Ada",
          orderId: "order-1",
          causeId: null,
          priority: undefined,
          statusId: null,
          assignedRoleId: "role-1",
          employeeIds: undefined,
          estimatedMinutes: undefined,
        },
      );
      expect(result).toMatchObject({
        success: true,
        shouldPause: false,
        output: { issueId: "issue-1", issue: { id: "issue-1" } },
      });
    });

    test("requires title", async () => {
      const result = await handler.execute(
        config({ title: undefined }),
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        shouldPause: false,
        error: "Issue title is required",
      });
      expect(createIssue).not.toHaveBeenCalled();
    });

    test("trims title before sending", async () => {
      await handler.execute(
        config({ title: "  Fix it  " }),
        runWith(mockOrder()),
      );

      const [, dto] = createIssue.mock.calls[0] as [
        unknown,
        { title: string },
      ];
      expect(dto.title).toBe("Fix it");
    });

    test("omits description when absent", async () => {
      const cfg = config();
      delete (cfg as Record<string, unknown>).description;

      await handler.execute(cfg, runWith(mockOrder()));

      const [, dto] = createIssue.mock.calls[0] as [
        unknown,
        { description: unknown },
      ];
      expect(dto.description).toBeUndefined();
    });

    test("passes optional fields", async () => {
      await handler.execute(
        config({
          causeId: "cause-1",
          priority: "high",
          statusId: "st-1",
          employeeIds: ["e-1", "e-2"],
          estimatedMinutes: "30",
        }),
        runWith(mockOrder()),
      );

      const [, dto] = createIssue.mock.calls[0] as [
        unknown,
        Record<string, unknown>,
      ];
      expect(dto).toMatchObject({
        causeId: "cause-1",
        priority: "high",
        statusId: "st-1",
        assignedRoleId: "role-1",
        employeeIds: ["e-1", "e-2"],
        estimatedMinutes: 30,
      });
    });

    test("drops empty optionals", async () => {
      await handler.execute(
        config({
          causeId: "",
          employeeIds: [],
          estimatedMinutes: "",
        }),
        runWith(mockOrder()),
      );

      const [, dto] = createIssue.mock.calls[0] as [
        unknown,
        Record<string, unknown>,
      ];
      expect(dto.causeId).toBeNull();
      expect(dto.statusId).toBeNull();
      expect(dto.employeeIds).toBeUndefined();
      expect(dto.estimatedMinutes).toBeUndefined();
    });

    test("propagates adapter failure flag", async () => {
      createIssue.mockResolvedValue({ success: false, issueId: null });

      const result = await handler.execute(
        config(),
        runWith(mockOrder()),
      );

      expect(result).toMatchObject({ success: false, shouldPause: false });
      expect(result.output.issueId).toBeNull();
    });

    test("wraps adapter errors", async () => {
      createIssue.mockRejectedValue(new Error("issue down"));

      const result = await handler.execute(
        config(),
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        shouldPause: false,
        error: "Issue creation failed: issue down",
      });
    });

    test("wraps missing order", async () => {
      const result = await handler.execute(config(), runWith({}));

      expect(result).toEqual({
        success: false,
        shouldPause: false,
        error: "Issue creation failed: Order ID is required",
      });
    });
  });
});

void ActionWaitHandler.prototype.execute;
describe("ActionWaitHandler", () => {
  describe("execute", () => {
    let handler: ActionWaitHandler;
    let enqueueWaitResume: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      enqueueWaitResume = vi.fn().mockResolvedValue(undefined);

      handler = new ActionWaitHandler(
        {} as never,
        { enqueueWaitResume } as never,
      );
    });

    function runWith(overrides: Record<string, unknown> = {}) {
      return {
        id: "run-1",
        automationFlowId: "flow-1",
        versionId: "v-1",
        adminId: "admin-1",
        currentNodeId: "node-1",
        executionState: { trigger: { output: {} } },
        ...overrides,
      } as never;
    }

    test("rejects zero minutes", async () => {
      const result = await handler.execute(
        { waitMinutes: 0 } as never,
        runWith(),
      );

      expect(result).toEqual({
        success: false,
        shouldPause: false,
        error: "Wait minutes must be greater than zero",
      });
      expect(enqueueWaitResume).not.toHaveBeenCalled();
    });

    test("rejects negative minutes", async () => {
      const result = await handler.execute(
        { waitMinutes: -5 } as never,
        runWith(),
      );

      expect(result).toEqual({
        success: false,
        shouldPause: false,
        error: "Wait minutes must be greater than zero",
      });
    });

    test("rejects missing config", async () => {
      const result = await handler.execute(undefined as never, runWith());

      expect(result).toEqual({
        success: false,
        shouldPause: false,
        error: "Wait minutes must be greater than zero",
      });
    });

    test("supports string minutes", async () => {
      const result = await handler.execute(
        { waitMinutes: "5" } as never,
        runWith(),
      );

      expect(result.success).toBe(true);
      expect(result.output).toMatchObject({
        waitMinutes: 5,
        waitMs: 5 * 60 * 1000,
      });
    });

    test("enqueues wait-resume with exact args", async () => {
      const before = Date.now();

      const result = await handler.execute(
        { waitMinutes: 5 } as never,
        runWith(),
      );

      expect(enqueueWaitResume).toHaveBeenCalledWith(
        "run-1",
        "flow-1",
        "v-1",
        "admin-1",
        "node-1",
        5 * 60 * 1000,
      );
      expect(result).toMatchObject({
        success: true,
        shouldPause: true,
        output: { waitMinutes: 5, waitMs: 5 * 60 * 1000 },
      });
      expect(Date.parse(result.output.resumeAt)).toBeGreaterThanOrEqual(
        before + 5 * 60 * 1000,
      );
    });

    test("simulates wait for preview runs", async () => {
      const result = await handler.execute(
        { waitMinutes: 5 } as never,
        runWith({ previewId: "preview-1" }),
      );

      expect(enqueueWaitResume).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        shouldPause: false,
        output: { waitMinutes: 5, waitMs: 5 * 60 * 1000, simulated: true },
      });
    });

    test("sends without queue service configured", async () => {
      const withoutQueue = new ActionWaitHandler({} as never, undefined as never);

      const result = await withoutQueue.execute(
        { waitMinutes: 5 } as never,
        runWith(),
      );

      expect(result.success).toBe(true);
      expect(result.shouldPause).toBe(true);
    });
  });
});

void ActionAssignOrderToClientHandler.prototype.execute;
describe("ActionAssignOrderToClientHandler", () => {
  describe("execute", () => {
    let handler: ActionAssignOrderToClientHandler;
    let attachOrderToClient: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      attachOrderToClient = vi.fn().mockResolvedValue({
        success: true,
        clientId: "client-1",
        clientCreated: false,
      });

      handler = new ActionAssignOrderToClientHandler(
        { attachOrderToClient } as never,
        {} as never,
      );
    });

    function mockOrder(overrides: Record<string, unknown> = {}) {
      return {
        id: "order-1",
        orderNumber: "A-1",
        __mock: true,
        adminId: "admin-1",
        phoneNumber: "01001234567",
        customerName: "Ada",
        email: "ada@example.com",
        clientId: null,
        ...overrides,
      } as never;
    }

    function runWith(output: unknown) {
      return { executionState: { trigger: { output } } } as never;
    }

    test("delegates with mapped order fields", async () => {
      const order = mockOrder();

      const result = await handler.execute({} as never, runWith(order));

      expect(attachOrderToClient).toHaveBeenCalledWith(
        { adminId: "admin-1", id: "admin-1" },
        {
          id: "order-1",
          adminId: "admin-1",
          phoneNumber: "01001234567",
          customerName: "Ada",
          email: "ada@example.com",
          clientId: null,
        },
        { createIfMissing: false },
      );
      expect(result).toMatchObject({
        success: true,
        shouldPause: false,
        output: { clientId: "client-1", clientCreated: false },
      });
    });

    test("enables creation when configured", async () => {
      await handler.execute(
        { createIfMissing: true } as never,
        runWith(mockOrder()),
      );

      const [, , options] = attachOrderToClient.mock.calls[0] as [
        unknown,
        unknown,
        { createIfMissing: boolean },
      ];
      expect(options).toEqual({ createIfMissing: true });
    });

    test("returns unavailable for mock order without id", async () => {
      const result = await handler.execute(
        {} as never,
        runWith({ __mock: true }),
      );

      expect(result).toEqual({
        success: false,
        shouldPause: false,
        error: "Order data not found in trigger output",
      });
      expect(attachOrderToClient).not.toHaveBeenCalled();
    });

    test("propagates adapter failure flag", async () => {
      attachOrderToClient.mockResolvedValue({
        success: false,
        error: "Order already linked to a different client",
      });

      const result = await handler.execute(
        {} as never,
        runWith(mockOrder()),
      );

      expect(result).toMatchObject({ success: false, shouldPause: false });
    });

    test("passes preview passthrough fields", async () => {
      attachOrderToClient.mockResolvedValue({
        success: true,
        clientId: "client-1",
        previewMode: true,
        skippedSideEffect: true,
      });

      const result = await handler.execute(
        {} as never,
        runWith(mockOrder()),
      );

      expect(result.output).toMatchObject({
        clientId: "client-1",
        previewMode: true,
        skippedSideEffect: true,
      });
    });

    test("wraps adapter errors", async () => {
      attachOrderToClient.mockRejectedValue(new Error("client down"));

      const result = await handler.execute(
        {} as never,
        runWith(mockOrder()),
      );

      expect(result).toEqual({
        success: false,
        shouldPause: false,
        error: "client down",
      });
    });

    test("wraps missing order", async () => {
      const result = await handler.execute({} as never, runWith({}));

      expect(result).toEqual({
        success: false,
        shouldPause: false,
        error: "Order ID is required",
      });
    });
  });
});
