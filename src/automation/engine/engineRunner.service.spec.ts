import {
  ActionType,
  FlowNodeType,
  RunStatus,
} from "entities/automation.entity";
import { MessageStatus } from "entities/whatsapp.entity";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EngineRunnerService } from "./engineRunner.service";

// Isolates transitive store import chain (see auth.spec.ts pattern).
vi.mock("src/stores/storesIntegrations/BaseStoreProvider", () => ({
  BaseStoreProvider: class BaseStoreProvider {},
  WebhookOrderPayload: {},
}));

vi.mock("src/notifications/notification.service", () => ({
  NotificationService: class NotificationService {},
}));

vi.mock("common/app.gateway", () => ({
  AppGateway: class AppGateway {},
}));

vi.mock("src/upsells/upsells.service", () => ({
  UpsellsService: class UpsellsService {},
}));

vi.mock("src/whatsapp/whatsapp.service", () => ({
  WhatsappService: class WhatsappService {},
}));

vi.mock("common/translation.service", () => ({
  TranslationService: class TranslationService {},
  RequestTranslationService: class RequestTranslationService {},
}));

vi.mock("src/queue/queues/automations.queue", () => ({
  AutomationQueueService: class AutomationQueueService {},
}));

const realSetTimeout = globalThis.setTimeout.bind(globalThis);

