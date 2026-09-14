import {
  AutomationStatus,
  FlowNodeType,
  RunStatus,
  TriggerEntityType,
  TriggerType,
} from "entities/automation.entity";
import { AutomationMigrationStrategy } from "entities/clientSettings.entity";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { TriggerDispatcherService } from "./triggerDispatcher.service";

vi.mock("src/stores/storesIntegrations/BaseStoreProvider", () => ({
  BaseStoreProvider: class BaseStoreProvider {},
  WebhookOrderPayload: {},
}));

vi.mock("src/orders/services/orders.service", () => ({
  OrdersService: class OrdersService {},
}));

vi.mock("src/queue/queues/automations.queue", () => ({
  AutomationQueueService: class AutomationQueueService {},
}));

vi.mock("src/client-settings/client-settings.service", () => ({
  ClientSettingsService: class ClientSettingsService {},
}));

function automation(overrides: Record<string, unknown> = {}) {
  return {
    id: "flow-1",
    name: "Flow",
    adminId: "admin-1",
    triggerType: TriggerType.ORDER_CREATED,
    status: AutomationStatus.PUBLISHED,
    latestVersion: {
      id: "v-2",
      flow: {
        nodes: [
          {
            id: "n-trigger",
            type: FlowNodeType.TRIGGER,
            data: { config: { runMe: true } },
          },
        ],
        edges: [],
      },
    },
    ...overrides,
  };
}

function trigger(overrides: Record<string, unknown> = {}) {
  return {
    type: TriggerType.ORDER_CREATED,
    payload: { id: "order-1" },
    entityType: TriggerEntityType.ORDER,
    entityId: "order-1",
    adminId: "admin-1",
    ...overrides,
  };
}

function services() {
  const transaction = vi.fn();
  const automationFind = vi.fn().mockResolvedValue([]);
  const automationFindOne = vi.fn();
  const runFind = vi.fn().mockResolvedValue([]);
  const runSave = vi.fn(async (run: unknown) => run);
  const orderFindOne = vi.fn();
  const enqueueStartFlow = vi.fn().mockResolvedValue(undefined);
  const getMatcher = vi.fn();
  const getCachedSettings = vi.fn().mockResolvedValue({});

  const service = new TriggerDispatcherService(
    { transaction } as never,
    { find: automationFind, findOne: automationFindOne } as never,
    { find: runFind, save: runSave } as never,
    { findOne: orderFindOne } as never,
    { enqueueStartFlow } as never,
    { getMatcher } as never,
    { getCachedSettings } as never,
  );

  return {
    service,
    transaction,
    automationFind,
    automationFindOne,
    runFind,
    runSave,
    orderFindOne,
    enqueueStartFlow,
    getMatcher,
    getCachedSettings,
  };
}

function transactionMock(savedId = "run-1") {
  const create = vi.fn((data: unknown) => ({ ...(data as object) }));
  const save = vi.fn(async (run: unknown) => ({
    id: savedId,
    ...(run as object),
  }));
  const transaction = vi.fn(async (cb: (manager: unknown) => unknown) =>
    cb({ getRepository: () => ({ create, save }) }),
  );
  return { transaction, create, save };
}

