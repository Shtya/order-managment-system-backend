import {
  AutomationFlowEntity,
  AutomationStatus,
} from "entities/automation.entity";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AutomationSubscriber } from "./automation-subscriber";

vi.mock("src/stores/storesIntegrations/BaseStoreProvider", () => ({
  BaseStoreProvider: class BaseStoreProvider {},
  WebhookOrderPayload: {},
}));

vi.mock("src/automation/engine/triggerDispatcher.service", () => ({
  TriggerDispatcherService: class TriggerDispatcherService {},
}));

function buildSubscriber(deps?: {
  autoRetryFailedRuns?: ReturnType<typeof vi.fn>;
}) {
  const autoRetryFailedRuns =
    deps?.autoRetryFailedRuns ?? vi.fn().mockResolvedValue(undefined);
  const dataSource = { subscribers: [] as unknown[] };

  const subscriber = new AutomationSubscriber(
    dataSource as never,
    { autoRetryFailedRuns } as never,
  );

  return { subscriber, autoRetryFailedRuns, dataSource };
}

function updateEvent(overrides: Record<string, unknown> = {}) {
  return {
    entity: {
      id: "flow-1",
      adminId: "admin-1",
      latestVersionId: "v-2",
      status: AutomationStatus.PUBLISHED,
    },
    databaseEntity: {
      id: "flow-1",
      adminId: "admin-1",
      latestVersionId: "v-1",
      status: AutomationStatus.PUBLISHED,
    },
    ...overrides,
  } as never;
}

void AutomationSubscriber.prototype.afterUpdate;
describe("AutomationSubscriber afterUpdate", () => {
  test("ignores events without entity", async () => {
    const { subscriber, autoRetryFailedRuns } = buildSubscriber();

    await subscriber.afterUpdate(updateEvent({ entity: null }));

    expect(autoRetryFailedRuns).not.toHaveBeenCalled();
  });

  test("ignores entity without id", async () => {
    const { subscriber, autoRetryFailedRuns } = buildSubscriber();
    const event = updateEvent();
    delete (event as any).entity.id;

    await subscriber.afterUpdate(event);

    expect(autoRetryFailedRuns).not.toHaveBeenCalled();
  });

  test("ignores entity without admin id", async () => {
    const { subscriber, autoRetryFailedRuns } = buildSubscriber();
    const event = updateEvent();
    delete (event as any).entity.adminId;

    await subscriber.afterUpdate(event);

    expect(autoRetryFailedRuns).not.toHaveBeenCalled();
  });

  test("ignores unchanged version on published flow", async () => {
    const { subscriber, autoRetryFailedRuns } = buildSubscriber();

    await subscriber.afterUpdate(
      updateEvent({
        entity: {
          id: "flow-1",
          adminId: "admin-1",
          latestVersionId: "v-1",
          status: AutomationStatus.PUBLISHED,
        },
        databaseEntity: {
          id: "flow-1",
          adminId: "admin-1",
          latestVersionId: "v-1",
          status: AutomationStatus.PUBLISHED,
        },
      }),
    );

    expect(autoRetryFailedRuns).not.toHaveBeenCalled();
  });

  test("dispatches immediately without query runner", async () => {
    const { subscriber, autoRetryFailedRuns } = buildSubscriber();

    await subscriber.afterUpdate(updateEvent());

    expect(autoRetryFailedRuns).toHaveBeenCalledWith("admin-1", "flow-1");
  });

  test("dispatches for non-published same version", async () => {
    const { subscriber, autoRetryFailedRuns } = buildSubscriber();

    await subscriber.afterUpdate(
      updateEvent({
        entity: {
          id: "flow-1",
          adminId: "admin-1",
          latestVersionId: "v-1",
          status: AutomationStatus.DRAFT,
        },
        databaseEntity: {
          id: "flow-1",
          adminId: "admin-1",
          latestVersionId: "v-1",
          status: AutomationStatus.DRAFT,
        },
      }),
    );

    expect(autoRetryFailedRuns).toHaveBeenCalledWith("admin-1", "flow-1");
  });

  test("queues task with query runner", async () => {
    const { subscriber, autoRetryFailedRuns } = buildSubscriber();
    const queryRunner = { data: {} as Record<string, unknown[]> };

    await subscriber.afterUpdate(updateEvent({ queryRunner }));

    expect(autoRetryFailedRuns).not.toHaveBeenCalled();
    expect(queryRunner.data.postAutomationTasks).toHaveLength(1);

    await (
      queryRunner.data.postAutomationTasks as Array<() => Promise<void>>
    )[0]();

    expect(autoRetryFailedRuns).toHaveBeenCalledWith("admin-1", "flow-1");
  });

  test("appends to existing queued tasks", async () => {
    const { subscriber } = buildSubscriber();
    const existing = vi.fn();
    const queryRunner = { data: { postAutomationTasks: [existing] } };

    await subscriber.afterUpdate(updateEvent({ queryRunner }));

    expect(queryRunner.data.postAutomationTasks).toEqual([
      existing,
      expect.any(Function),
    ]);
  });
});

void AutomationSubscriber.prototype.afterTransactionCommit;
describe("AutomationSubscriber afterTransactionCommit", () => {
  test("runs queued tasks in order", async () => {
    const { subscriber } = buildSubscriber();
    const order: string[] = [];
    const queryRunner = {
      data: {
        postAutomationTasks: [
          async () => {
            order.push("first");
          },
          async () => {
            order.push("second");
          },
        ],
      },
    };

    await subscriber.afterTransactionCommit({ queryRunner } as never);

    expect(order).toEqual(["first", "second"]);
  });

  test("continues after task failure", async () => {
    const { subscriber } = buildSubscriber();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const second = vi.fn();
    const queryRunner = {
      data: {
        postAutomationTasks: [
          async () => {
            throw new Error("task down");
          },
          second,
        ],
      },
    };

    await subscriber.afterTransactionCommit({ queryRunner } as never);

    expect(second).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
  });

  test("clears tasks after running", async () => {
    const { subscriber } = buildSubscriber();
    const queryRunner = {
      data: { postAutomationTasks: [vi.fn()] },
    };

    await subscriber.afterTransactionCommit({ queryRunner } as never);

    expect(queryRunner.data.postAutomationTasks).toEqual([]);
  });

  test("ignores missing task list", async () => {
    const { subscriber } = buildSubscriber();

    await expect(
      subscriber.afterTransactionCommit({ queryRunner: { data: {} } } as never),
    ).resolves.toBeUndefined();
  });
});