function skipHandlerWaits() {
  vi.spyOn(globalThis, "setTimeout").mockImplementation((
    callback: () => void,
    ms?: number,
  ) => {
    if (ms === 4000) {
      (callback as () => void)();
      return 0 as unknown as NodeJS.Timeout;
    }
    return realSetTimeout(callback as never, ms as never);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

function services() {
  const transaction = vi.fn(async (cb: (m: unknown) => unknown) => {
    const stepCreate = vi.fn((data: unknown) => ({ ...(data as object) }));
    const stepSave = vi.fn(async (s: unknown) => s);
    const runSaveTx = vi.fn(async (run: unknown) => run);
    return cb({
      getRepository: (entity: { name: string }) =>
        entity.name === "AutomationRunEntity"
          ? { save: runSaveTx }
          : { create: stepCreate, save: stepSave },
    });
  });
  const runFindOne = vi.fn();
  const runSave = vi.fn(async (run: unknown) => run);
  const versionFindOne = vi.fn();
  const automationFindOne = vi.fn();
  const getHandler = vi.fn();
  const enqueueResumeFlow = vi.fn().mockResolvedValue(undefined);
  const enqueueStartFlow = vi.fn().mockResolvedValue(undefined);
  const enqueueWaitResume = vi.fn().mockResolvedValue(undefined);
  const applyUpsellByMessageId = vi.fn();
  const orderFindOne = vi.fn();
  const messageFindOne = vi.fn();
  const whatsappAccountFindOne = vi.fn().mockResolvedValue(null);
  const whatsappAccountFind = vi.fn().mockResolvedValue([]);
  const stepQb = {
    where: vi.fn().mockReturnThis(),
    orWhere: vi.fn().mockReturnThis(),
    getOne: vi.fn(),
  };
  const stepCreateQueryBuilder = vi.fn().mockReturnValue(stepQb);
  const stepFindOne = vi.fn();
  const stepSave = vi.fn(async (s: unknown) => s);
  const whatsappSendMessage = vi.fn().mockResolvedValue({});
  const tAsync = vi.fn(async (key: string) => key);
  const notifyCreate = vi.fn().mockResolvedValue(undefined);
  const emitAutomationRunStatus = vi.fn();

  const service = new EngineRunnerService(
    { transaction } as never,
    { findOne: runFindOne, save: runSave } as never,
    { findOne: versionFindOne } as never,
    { findOne: automationFindOne } as never,
    { createQueryBuilder: stepCreateQueryBuilder, findOne: stepFindOne, save: stepSave } as never,
    { findOne: messageFindOne } as never,
    { findOne: whatsappAccountFindOne, find: whatsappAccountFind } as never,
    { findOne: orderFindOne } as never,
    { getHandler } as never,
    { create: notifyCreate } as never,
    { emitAutomationRunStatus } as never,
    { applyUpsellByMessageId } as never,
    { sendMessage: whatsappSendMessage } as never,
    { tAsync } as never,
    { enqueueWaitResume, enqueueResumeFlow, enqueueStartFlow } as never,
  );

  return {
    service,
    transaction,
    runFindOne,
    runSave,
    versionFindOne,
    automationFindOne,
    getHandler,
    enqueueResumeFlow,
    enqueueStartFlow,
    enqueueWaitResume,
    applyUpsellByMessageId,
    orderFindOne,
    messageFindOne,
    whatsappAccountFindOne,
    whatsappAccountFind,
    stepQb,
    stepCreateQueryBuilder,
    stepFindOne,
    stepSave,
    whatsappSendMessage,
    tAsync,
    notifyCreate,
    emitAutomationRunStatus,
  };
}

function flow(
  nodes: Record<string, unknown>[] = [],
  edges: Record<string, unknown>[] = [],
) {
  return {
    nodes: nodes as never[],
    edges: edges as never[],
  };
}

function mockRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    status: RunStatus.PENDING,
    versionId: "v-2",
    currentNodeId: null,
    completedNodeIds: [],
    automationFlowId: "flow-1",
    adminId: "admin-1",
    executionState: {
      trigger: { nodeId: "n-trigger", type: "order_created" },
      steps: {},
    },
    version: {},
    ...overrides,
  };
}

describe("EngineRunnerService", () => {
void EngineRunnerService.prototype.startExecution;
describe("startExecution", () => {
  let ctx: ReturnType<typeof services>;

  beforeEach(() => {
    skipHandlerWaits();
    ctx = services();
  });

  function simpleVersion() {
    ctx.getHandler.mockReturnValue({
      execute: vi.fn().mockResolvedValue({ success: true, output: {} }),
    });
    return {
      id: "v-2",
      flow: flow(
        [
          { id: "n-trigger", type: FlowNodeType.TRIGGER, data: { type: "trigger" } },
          {
            id: "n-a",
            type: FlowNodeType.ACTION,
            data: { type: "a", label: "A" },
          },
        ],
        [{ source: "n-trigger", target: "n-a" }],
      ),
    };
  }

  test("rejects duplicate concurrent starts", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun());
    (ctx.service as unknown as { currentlyRunning: Set<string> })
      .currentlyRunning.add("run-1");

    const result = await ctx.service.startExecution("run-1");

    expect(result).toMatchObject({
      success: false,
      message: "Run is already in progress",
    });
    expect(ctx.runFindOne).not.toHaveBeenCalled();
  });

  test("returns not-found without run", async () => {
    ctx.runFindOne.mockResolvedValue(null);

    const result = await ctx.service.startExecution("run-1");

    expect(result).toMatchObject({ success: false, message: "Run not found" });
  });

  test("rejects non-pending statuses", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun({ status: RunStatus.COMPLETED }));

    const result = await ctx.service.startExecution("run-1");

    expect(result).toMatchObject({ success: false });
    expect(result.message).toContain("not allowed");
  });

  test("runs to completion through the loop", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun());
    ctx.versionFindOne.mockResolvedValue(simpleVersion());
    ctx.automationFindOne.mockResolvedValue({ name: "Flow" });

    const result = await ctx.service.startExecution("run-1");

    expect(result.success).toBe(true);
    expect(result.status).toBe(RunStatus.COMPLETED);
    expect(ctx.getHandler).toHaveBeenCalled();
  });

  test("fails when version is missing", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun());
    ctx.versionFindOne.mockResolvedValue(null);

    const result = await ctx.service.startExecution("run-1");

    expect(result).toMatchObject({ success: false, message: "Version not found" });
    expect((ctx.runSave.mock.calls as unknown[]).length).toBeGreaterThan(0);
  });

  test("pauses for branch choice without chosen branch", async () => {
    ctx.runFindOne.mockResolvedValue(
      mockRun({
        currentNodeId: "n-a",
        completedNodeIds: ["n-a"],
        executionState: {
          trigger: { nodeId: "n-trigger" },
          steps: { "n-a": {} },
        },
      }),
    );
    ctx.versionFindOne.mockResolvedValue({
      id: "v-2",
      flow: flow(
        [
          { id: "n-trigger", type: FlowNodeType.TRIGGER, data: {} },
          {
            id: "n-a",
            type: FlowNodeType.CONDITION,
            data: {
              label: "C",
              config: { branches: [{ id: "b-1" }] },
            },
          },
        ],
        [],
      ),
    });

    const result = await ctx.service.startExecution("run-1");

    expect(result).toMatchObject({
      success: true,
      status: RunStatus.PAUSED,
      message: "Run paused - waiting for branch choice",
    });
  });

  test("completes with no start edge", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun());
    ctx.versionFindOne.mockResolvedValue({
      id: "v-2",
      flow: flow(
        [{ id: "n-trigger", type: FlowNodeType.TRIGGER, data: {} }],
        [],
      ),
    });

    const result = await ctx.service.startExecution("run-1");

    expect(result).toMatchObject({ status: RunStatus.COMPLETED });
  });

  test("completes with handler failure branch", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun());
    ctx.versionFindOne.mockResolvedValue(simpleVersion());
    ctx.getHandler.mockReturnValue({
      execute: vi.fn().mockRejectedValue(new Error("boom")),
    });

    const result = await ctx.service.startExecution("run-1");

    expect(result.success).toBe(true);
    expect(result.status).toBe(RunStatus.FAILED);
  });

  test("clears running guard after completion", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun());
    ctx.versionFindOne.mockResolvedValue(simpleVersion());

    await ctx.service.startExecution("run-1");

    expect(
      (ctx.service as unknown as { currentlyRunning: Set<string> })
        .currentlyRunning.has("run-1"),
    ).toBe(false);
  });

  test("rejects PAUSED status as not allowed", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun({ status: RunStatus.PAUSED }));

    const result = await ctx.service.startExecution("run-1");

    expect(result).toMatchObject({ success: false, status: RunStatus.PAUSED });
    expect(result.message).toContain("not allowed");
  });

  test("rejects CANCELLED status as not allowed", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun({ status: RunStatus.CANCELLED }));

    const result = await ctx.service.startExecution("run-1");

    expect(result).toMatchObject({ success: false, status: RunStatus.CANCELLED });
    expect(result.message).toContain("not allowed");
  });

  test("allows RUNNING status to restart", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun({ status: RunStatus.RUNNING }));
    ctx.versionFindOne.mockResolvedValue(simpleVersion());

    const result = await ctx.service.startExecution("run-1");

    expect(result.success).toBe(true);
    expect(result.status).toBe(RunStatus.COMPLETED);
  });

  test("allows FAILED status to restart", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun({ status: RunStatus.FAILED }));
    ctx.versionFindOne.mockResolvedValue(simpleVersion());

    const result = await ctx.service.startExecution("run-1");

    expect(result.success).toBe(true);
    expect(result.status).toBe(RunStatus.COMPLETED);
  });

  test("pauses when handler requests pause", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun());
    ctx.versionFindOne.mockResolvedValue(simpleVersion());
    ctx.getHandler.mockReturnValue({
      execute: vi.fn().mockResolvedValue({ success: true, output: {}, shouldPause: true }),
    });

    const result = await ctx.service.startExecution("run-1");

    expect(result.success).toBe(true);
    expect(result.status).toBe(RunStatus.PAUSED);
  });

  test("fails when handler returns success false", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun());
    ctx.versionFindOne.mockResolvedValue(simpleVersion());
    ctx.getHandler.mockReturnValue({
      execute: vi.fn().mockResolvedValue({ success: false, output: {}, error: "bad step" }),
    });

    const result = await ctx.service.startExecution("run-1");

    expect(result.status).toBe(RunStatus.FAILED);
  });

  test("fails when next node is missing from flow", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun());
    ctx.versionFindOne.mockResolvedValue({
      id: "v-2",
      flow: flow(
        [{ id: "n-trigger", type: FlowNodeType.TRIGGER, data: {} }],
        [{ source: "n-trigger", target: "n-missing" }],
      ),
    });
    ctx.getHandler.mockReturnValue({
      execute: vi.fn().mockResolvedValue({ success: true, output: {} }),
    });

    const result = await ctx.service.startExecution("run-1");

    expect(result.status).toBe(RunStatus.FAILED);
  });

  test("skips already-successful step", async () => {
    ctx.runFindOne.mockResolvedValue(
      mockRun({
        executionState: {
          trigger: { nodeId: "n-trigger" },
          steps: { "n-a": { success: true, output: {} } },
        },
      }),
    );
    ctx.versionFindOne.mockResolvedValue(simpleVersion());

    const result = await ctx.service.startExecution("run-1");

    expect(result.success).toBe(true);
    expect(result.status).toBe(RunStatus.COMPLETED);
    expect(ctx.getHandler).not.toHaveBeenCalled();
  });

  test("persists FAILED state with notification and emit when handler fails", async () => {
    // Covers private failRun through public startExecution.
    const run = mockRun();
    ctx.runFindOne.mockResolvedValue(run);
    ctx.versionFindOne.mockResolvedValue(simpleVersion());
    ctx.automationFindOne.mockResolvedValue({ id: "flow-1", name: "Flow", adminId: "admin-1" });
    ctx.getHandler.mockReturnValue({
      execute: vi.fn().mockResolvedValue({ success: false, output: {}, error: "bad step" }),
    });

    const result = await ctx.service.startExecution("run-1");

    expect(result.status).toBe(RunStatus.FAILED);
    const calls = ctx.runSave.mock.calls as unknown[][];
    const saved = calls[calls.length - 1][0] as { status: string; errorMessage: string };
    expect(saved.status).toBe(RunStatus.FAILED);
    expect(saved.errorMessage).toContain("bad step");
    expect(ctx.notifyCreate).toHaveBeenCalled();
    expect(ctx.emitAutomationRunStatus).toHaveBeenCalled();
  });
});