void TriggerDispatcherService.prototype.dispatch;
describe("TriggerDispatcherService dispatch", () => {
  let ctx: ReturnType<typeof services>;

  beforeEach(() => {
    ctx = services();
  });

  test("hydrates missing order payload", async () => {
    const order = { id: "order-1", adminId: "admin-1" };
    ctx.orderFindOne.mockResolvedValue(order);
    const input = trigger({ payload: null });

    await ctx.service.dispatch(input as never);

    expect(ctx.orderFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "order-1" } }),
    );
    expect(input.payload).toBe(order);
  });

  test("skips when order is missing", async () => {
    ctx.orderFindOne.mockResolvedValue(null);

    await ctx.service.dispatch(trigger({ payload: null }) as never);

    expect(ctx.automationFind).not.toHaveBeenCalled();
  });

  test("skips order lookup for non-order triggers", async () => {
    await ctx.service.dispatch(
      trigger({ entityType: "client", payload: null }) as never,
    );

    expect(ctx.orderFindOne).not.toHaveBeenCalled();
    expect(ctx.automationFind).toHaveBeenCalled();
  });

  test("keeps provided payload without lookup", async () => {
    const payload = { id: "order-1" };

    await ctx.service.dispatch(trigger({ payload }) as never);

    expect(ctx.orderFindOne).not.toHaveBeenCalled();
  });

  test("skips without admin id", async () => {
    await ctx.service.dispatch(trigger({ adminId: "" }) as never);

    expect(ctx.automationFind).not.toHaveBeenCalled();
  });

  test("skips with no automations", async () => {
    ctx.automationFind.mockResolvedValue([]);

    await ctx.service.dispatch(trigger() as never);

    expect(ctx.transaction).not.toHaveBeenCalled();
  });

  test("runs matching automations only", async () => {
    ctx.automationFind.mockResolvedValue([
      automation({ id: "flow-1" }),
      automation({
        id: "flow-2",
        latestVersion: {
          id: "v-2",
          flow: {
            nodes: [
              {
                id: "n-trigger",
                type: FlowNodeType.TRIGGER,
                data: { config: { runMe: false } },
              },
            ],
            edges: [],
          },
        },
      }),
    ]);
    ctx.getMatcher.mockReturnValue({
      shouldRun: (config: { runMe?: boolean }) => !!config?.runMe,
    });
    const { transaction } = transactionMock();
    ctx.transaction.mockImplementation(transaction);

    await ctx.service.dispatch(trigger() as never);

    expect(ctx.transaction).toHaveBeenCalledTimes(1);
    expect(ctx.enqueueStartFlow).toHaveBeenCalledTimes(1);
  });

  test("enqueues created runs with exact args", async () => {
    ctx.automationFind.mockResolvedValue([automation()]);
    ctx.getMatcher.mockReturnValue({ shouldRun: () => true });
    const { transaction } = transactionMock("run-9");
    ctx.transaction.mockImplementation(transaction);

    await ctx.service.dispatch(trigger() as never);

    expect(ctx.enqueueStartFlow).toHaveBeenCalledWith(
      "run-9",
      "flow-1",
      "v-2",
      "admin-1",
    );
  });
});

void TriggerDispatcherService.prototype.autoRetryFailedRuns;
describe("TriggerDispatcherService autoRetryFailedRuns", () => {
  let ctx: ReturnType<typeof services>;

  beforeEach(() => {
    ctx = services();
  });

  function failedRun(id: string) {
    const trigger = {
      nodeId: "n-trigger",
      type: TriggerType.ORDER_CREATED,
      output: { id: "order-1" },
    };
    return {
      id,
      versionId: "v-1",
      executionState: { trigger, steps: { "n-old": {} } },
      status: RunStatus.FAILED,
      errorMessage: "boom",
      completedNodeIds: ["n-old"],
      currentNodeId: "n-old",
    };
  }

  test("skips manual strategy", async () => {
    ctx.getCachedSettings.mockResolvedValue({
      automationMigrationStrategy: AutomationMigrationStrategy.MANUAL,
    });

    await ctx.service.autoRetryFailedRuns("admin-1", "flow-1");

    expect(ctx.automationFindOne).not.toHaveBeenCalled();
  });

  test("defaults strategy when settings lack it", async () => {
    ctx.getCachedSettings.mockResolvedValue({});
    ctx.automationFindOne.mockResolvedValue(null);

    await ctx.service.autoRetryFailedRuns("admin-1", "flow-1");

    expect(ctx.automationFindOne).toHaveBeenCalled();
  });

  test("skips without automation", async () => {
    ctx.automationFindOne.mockResolvedValue(null);

    await ctx.service.autoRetryFailedRuns("admin-1", "flow-1");

    expect(ctx.runFind).not.toHaveBeenCalled();
  });

  test("skips without latest version", async () => {
    ctx.automationFindOne.mockResolvedValue(
      automation({ latestVersion: null }),
    );

    await ctx.service.autoRetryFailedRuns("admin-1", "flow-1");

    expect(ctx.runFind).not.toHaveBeenCalled();
  });

  test("skips without failed runs", async () => {
    ctx.automationFindOne.mockResolvedValue(automation());
    ctx.runFind.mockResolvedValue([]);

    await ctx.service.autoRetryFailedRuns("admin-1", "flow-1");

    expect(ctx.runSave).not.toHaveBeenCalled();
    expect(ctx.enqueueStartFlow).not.toHaveBeenCalled();
  });

  test("migrates failed runs in batches", async () => {
    ctx.automationFindOne.mockResolvedValue(automation());
    const runs = ["r-1", "r-2", "r-3", "r-4", "r-5", "r-6"].map(failedRun);
    ctx.runFind.mockResolvedValue(runs);

    await ctx.service.autoRetryFailedRuns("admin-1", "flow-1");

    expect(ctx.runSave).toHaveBeenCalledTimes(6);
    expect(ctx.enqueueStartFlow).toHaveBeenCalledTimes(6);
    expect(ctx.enqueueStartFlow).toHaveBeenCalledWith(
      "r-1",
      "flow-1",
      "v-2",
      "admin-1",
    );
  });

  test("resets migrated runs to pending", async () => {
    ctx.automationFindOne.mockResolvedValue(automation());
    const run = failedRun("r-1");
    const originalTrigger = run.executionState.trigger;
    ctx.runFind.mockResolvedValue([run]);

    await ctx.service.autoRetryFailedRuns("admin-1", "flow-1");

    expect(run).toMatchObject({
      versionId: "v-2",
      currentNodeId: null,
      completedNodeIds: [],
      status: RunStatus.PENDING,
      errorMessage: null,
    });
    expect(run.executionState.trigger).toBe(originalTrigger);
    expect(run.executionState.steps).toEqual({});
  });
});