void EngineRunnerService.prototype.resumeFromWhatsappInteraction;
describe("resumeFromWhatsappInteraction", () => {
  let ctx: ReturnType<typeof services>;

  beforeEach(() => {
    skipHandlerWaits();
    ctx = services();
  });

  test("defers when step is not yet saved", async () => {
    ctx.stepQb.getOne.mockResolvedValue(null);

    const result = await ctx.service.resumeFromWhatsappInteraction(
      "msg-1",
      "Yes",
      "b-yes",
      0,
      "admin-1",
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("deferred");
    expect(ctx.enqueueResumeFlow).toHaveBeenCalledWith(
      "admin-1",
      expect.objectContaining({
        originalMessageId: "msg-1",
        resumeAttempt: 1,
      }),
      expect.anything(),
    );
  });

  test("returns not-found when step is missing without admin context", async () => {
    ctx.stepQb.getOne.mockResolvedValue(null);

    const result = await ctx.service.resumeFromWhatsappInteraction(
      "msg-1",
      "Yes",
    );

    expect(result).toEqual({
      success: false,
      message: "No matching automation step found",
    });
    expect(ctx.enqueueResumeFlow).not.toHaveBeenCalled();
  });

  test("queries step by both messageId shapes", async () => {
    const step = {
      runId: "run-1",
      nodeId: "n-wa",
      dataType: ActionType.SEND_WHATSAPP_TEMPLATE,
      outputData: { messageId: "msg-1" },
    };
    ctx.stepQb.getOne.mockResolvedValue(step);
    ctx.runFindOne.mockResolvedValue({
      id: "run-1",
      status: RunStatus.PAUSED,
      currentNodeId: "n-wa",
      executionState: { steps: { "n-wa": { output: {} } }, trigger: { nodeId: "n-trigger" } },
    });
    ctx.versionFindOne.mockResolvedValue({
      id: "v-2",
      flow: {
        nodes: [
          {
            id: "n-wa",
            data: {
              type: ActionType.SEND_WHATSAPP_TEMPLATE,
              config: {
                branches: [
                  { id: "accept", sourceButton: { id: "b-yes" } },
                ],
              },
            },
          },
        ],
        edges: [],
      },
    });
    const resumeSpy = vi
      .spyOn(ctx.service as unknown as { resumeExecution: typeof ctx.service.resumeExecution }, "resumeExecution")
      .mockResolvedValue({ success: true, message: "", runId: "run-1" });

    await ctx.service.resumeFromWhatsappInteraction("msg-1", "Yes", "b-yes");

    expect(ctx.stepQb.where).toHaveBeenCalledWith(
      expect.stringContaining("messageId"),
      { messageId: "msg-1" },
    );
    expect(ctx.stepQb.orWhere).toHaveBeenCalled();
    expect(resumeSpy).toHaveBeenCalled();
  });

  test("returns not-found when run is missing", async () => {
    const step = {
      runId: "run-1",
      nodeId: "n-wa",
      dataType: ActionType.SEND_WHATSAPP_TEMPLATE,
      outputData: { messageId: "msg-1" },
    };
    ctx.stepQb.getOne.mockResolvedValue(step);
    ctx.runFindOne.mockResolvedValue(null);

    const result = await ctx.service.resumeFromWhatsappInteraction(
      "msg-1",
      "Yes",
      "b-yes",
    );

    expect(result).toEqual({
      success: false,
      message: "Run not found",
      runId: "run-1",
    });
  });

  test("defers while run is still running", async () => {
    const step = {
      runId: "run-1",
      nodeId: "n-wa",
      dataType: ActionType.SEND_WHATSAPP_TEMPLATE,
      outputData: { messageId: "msg-1" },
    };
    ctx.stepQb.getOne.mockResolvedValue(step);
    ctx.runFindOne.mockResolvedValue({
      id: "run-1",
      adminId: "admin-1",
      status: RunStatus.RUNNING,
    });

    const result = await ctx.service.resumeFromWhatsappInteraction(
      "msg-1",
      "Yes",
      "b-yes",
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("deferred");
    expect(ctx.enqueueResumeFlow).toHaveBeenCalled();
  });

  test("rejects after max deferrals while still running", async () => {
    const step = {
      runId: "run-1",
      nodeId: "n-wa",
      dataType: ActionType.SEND_WHATSAPP_TEMPLATE,
      outputData: { messageId: "msg-1" },
    };
    ctx.stepQb.getOne.mockResolvedValue(step);
    ctx.runFindOne.mockResolvedValue({
      id: "run-1",
      status: RunStatus.RUNNING,
    });

    const result = await ctx.service.resumeFromWhatsappInteraction(
      "msg-1",
      "Yes",
      "b-yes",
      3,
      "admin-1",
    );

    expect(result).toEqual({
      success: false,
      message: "Run is not in PAUSED state",
      runId: "run-1",
      status: RunStatus.RUNNING,
    });
    expect(ctx.enqueueResumeFlow).not.toHaveBeenCalled();
  });

  test("rejects non-paused runs", async () => {
    const step = {
      runId: "run-1",
      nodeId: "n-wa",
      dataType: ActionType.SEND_WHATSAPP_TEMPLATE,
      outputData: { messageId: "msg-1" },
    };
    ctx.stepQb.getOne.mockResolvedValue(step);
    ctx.runFindOne.mockResolvedValue({
      id: "run-1",
      status: RunStatus.COMPLETED,
    });

    const result = await ctx.service.resumeFromWhatsappInteraction(
      "msg-1",
      "Yes",
      "b-yes",
    );

    expect(result).toEqual({
      success: false,
      message: "Run is not in PAUSED state",
      runId: "run-1",
      status: RunStatus.COMPLETED,
    });
  });

  test("rejects node mismatch", async () => {
    const step = {
      runId: "run-1",
      nodeId: "n-wa",
      dataType: ActionType.SEND_WHATSAPP_TEMPLATE,
      outputData: { messageId: "msg-1" },
    };
    ctx.stepQb.getOne.mockResolvedValue(step);
    ctx.runFindOne.mockResolvedValue({
      id: "run-1",
      status: RunStatus.PAUSED,
      currentNodeId: "n-other",
      executionState: { steps: { "n-wa": {} }, trigger: { nodeId: "n-trigger" } },
    });
    ctx.versionFindOne.mockResolvedValue({
      id: "v-2",
      flow: { nodes: [{ id: "n-wa", data: { config: { branches: [] } } }], edges: [] },
    });

    const result = await ctx.service.resumeFromWhatsappInteraction(
      "msg-1",
      "Yes",
      "b-yes",
    );

    expect(result).toEqual({
      success: false,
      message: "Current node ID does not match step node ID",
      runId: "run-1",
      status: RunStatus.FAILED,
    });
  });

  test("returns version-not-found", async () => {
    const step = {
      runId: "run-1",
      nodeId: "n-wa",
      dataType: ActionType.SEND_WHATSAPP_TEMPLATE,
      outputData: { messageId: "msg-1" },
    };
    ctx.stepQb.getOne.mockResolvedValue(step);
    ctx.runFindOne.mockResolvedValue({
      id: "run-1",
      status: RunStatus.PAUSED,
      currentNodeId: "n-wa",
      executionState: { steps: { "n-wa": {} }, trigger: { nodeId: "n-trigger" } },
    });
    ctx.versionFindOne.mockResolvedValue(null);

    const result = await ctx.service.resumeFromWhatsappInteraction(
      "msg-1",
      "Yes",
      "b-yes",
    );

    expect(result).toEqual({
      success: false,
      message: "Version not found",
      runId: "run-1",
    });
  });

  test("delegates to address-conflict reentry when flagged", async () => {
    const step = {
      runId: "run-1",
      nodeId: "n-ai",
      dataType: ActionType.AI_ADDRESS_CORRECTION,
      outputData: { messageId: "msg-1" },
    };
    const run = {
      id: "run-1",
      status: RunStatus.PAUSED,
      currentNodeId: "n-ai",
      executionState: {
        trigger: { nodeId: "n-trigger" },
        steps: {
          "n-ai": {
            output: { pendingAddressConflict: true, messageId: "msg-1" },
          },
        },
      },
    };
    ctx.stepQb.getOne.mockResolvedValue(step);
    ctx.runFindOne.mockResolvedValue(run);
    ctx.versionFindOne.mockResolvedValue({ id: "v-2", flow: { nodes: [], edges: [] } });
    const reenter = vi
      .spyOn(ctx.service as unknown as { reenterPausedNode: (a: string, b: string) => Promise<unknown> }, "reenterPausedNode")
      .mockResolvedValue({ success: true, runId: "run-1" });
    vi.spyOn(ctx.service as unknown as { messageRepo: { findOne: unknown } }, "messageRepo", "get").mockReturnValue({
      findOne: vi.fn().mockResolvedValue({ status: MessageStatus.DELIVERED }),
    });

    const result = await ctx.service.resumeFromWhatsappInteraction(
      "msg-1",
      "Row 2",
      "addr_1",
    );

    expect(reenter).toHaveBeenCalledWith("run-1", "n-ai");
    expect(result.success).toBe(true);
  });

  test("matches branch by button and resumes", async () => {
    const step = {
      runId: "run-1",
      nodeId: "n-wa",
      dataType: ActionType.SEND_WHATSAPP_TEMPLATE,
      outputData: { messageId: "msg-1" },
    };
    const run = {
      id: "run-1",
      status: RunStatus.PAUSED,
      currentNodeId: "n-wa",
      executionState: {
        trigger: { nodeId: "n-trigger" },
        steps: { "n-wa": { output: { messageId: "msg-1" } } },
      },
    };
    ctx.stepQb.getOne.mockResolvedValue(step);
    ctx.runFindOne.mockResolvedValue(run);
    ctx.versionFindOne.mockResolvedValue({
      id: "v-2",
      flow: {
        nodes: [
          {
            id: "n-wa",
            data: {
              type: ActionType.SEND_WHATSAPP_TEMPLATE,
              config: {
                branches: [
                  { id: "accept", sourceButton: { id: "b-yes" } },
                  { id: "reject", label: "reject" },
                ],
              },
            },
          },
        ],
        edges: [],
      },
    });
    const resume = vi
      .spyOn(ctx.service as unknown as { resumeExecution: typeof ctx.service.resumeExecution }, "resumeExecution")
      .mockResolvedValue({ success: true, runId: "run-1", status: RunStatus.PAUSED, message: "Automation resumed successfully" });

    const result = await ctx.service.resumeFromWhatsappInteraction(
      "msg-1",
      "Yes",
      "b-yes",
    );

    expect(resume).toHaveBeenCalledWith("run-1", "n-wa", "accept");
    expect(result).toEqual({
      success: true,
      message: "Automation resumed successfully",
      runId: "run-1",
      status: RunStatus.PAUSED,
    });
  });

  test("falls back to catch-all branch", async () => {
    const step = {
      runId: "run-1",
      nodeId: "n-wa",
      dataType: ActionType.SEND_WHATSAPP_TEMPLATE,
      outputData: { messageId: "msg-1" },
    };
    const run = {
      id: "run-1",
      status: RunStatus.PAUSED,
      currentNodeId: "n-wa",
      executionState: {
        trigger: { nodeId: "n-trigger" },
        steps: { "n-wa": { output: {} } },
      },
    };
    ctx.stepQb.getOne.mockResolvedValue(step);
    ctx.runFindOne.mockResolvedValue(run);
    ctx.versionFindOne.mockResolvedValue({
      id: "v-2",
      flow: {
        nodes: [
          {
            id: "n-wa",
            data: {
              type: ActionType.SEND_WHATSAPP_TEMPLATE,
              config: {
                branches: [
                  { id: "specific", sourceButton: { id: "b-other" } },
                  { id: "catch", isCatchAll: true },
                ],
              },
            },
          },
        ],
        edges: [],
      },
    });
    const resume = vi
      .spyOn(ctx.service as unknown as { resumeExecution: typeof ctx.service.resumeExecution }, "resumeExecution")
      .mockResolvedValue({ success: true, message: "resumed", runId: "run-1", status: RunStatus.RUNNING });

    await ctx.service.resumeFromWhatsappInteraction("msg-1", "Unknown", "b-unknown");

    expect(resume).toHaveBeenCalledWith("run-1", "n-wa", "catch");
  });

  test("fails on no matching branch", async () => {
    const step = {
      runId: "run-1",
      nodeId: "n-wa",
      dataType: ActionType.SEND_WHATSAPP_TEMPLATE,
      outputData: { messageId: "msg-1" },
    };
    const run = {
      id: "run-1",
      status: RunStatus.PAUSED,
      currentNodeId: "n-wa",
      executionState: {
        trigger: { nodeId: "n-trigger" },
        steps: { "n-wa": { output: {} } },
      },
    };
    ctx.stepQb.getOne.mockResolvedValue(step);
    ctx.runFindOne.mockResolvedValue(run);
    ctx.versionFindOne.mockResolvedValue({
      id: "v-2",
      flow: {
        nodes: [
          {
            id: "n-wa",
            data: {
              config: {
                branches: [
                  { id: "accept", sourceButton: { id: "b-yes" } },
                ],
              },
            },
          },
        ],
        edges: [],
      },
    });

    const result = await ctx.service.resumeFromWhatsappInteraction(
      "msg-1",
      "Nope",
      "b-nope",
    );

    expect(result).toEqual({
      success: false,
      message: "No matching branch found",
      runId: "run-1",
      status: RunStatus.FAILED,
    });
  });

  test("records button choice before resuming", async () => {
    const step = {
      runId: "run-1",
      nodeId: "n-wa",
      dataType: ActionType.SEND_WHATSAPP_TEMPLATE,
      outputData: { messageId: "msg-1" },
    };
    const run = {
      id: "run-1",
      status: RunStatus.PAUSED,
      currentNodeId: "n-wa",
      executionState: {
        trigger: { nodeId: "n-trigger" },
        steps: { "n-wa": { output: { messageId: "msg-1" } } },
      },
    };
    ctx.stepQb.getOne.mockResolvedValue(step);
    ctx.runFindOne.mockResolvedValue(run);
    ctx.versionFindOne.mockResolvedValue({
      id: "v-2",
      flow: {
        nodes: [
          {
            id: "n-wa",
            data: {
              type: ActionType.SEND_WHATSAPP_TEMPLATE,
              config: {
                branches: [{ id: "accept", sourceButton: { id: "b-yes" } }],
              },
            },
          },
        ],
        edges: [],
      },
    });
    const resume = vi
      .spyOn(ctx.service as unknown as { resumeExecution: typeof ctx.service.resumeExecution }, "resumeExecution")
      .mockResolvedValue({ success: true, message: "resumed", runId: "run-1", status: RunStatus.RUNNING });

    await ctx.service.resumeFromWhatsappInteraction("msg-1", "Yes", "b-yes");

    expect(run.executionState.steps["n-wa"].output).toMatchObject({
      buttonClicked: "Yes",
      chosenBranchId: "accept",
    });
    expect(ctx.runSave).toHaveBeenCalled();
    expect(resume).toHaveBeenCalledWith("run-1", "n-wa", "accept");
  });

  test("applies upsell and follows accept branch on success", async () => {
    const step = {
      runId: "run-1",
      nodeId: "n-up",
      dataType: ActionType.SEND_UPSELL,
      outputData: { messageId: "msg-1" },
    };
    const run = {
      id: "run-1",
      status: RunStatus.PAUSED,
      currentNodeId: "n-up",
      versionId: "v-2",
      adminId: "admin-1",
      triggerEntityId: "order-1",
      executionState: {
        trigger: { nodeId: "n-trigger", output: { adminId: "admin-1", id: "order-1" } },
        steps: { "n-up": { output: { messageId: "msg-1" } } },
      },
    };
    ctx.stepQb.getOne.mockResolvedValue(step);
    ctx.runFindOne.mockResolvedValue(run);
    ctx.versionFindOne.mockResolvedValue({
      id: "v-2",
      flow: {
        nodes: [
          {
            id: "n-up",
            data: {
              type: ActionType.SEND_UPSELL,
              config: { branches: [{ id: "accept" }, { id: "reject" }] },
            },
          },
        ],
        edges: [],
      },
    });
    ctx.applyUpsellByMessageId.mockResolvedValue({ success: true, code: "SUCCESS" });
    ctx.orderFindOne.mockResolvedValue({ normalizedPhoneNumber: "01001234567" });
    const resume = vi
      .spyOn(ctx.service as unknown as { resumeExecution: typeof ctx.service.resumeExecution }, "resumeExecution")
      .mockResolvedValue({ success: true, message: "resumed", runId: "run-1", status: RunStatus.RUNNING });

    const result = await ctx.service.resumeFromWhatsappInteraction("msg-1", "Accept", "x_btn_0");

    expect(ctx.applyUpsellByMessageId).toHaveBeenCalledWith({ adminId: "admin-1" }, "msg-1");
    expect(ctx.whatsappSendMessage).toHaveBeenCalled();
    expect(resume).toHaveBeenCalledWith("run-1", "n-up", "accept");
    expect(result.success).toBe(true);
  });

  test("follows client_reject branch without applying upsell", async () => {
    const step = {
      runId: "run-1",
      nodeId: "n-up",
      dataType: ActionType.SEND_UPSELL,
      outputData: { messageId: "msg-1" },
    };
    const run = {
      id: "run-1",
      status: RunStatus.PAUSED,
      currentNodeId: "n-up",
      versionId: "v-2",
      adminId: "admin-1",
      executionState: {
        trigger: { nodeId: "n-trigger", output: { adminId: "admin-1" } },
        steps: { "n-up": { output: { messageId: "msg-1" } } },
      },
    };
    ctx.stepQb.getOne.mockResolvedValue(step);
    ctx.runFindOne.mockResolvedValue(run);
    ctx.versionFindOne.mockResolvedValue({
      id: "v-2",
      flow: {
        nodes: [
          {
            id: "n-up",
            data: {
              type: ActionType.SEND_UPSELL,
              config: { branches: [{ id: "client_reject" }] },
            },
          },
        ],
        edges: [],
      },
    });
    const resume = vi
      .spyOn(ctx.service as unknown as { resumeExecution: typeof ctx.service.resumeExecution }, "resumeExecution")
      .mockResolvedValue({ success: true, message: "resumed", runId: "run-1", status: RunStatus.RUNNING });

    await ctx.service.resumeFromWhatsappInteraction("msg-1", "Reject", "x_btn_1");

    expect(ctx.applyUpsellByMessageId).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledWith("run-1", "n-up", "client_reject");
  });

  test("fails run when upsell apply throws", async () => {
    const step = {
      runId: "run-1",
      nodeId: "n-up",
      dataType: ActionType.SEND_UPSELL,
      outputData: { messageId: "msg-1" },
    };
    const run = {
      id: "run-1",
      status: RunStatus.PAUSED,
      currentNodeId: "n-up",
      versionId: "v-2",
      adminId: "admin-1",
      executionState: {
        trigger: { nodeId: "n-trigger", output: { adminId: "admin-1" } },
        steps: { "n-up": { output: { messageId: "msg-1" } } },
      },
    };
    ctx.stepQb.getOne.mockResolvedValue(step);
    ctx.runFindOne.mockResolvedValue(run);
    ctx.applyUpsellByMessageId.mockRejectedValue(new Error("upsell down"));

    const result = await ctx.service.resumeFromWhatsappInteraction("msg-1", "Accept", "x_btn_0");

    expect(result).toMatchObject({ success: false, status: RunStatus.FAILED });
    expect(result.message).toContain("upsell down");
  });

  test("treats deleted address-choice sentinel as deleted", async () => {
    const step = {
      runId: "run-1",
      nodeId: "n-ai",
      dataType: ActionType.AI_ADDRESS_CORRECTION,
      outputData: { messageId: "msg-1" },
    };
    const run = {
      id: "run-1",
      status: RunStatus.PAUSED,
      currentNodeId: "n-ai",
      adminId: "admin-1",
      executionState: {
        trigger: { nodeId: "n-trigger" },
        steps: { "n-ai": { output: { pendingAddressConflict: true } } },
      },
    };
    ctx.stepQb.getOne.mockResolvedValue(step);
    ctx.runFindOne.mockResolvedValue(run);
    ctx.versionFindOne.mockResolvedValue({ id: "v-2", flow: { nodes: [], edges: [] } });
    const reenter = vi
      .spyOn(ctx.service as unknown as { reenterPausedNode: (a: string, b: string) => Promise<unknown> }, "reenterPausedNode")
      .mockResolvedValue({ success: true, runId: "run-1" });

    const result = await ctx.service.resumeFromWhatsappInteraction(
      "msg-1",
      "__address_choice_deleted__",
      "__address_choice_deleted__",
    );

    expect(reenter).toHaveBeenCalledWith("run-1", "n-ai");
    expect(result.success).toBe(true);
    expect(result.message).toContain("deleted");
  });

  test("re-enters paused address node and re-executes it", async () => {
    // Covers private resumeAddressConflictChoice + reenterPausedNode
    // through public resumeFromWhatsappInteraction without spying them out.
    const step = {
      runId: "run-1",
      nodeId: "n-ai",
      dataType: ActionType.AI_ADDRESS_CORRECTION,
      outputData: { messageId: "msg-1" },
      status: "paused",
      errorMessage: "old",
    };
    const run = {
      id: "run-1",
      status: RunStatus.PAUSED,
      currentNodeId: "n-ai",
      adminId: "admin-1",
      versionId: "v-2",
      automationFlowId: "flow-1",
      completedNodeIds: [],
      executionState: {
        trigger: { nodeId: "n-trigger" },
        steps: {
          "n-ai": {
            type: ActionType.AI_ADDRESS_CORRECTION,
            executedAt: new Date().toISOString(),
            success: false,
            input: { orderId: "order-1" },
            output: { pendingAddressConflict: true },
          },
        },
      },
    };
    ctx.stepQb.getOne.mockResolvedValue(step);
    ctx.runFindOne.mockResolvedValue(run);
    ctx.versionFindOne.mockResolvedValue({
      id: "v-2",
      flow: {
        nodes: [
          { id: "n-ai", type: FlowNodeType.ACTION, data: { type: ActionType.AI_ADDRESS_CORRECTION, label: "AI" } },
        ],
        edges: [],
      },
    });
    ctx.messageFindOne.mockResolvedValue({ status: "delivered" });
    ctx.automationFindOne.mockResolvedValue({ id: "flow-1", name: "Flow", adminId: "admin-1" });
    const execute = vi.fn().mockResolvedValue({ success: true, output: { fixed: true } });
    ctx.getHandler.mockReturnValue({ execute });

    const result = await ctx.service.resumeFromWhatsappInteraction("msg-1", "Row 2", "addr_1");

    expect(result.success).toBe(true);
    expect(result.message).toContain("resolved");
    expect(ctx.messageFindOne).toHaveBeenCalled();
    expect(ctx.stepSave).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success", errorMessage: null }),
    );
    expect(execute).toHaveBeenCalled();
    expect(
      (ctx.service as unknown as { currentlyRunning: Set<string> }).currentlyRunning.has("run-1"),
    ).toBe(false);
  });

  test("marks deleted message and continues as not-corrected", async () => {
    // Covers private deleted-message branch through public resume.
    const step = {
      runId: "run-1",
      nodeId: "n-ai",
      dataType: ActionType.AI_ADDRESS_CORRECTION,
      outputData: { messageId: "msg-1" },
      status: "paused",
      errorMessage: "old",
    };
    const run = {
      id: "run-1",
      status: RunStatus.PAUSED,
      currentNodeId: "n-ai",
      adminId: "admin-1",
      versionId: "v-2",
      automationFlowId: "flow-1",
      completedNodeIds: [],
      executionState: {
        trigger: { nodeId: "n-trigger" },
        steps: {
          "n-ai": {
            type: ActionType.AI_ADDRESS_CORRECTION,
            executedAt: new Date().toISOString(),
            success: false,
            output: { pendingAddressConflict: true },
          },
        },
      },
    };
    ctx.stepQb.getOne.mockResolvedValue(step);
    ctx.runFindOne.mockResolvedValue(run);
    ctx.versionFindOne.mockResolvedValue({
      id: "v-2",
      flow: {
        nodes: [
          { id: "n-ai", type: FlowNodeType.ACTION, data: { type: ActionType.AI_ADDRESS_CORRECTION, label: "AI" } },
        ],
        edges: [],
      },
    });
    ctx.messageFindOne.mockResolvedValue({ status: "deleted" });
    ctx.automationFindOne.mockResolvedValue({ id: "flow-1", name: "Flow", adminId: "admin-1" });
    ctx.getHandler.mockReturnValue({
      execute: vi.fn().mockResolvedValue({ success: true, output: {} }),
    });

    const result = await ctx.service.resumeFromWhatsappInteraction("msg-1", "Row 2", "addr_1");

    expect(result.success).toBe(true);
    expect(result.message).toContain("deleted");
    expect(ctx.stepSave).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success" }),
    );
  });
});

void EngineRunnerService.prototype.resumeExecution;
describe("resumeExecution", () => {
  let ctx: ReturnType<typeof services>;

  beforeEach(() => {
    skipHandlerWaits();
    ctx = services();
  });

  test("rejects when run is already being executed", async () => {
    (ctx.service as unknown as { currentlyRunning: Set<string> })
      .currentlyRunning.add("run-1");

    const result = await ctx.service.resumeExecution("run-1", "n-wa");

    expect(result).toMatchObject({ success: false, message: "Run is already in progress" });
    expect(ctx.runFindOne).not.toHaveBeenCalled();
  });

  test("returns not-found when run is missing", async () => {
    ctx.runFindOne.mockResolvedValue(null);

    const result = await ctx.service.resumeExecution("run-1", "n-wa");

    expect(result).toMatchObject({ success: false, message: "Run not found" });
  });

  test("sets run to RUNNING before execution", async () => {
    const savedStatuses: string[] = [];
    ctx.runSave.mockImplementation(async (run: any) => {
      savedStatuses.push(run.status);
      return run;
    });
    ctx.runFindOne.mockResolvedValue(mockRun({ status: RunStatus.PAUSED }));
    ctx.versionFindOne.mockResolvedValue({
      id: "v-2",
      flow: flow(
        [{ id: "n-wa", type: FlowNodeType.ACTION, data: { type: "a", label: "A" } }],
        [],
      ),
    });

    await ctx.service.resumeExecution("run-1", "n-wa");

    expect(savedStatuses).toContain(RunStatus.RUNNING);
  });

  test("completes when no next node is found", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun({ status: RunStatus.PAUSED }));
    ctx.versionFindOne.mockResolvedValue({
      id: "v-2",
      flow: flow(
        [{ id: "n-wa", type: FlowNodeType.ACTION, data: { type: "a", label: "A" } }],
        [],
      ),
    });

    const result = await ctx.service.resumeExecution("run-1", "n-wa");

    expect(result).toMatchObject({
      success: true,
      status: RunStatus.COMPLETED,
      message: "Run completed (no next node found)",
    });
  });

  test("follows edge to next node and runs the loop", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun({ status: RunStatus.PAUSED }));
    ctx.versionFindOne.mockResolvedValue({
      id: "v-2",
      flow: flow(
        [
          { id: "n-wa", type: FlowNodeType.ACTION, data: { type: "a", label: "A" } },
          { id: "n-next", type: FlowNodeType.ACTION, data: { type: "b", label: "B" } },
        ],
        [{ source: "n-wa", target: "n-next" }],
      ),
    });
    const execute = vi.fn().mockResolvedValue({ success: true, output: {} });
    ctx.getHandler.mockReturnValue({ execute });

    const result = await ctx.service.resumeExecution("run-1", "n-wa");

    expect(execute).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.status).toBe(RunStatus.COMPLETED);
  });

  test("uses chosenBranchId to find the correct edge", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun({ status: RunStatus.PAUSED }));
    ctx.versionFindOne.mockResolvedValue({
      id: "v-2",
      flow: flow(
        [
          { id: "n-c", type: FlowNodeType.CONDITION, data: { type: "cond", label: "C" } },
          { id: "n-yes", type: FlowNodeType.ACTION, data: { type: "a", label: "Y" } },
          { id: "n-no", type: FlowNodeType.ACTION, data: { type: "a", label: "N" } },
        ],
        [
          { source: "n-c", target: "n-yes", sourceHandle: "yes" },
          { source: "n-c", target: "n-no", sourceHandle: "no" },
        ],
      ),
    });
    const execute = vi.fn().mockResolvedValue({ success: true, output: {} });
    ctx.getHandler.mockReturnValue({ execute });

    const result = await ctx.service.resumeExecution("run-1", "n-c", "yes");

    expect(result.success).toBe(true);
    expect(result.status).toBe(RunStatus.COMPLETED);
  });

  test("clears running guard even on handler failure", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun({ status: RunStatus.PAUSED }));
    ctx.versionFindOne.mockResolvedValue({
      id: "v-2",
      flow: flow(
        [{ id: "n-wa", type: FlowNodeType.ACTION, data: { type: "a", label: "A" } }],
        [],
      ),
    });
    ctx.getHandler.mockReturnValue({
      execute: vi.fn().mockRejectedValue(new Error("boom")),
    });

    await ctx.service.resumeExecution("run-1", "n-wa");

    expect(
      (ctx.service as unknown as { currentlyRunning: Set<string> })
        .currentlyRunning.has("run-1"),
    ).toBe(false);
  });

  test("marks run FAILED when handler throws", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun({ status: RunStatus.PAUSED }));
    ctx.versionFindOne.mockResolvedValue({
      id: "v-2",
      flow: flow(
        [
          { id: "n-wa", type: FlowNodeType.ACTION, data: { type: "a", label: "A" } },
          { id: "n-after", type: FlowNodeType.ACTION, data: { type: "b", label: "B" } },
        ],
        [{ source: "n-wa", target: "n-after" }],
      ),
    });
    ctx.getHandler.mockReturnValue({
      execute: vi.fn().mockRejectedValue(new Error("boom")),
    });
    ctx.automationFindOne.mockResolvedValue({ name: "Flow", adminId: "admin-1" });

    const result = await ctx.service.resumeExecution("run-1", "n-wa");

    expect(result.status).toBe(RunStatus.FAILED);
  });

  test("marks run COMPLETED when runLoop exhausts nodes", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun({ status: RunStatus.PAUSED }));
    ctx.versionFindOne.mockResolvedValue({
      id: "v-2",
      flow: flow(
        [
          { id: "n-wa", type: FlowNodeType.ACTION, data: { type: "a", label: "A" } },
        ],
        [],
      ),
    });
    const execute = vi.fn().mockResolvedValue({ success: true, output: {} });
    ctx.getHandler.mockReturnValue({ execute });
    ctx.automationFindOne.mockResolvedValue({ name: "Flow", adminId: "admin-1" });

    const result = await ctx.service.resumeExecution("run-1", "n-wa");

    expect(result).toMatchObject({ success: true, status: RunStatus.COMPLETED });
  });

  test("returns version-not-found when version is missing", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun({ status: RunStatus.PAUSED }));
    ctx.versionFindOne.mockResolvedValue(null);

    const result = await ctx.service.resumeExecution("run-1", "n-wa");

    expect(result).toEqual({ success: false, message: "Version not found", runId: "run-1" });
    expect(
      (ctx.service as unknown as { currentlyRunning: Set<string> }).currentlyRunning.has("run-1"),
    ).toBe(false);
  });
});