void TriggerDispatcherService.prototype.createRunAndQueue;
describe("TriggerDispatcherService createRunAndQueue", () => {
  let ctx: ReturnType<typeof services>;

  beforeEach(() => {
    ctx = services();
  });

  function priv() {
    return ctx.service as unknown as {
      createRunAndQueue: (
        automation: unknown,
        trigger: unknown,
      ) => Promise<{ id: string } | undefined>;
      shouldStartAutomation: (automation: unknown, trigger: unknown) => boolean;
    };
  }

  function input() {
    return {
      type: TriggerType.ORDER_CREATED,
      entityType: TriggerEntityType.ORDER,
      entityId: "order-1",
      payload: { id: "order-1" },
    };
  }

  test("skips without version", async () => {
    const { transaction } = transactionMock();
    ctx.transaction.mockImplementation(transaction);

    const result = await priv().createRunAndQueue(
      automation({ latestVersion: null }),
      input(),
    );

    expect(result).toBeUndefined();
    expect(ctx.enqueueStartFlow).not.toHaveBeenCalled();
  });

  test("skips without trigger node", async () => {
    const { transaction } = transactionMock();
    ctx.transaction.mockImplementation(transaction);
    const versionless = automation({
      latestVersion: { id: "v-2", flow: { nodes: [], edges: [] } },
    });

    const result = await priv().createRunAndQueue(versionless, input());

    expect(result).toBeUndefined();
    expect(ctx.enqueueStartFlow).not.toHaveBeenCalled();
  });

  test("creates run and enqueues", async () => {
    const { transaction, create } = transactionMock("run-9");
    ctx.transaction.mockImplementation(transaction);

    const result = await priv().createRunAndQueue(automation(), input());

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        automationFlowId: "flow-1",
        versionId: "v-2",
        adminId: "admin-1",
        status: RunStatus.PENDING,
        triggerEntityType: TriggerEntityType.ORDER,
        triggerEntityId: "order-1",
      }),
    );
    expect(ctx.enqueueStartFlow).toHaveBeenCalledWith(
      "run-9",
      "flow-1",
      "v-2",
      "admin-1",
    );
    expect(result).toMatchObject({ id: "run-9" });
  });

  test("propagates transaction errors", async () => {
    ctx.transaction.mockRejectedValue(new Error("tx down"));

    await expect(
      priv().createRunAndQueue(automation(), input()),
    ).rejects.toThrow("tx down");
    expect(ctx.enqueueStartFlow).not.toHaveBeenCalled();
  });

  test("rejects flows without nodes", () => {
    expect(
      priv().shouldStartAutomation(
        automation({ latestVersion: { flow: { nodes: [], edges: [] } } }),
        input(),
      ),
    ).toBe(false);
  });

  test("rejects flows without trigger node", () => {
    expect(
      priv().shouldStartAutomation(
        automation({
          latestVersion: {
            flow: {
              nodes: [{ id: "n-1", type: FlowNodeType.ACTION }],
              edges: [],
            },
          },
        }),
        input(),
      ),
    ).toBe(false);
  });

  test("returns matcher verdict", () => {
    ctx.getMatcher.mockReturnValue({ shouldRun: () => true });

    expect(priv().shouldStartAutomation(automation(), input())).toBe(true);
  });

  test("swallows matcher errors", () => {
    ctx.getMatcher.mockImplementation(() => {
      throw new Error("no matcher");
    });

    expect(priv().shouldStartAutomation(automation(), input())).toBe(false);
  });
});