void EngineRunnerService.prototype.resumeFromWait;
describe("resumeFromWait", () => {
  let ctx: ReturnType<typeof services>;

  beforeEach(() => {
    skipHandlerWaits();
    ctx = services();
  });

  test("returns not-found when run is missing", async () => {
    ctx.runFindOne.mockResolvedValue(null);

    const result = await ctx.service.resumeFromWait("run-1", "n-wait");

    expect(result).toMatchObject({ success: false, message: "Run not found" });
  });

  test("rejects when run status is not PAUSED", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun({ status: RunStatus.RUNNING, currentNodeId: "n-wait" }));

    const result = await ctx.service.resumeFromWait("run-1", "n-wait");

    expect(result).toMatchObject({ success: false, message: "Run is not paused at the expected wait node" });
  });

  test("rejects when currentNodeId does not match waitNodeId", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun({ status: RunStatus.PAUSED, currentNodeId: "n-other" }));

    const result = await ctx.service.resumeFromWait("run-1", "n-wait");

    expect(result).toMatchObject({ success: false, message: "Run is not paused at the expected wait node" });
  });

  test("passes chosenBranchId from isNoResponse branch", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun({ status: RunStatus.PAUSED, currentNodeId: "n-wait" }));
    ctx.versionFindOne.mockResolvedValue({
      id: "v-2",
      flow: flow(
        [
          {
            id: "n-wait",
            type: FlowNodeType.ACTION,
            data: {
              type: ActionType.SEND_WHATSAPP_TEMPLATE,
              config: {
                branches: [
                  { id: "reply-branch", sourceButton: { id: "b-1" } },
                  { id: "timeout-branch", isNoResponse: true },
                ],
              },
            },
          },
          { id: "n-next", type: FlowNodeType.ACTION, data: { type: "a", label: "N" } },
        ],
        [
          { source: "n-wait", target: "n-next", sourceHandle: "timeout-branch" },
        ],
      ),
    });
    const execute = vi.fn().mockResolvedValue({ success: true, output: {} });
    ctx.getHandler.mockReturnValue({ execute });
    ctx.automationFindOne.mockResolvedValue({ name: "Flow", adminId: "admin-1" });

    const result = await ctx.service.resumeFromWait("run-1", "n-wait");

    expect(result.success).toBe(true);
    expect(result.status).toBe(RunStatus.COMPLETED);
  });

  test("calls resumeExecution without branch when no isNoResponse branch exists", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun({ status: RunStatus.PAUSED, currentNodeId: "n-wait" }));
    ctx.versionFindOne.mockResolvedValue({
      id: "v-2",
      flow: flow(
        [
          {
            id: "n-wait",
            type: FlowNodeType.ACTION,
            data: {
              type: ActionType.SEND_WHATSAPP_TEMPLATE,
              config: { branches: [{ id: "reply", sourceButton: { id: "b-1" } }] },
            },
          },
        ],
        [],
      ),
    });

    const resumeSpy = vi
      .spyOn(ctx.service as unknown as { resumeExecution: typeof ctx.service.resumeExecution }, "resumeExecution")
      .mockResolvedValue({ success: true, runId: "run-1", message: "done" });

    await ctx.service.resumeFromWait("run-1", "n-wait");

    expect(resumeSpy).toHaveBeenCalledWith("run-1", "n-wait", undefined);
  });

  test("continues gracefully when version lookup throws", async () => {
    ctx.runFindOne.mockResolvedValue(mockRun({ status: RunStatus.PAUSED, currentNodeId: "n-wait" }));
    ctx.versionFindOne.mockRejectedValue(new Error("db down"));

    const resumeSpy = vi
      .spyOn(ctx.service as unknown as { resumeExecution: typeof ctx.service.resumeExecution }, "resumeExecution")
      .mockResolvedValue({ success: true, runId: "run-1", message: "done" });

    const result = await ctx.service.resumeFromWait("run-1", "n-wait");

    expect(resumeSpy).toHaveBeenCalledWith("run-1", "n-wait", undefined);
    expect(result.success).toBe(true);
  });

  test("returns rejection status from underlying run when paused at wrong node", async () => {
    ctx.runFindOne.mockResolvedValue(
      mockRun({ status: RunStatus.COMPLETED, currentNodeId: "n-done" }),
    );

    const result = await ctx.service.resumeFromWait("run-1", "n-wait");

    expect(result).toMatchObject({
      success: false,
      status: RunStatus.COMPLETED,
    });
  });
});
});
