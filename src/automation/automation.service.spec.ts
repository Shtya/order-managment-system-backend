import {
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import {
  AutomationFlowEntity,
  AutomationFlowVersionEntity,
  AutomationStatus,
  TriggerType,
} from "entities/automation.entity";
import { GettingStartedAchievementType } from "entities/getting-started.entity";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AutomationService } from "./automation.service";

vi.mock("src/stores/storesIntegrations/BaseStoreProvider", () => ({
  BaseStoreProvider: class BaseStoreProvider {},
  WebhookOrderPayload: {},
}));

vi.mock("./engine/triggerDispatcher.service", () => ({
  TriggerDispatcherService: class TriggerDispatcherService {},
}));

vi.mock("src/queue/queues/automations.queue", () => ({
  AutomationQueueService: class AutomationQueueService {},
}));

vi.mock("src/orphan-files/orphan-files.service", () => ({
  OrphanFilesService: class OrphanFilesService {},
}));

vi.mock("common/translation.service", () => ({
  TranslationService: class TranslationService {},
}));

vi.mock("src/queue/queues/onboarding-achievement.queue", () => ({
  OnboardingAchievementService: class OnboardingAchievementService {},
}));

const ADMIN = { id: "admin-1", role: { name: "admin" } };
const SUPER = { id: "super-1", role: { name: "super_admin" } };
const NOBODY = { id: "user-1", role: { name: "user" } };

function qbMock(overrides: Record<string, unknown> = {}) {
  const qb: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn().mockReturnThis(),
    addSelect: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    andWhere: vi.fn().mockReturnThis(),
    leftJoinAndSelect: vi.fn().mockReturnThis(),
    withDeleted: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    take: vi.fn().mockReturnThis(),
    getCount: vi.fn().mockResolvedValue(0),
    getMany: vi.fn().mockResolvedValue([]),
    getOne: vi.fn().mockResolvedValue(null),
    getRawMany: vi.fn().mockResolvedValue([]),
  };
  Object.assign(qb, overrides);
  return qb as unknown as {
    [K in keyof typeof qb]: ReturnType<typeof vi.fn>;
  };
}

function services() {
  const transaction = vi.fn(
    async (cb: (manager: unknown) => unknown) =>
      cb({
        getRepository: () => {
          throw new Error("getRepository not stubbed");
        },
      }),
  );
  const automationQb = qbMock();
  const versionQb = qbMock();
  const runQb = qbMock();
  const automationRepo = {
    createQueryBuilder: vi.fn().mockReturnValue(automationQb),
    findOne: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    manager: { transaction },
  };
  const versionRepo = {
    createQueryBuilder: vi.fn().mockReturnValue(versionQb),
  };
  const runRepo = {
    createQueryBuilder: vi.fn().mockReturnValue(runQb),
    findOne: vi.fn(),
    save: vi.fn(async (run: unknown) => run),
  };
  const deleteOrphansByIds = vi.fn().mockResolvedValue(undefined);
  const enqueueAchievement = vi.fn();
  const t = vi.fn((key: string) => key);

  const service = new AutomationService(
    { transaction } as never,
    automationRepo as never,
    versionRepo as never,
    runRepo as never,
    {} as never,
    {} as never,
    { deleteOrphansByIds } as never,
    { t } as never,
    { enqueueAchievement } as never,
  );

  return {
    service,
    transaction,
    automationQb,
    versionQb,
    runQb,
    automationRepo,
    versionRepo,
    runRepo,
    deleteOrphansByIds,
    enqueueAchievement,
    t,
  };
}

function txRepos(
  autoTx: Record<string, unknown>,
  versionTx: Record<string, unknown>,
) {
  return {
    getRepository: (entity: unknown) =>
      entity === AutomationFlowEntity ? autoTx : versionTx,
  };
}

function registerDto(overrides: Record<string, unknown> = {}) {
  return {
    name: "Flow",
    triggerType: TriggerType.ORDER_CREATED,
    flow: { nodes: [], edges: [] },
    publish: false,
    ...overrides,
  } as never;
}

void AutomationService.prototype.create;
describe("AutomationService create", () => {
  let ctx: ReturnType<typeof services>;

  beforeEach(() => {
    ctx = services();
  });

  function txSetup() {
    const autoTx = {
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn((data: unknown) => ({ ...(data as object) })),
      save: vi.fn(async (data: unknown) => ({
        id: "flow-1",
        ...(data as object),
      })),
    };
    const versionTx = {
      create: vi.fn((data: unknown) => ({ ...(data as object) })),
      save: vi.fn(async (data: unknown) => ({
        id: "v-1",
        ...(data as object),
      })),
    };
    ctx.transaction.mockImplementation(async (cb: (m: unknown) => unknown) =>
      cb(txRepos(autoTx, versionTx)),
    );
    return { autoTx, versionTx };
  }

  test("creates draft flow with first version", async () => {
    const { autoTx, versionTx } = txSetup();

    const result = await ctx.service.create(ADMIN, registerDto());

    expect(autoTx.findOne).toHaveBeenCalledWith({
      where: { name: "Flow", adminId: "admin-1" },
    });
    expect(result).toMatchObject({
      id: "flow-1",
      name: "Flow",
      status: AutomationStatus.DRAFT,
      latestVersion: { id: "v-1", versionString: "1.0" },
    });
    expect(versionTx.save).toHaveBeenCalledTimes(1);
    expect(ctx.enqueueAchievement).toHaveBeenCalledWith(
      "admin-1",
      GettingStartedAchievementType.FIRST_AUTOMATION_CREATED,
    );
  });

  test("creates published flow when requested", async () => {
    txSetup();

    const result = await ctx.service.create(
      ADMIN,
      registerDto({ publish: true }),
    );

    expect(result).toMatchObject({ status: AutomationStatus.PUBLISHED });
  });

  test("rejects duplicate names", async () => {
    const autoTx = {
      findOne: vi.fn().mockResolvedValue({ id: "flow-9" }),
      create: vi.fn(),
      save: vi.fn(),
    };
    ctx.transaction.mockImplementation(async (cb: (m: unknown) => unknown) =>
      cb(txRepos(autoTx, {})),
    );

    let thrown: unknown;
    try {
      await ctx.service.create(ADMIN, registerDto());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).message).toBe(
      "domains.automation.name_already_exists",
    );
  });

  test("rejects without admin context", async () => {
    let thrown: unknown;
    try {
      await ctx.service.create(NOBODY, registerDto());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).message).toBe(
      "common.admin_id_not_found",
    );
    expect(ctx.transaction).not.toHaveBeenCalled();
  });
});

void AutomationService.prototype.update;
describe("AutomationService update", () => {
  let ctx: ReturnType<typeof services>;

  beforeEach(() => {
    ctx = services();
  });

  function txSetup(automation: unknown) {
    const autoTx = {
      findOne: vi.fn().mockResolvedValue(automation),
      save: vi.fn(async (data: unknown) => data),
    };
    const versionTx = {
      create: vi.fn((data: unknown) => ({ ...(data as object) })),
      save: vi.fn(async (data: unknown) => ({
        id: "v-2",
        ...(data as object),
      })),
    };
    ctx.transaction.mockImplementation(async (cb: (m: unknown) => unknown) =>
      cb(txRepos(autoTx, versionTx)),
    );
    return { autoTx, versionTx };
  }

  function stored(status: AutomationStatus, flow?: unknown) {
    return {
      id: "flow-1",
      adminId: "admin-1",
      triggerType: TriggerType.ORDER_CREATED,
      status,
      latestVersionId: "v-1",
      latestVersion: {
        id: "v-1",
        versionString: "1.0",
        flow: flow ?? { nodes: [], edges: [] },
      },
    };
  }

  test("throws not-found for unknown id", async () => {
    txSetup(null);

    let thrown: unknown;
    try {
      await ctx.service.update(ADMIN, "missing", { flow: { nodes: [], edges: [] } } as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).message).toBe(
      "domains.automation.not_found",
    );
  });

  test("rejects trigger type change", async () => {
    txSetup(stored(AutomationStatus.PUBLISHED));

    let thrown: unknown;
    try {
      await ctx.service.update(
        ADMIN,
        "flow-1",
        {
          flow: {
            nodes: [{ type: "trigger", data: { type: "order_updated" } }],
            edges: [],
          },
        } as never,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).message).toBe(
      "domains.automation.trigger_type_mismatch",
    );
  });

  test("publishes draft with same version", async () => {
    const { versionTx } = txSetup(stored(AutomationStatus.DRAFT));

    const result = await ctx.service.update(
      ADMIN,
      "flow-1",
      { flow: { nodes: [], edges: [] } } as never,
    );

    expect(versionTx.save).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: AutomationStatus.PUBLISHED,
      newVersion: { id: "v-1" },
    });
  });

  test("skips identical flow", async () => {
    const flow = {
      nodes: [{ id: "n-1", type: "action", data: { a: 1 } }],
      edges: [],
    };
    const { versionTx } = txSetup(stored(AutomationStatus.PUBLISHED, flow));

    const result = await ctx.service.update(
      ADMIN,
      "flow-1",
      { flow } as never,
    );

    expect(result).toMatchObject({ skipped: true });
    expect(versionTx.save).not.toHaveBeenCalled();
  });

  test("creates major version for changed flow", async () => {
    ctx.versionQb.getOne.mockResolvedValue({ versionString: "1.0" });
    txSetup(stored(AutomationStatus.PUBLISHED));

    const result = await ctx.service.update(
      ADMIN,
      "flow-1",
      {
        flow: {
          nodes: [{ id: "n-1", type: "action", data: { a: 2 } }],
          edges: [],
        },
      } as never,
    );

    expect((result as any).newVersion).toMatchObject({ versionString: "2.0" });
    expect(result).toMatchObject({ latestVersionId: "v-2" });
  });
});

void AutomationService.prototype.findOne;
describe("AutomationService findOne", () => {
  let ctx: ReturnType<typeof services>;

  beforeEach(() => {
    ctx = services();
  });

  test("returns flow with latest version mapped", async () => {
    const latestVersion = { id: "v-1" };
    ctx.automationQb.getOne.mockResolvedValue({ id: "flow-1", latestVersion });

    const result = await ctx.service.findOne(ADMIN, "flow-1");

    expect(result).toMatchObject({ id: "flow-1" });
    expect(result.versions).toEqual([latestVersion]);
  });

  test("throws not-found for unknown id", async () => {
    ctx.automationQb.getOne.mockResolvedValue(null);

    let thrown: unknown;
    try {
      await ctx.service.findOne(ADMIN, "missing");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).message).toBe(
      "domains.automation.not_found",
    );
  });

  test("throws version-not-found for missing version", async () => {
    ctx.automationQb.getOne.mockResolvedValue({ id: "flow-1", versions: [] });

    let thrown: unknown;
    try {
      await ctx.service.findOne(ADMIN, "flow-1", "2.0");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).message).toBe(
      "domains.automation.version_not_found",
    );
  });

  test("throws no-active-version without latest", async () => {
    ctx.automationQb.getOne.mockResolvedValue({ id: "flow-1" });

    let thrown: unknown;
    try {
      await ctx.service.findOne(ADMIN, "flow-1");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).message).toBe(
      "domains.automation.no_active_version",
    );
  });

  test("scopes tenant in query", async () => {
    ctx.automationQb.getOne.mockResolvedValue({
      id: "flow-1",
      latestVersion: { id: "v-1" },
    });

    await ctx.service.findOne(ADMIN, "flow-1");

    expect(ctx.automationQb.where).toHaveBeenCalledWith(
      "automation.id = :id",
      { id: "flow-1" },
    );
    expect(ctx.automationQb.andWhere).toHaveBeenCalledWith(
      "automation.adminId = :adminId",
      { adminId: "admin-1" },
    );
  });

  test("scopes super-admin query to null admin", async () => {
    ctx.automationQb.getOne.mockResolvedValue({
      id: "flow-1",
      latestVersion: { id: "v-1" },
    });

    await ctx.service.findOne(SUPER, "flow-1");

    expect(ctx.automationQb.andWhere).toHaveBeenCalledWith(
      "automation.adminId Is NULL",
      { adminId: null },
    );
  });
});

void AutomationService.prototype.findAll;
describe("AutomationService findAll", () => {
  let ctx: ReturnType<typeof services>;

  beforeEach(() => {
    ctx = services();
  });

  test("returns paginated shape", async () => {
    ctx.automationQb.getCount.mockResolvedValue(2);
    ctx.automationQb.getMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);

    const result = await ctx.service.findAll(ADMIN, {});

    expect(result).toEqual({
      total_records: 2,
      current_page: 1,
      per_page: 10,
      records: [{ id: "a" }, { id: "b" }],
    });
  });

  test("scopes tenant in query", async () => {
    await ctx.service.findAll(ADMIN, {});

    expect(ctx.automationQb.where).toHaveBeenCalledWith(
      "automation.adminId = :adminId",
      { adminId: "admin-1" },
    );
  });

  test("scopes super-admin query to null admin", async () => {
    await ctx.service.findAll(SUPER, {});

    expect(ctx.automationQb.where).toHaveBeenCalledWith(
      "automation.adminId Is NULL",
    );
  });

  test("rejects without admin context", async () => {
    let thrown: unknown;
    try {
      await ctx.service.findAll(NOBODY, {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).message).toBe(
      "common.missing_admin_id",
    );
  });
});

void AutomationService.prototype.delete;
describe("AutomationService delete", () => {
  let ctx: ReturnType<typeof services>;

  beforeEach(() => {
    ctx = services();
  });

  function txSetup(automation: unknown) {
    const findOne = vi.fn().mockResolvedValue(automation);
    const save = vi.fn(async (data: unknown) => data);
    const softDelete = vi.fn().mockResolvedValue(undefined);
    ctx.automationRepo.manager.transaction.mockImplementation(
      async (cb: (m: unknown) => unknown) =>
        cb({ findOne, save, softDelete }),
    );
    return { findOne, save, softDelete };
  }

  test("archives and soft-deletes", async () => {
    const { save, softDelete } = txSetup({ id: "flow-1" });

    const result = await ctx.service.delete(ADMIN, "flow-1");

    expect(save).toHaveBeenCalledWith(
      AutomationFlowEntity,
      expect.objectContaining({ status: AutomationStatus.ARCHIVED }),
    );
    expect(softDelete).toHaveBeenCalledWith(AutomationFlowEntity, "flow-1");
    expect(result).toEqual({
      message: "domains.automation.deleted_successfully",
    });
  });

  test("throws not-found for unknown id", async () => {
    const { softDelete } = txSetup(null);

    let thrown: unknown;
    try {
      await ctx.service.delete(ADMIN, "missing");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NotFoundException);
    expect((thrown as NotFoundException).message).toBe(
      "domains.automation.not_found",
    );
    expect(softDelete).not.toHaveBeenCalled();
  });
});

void AutomationService.prototype.findAllRuns;
describe("AutomationService findAllRuns", () => {
  let ctx: ReturnType<typeof services>;

  beforeEach(() => {
    ctx = services();
  });

  test("returns paginated shape", async () => {
    ctx.runQb.getCount.mockResolvedValue(1);
    ctx.runQb.getMany.mockResolvedValue([{ id: "run-1" }]);

    const result = await ctx.service.findAllRuns(ADMIN, {});

    expect(result).toEqual({
      total_records: 1,
      current_page: 1,
      per_page: 10,
      records: [{ id: "run-1" }],
    });
  });

  test("scopes tenant in query", async () => {
    await ctx.service.findAllRuns(ADMIN, {});

    expect(ctx.runQb.where).toHaveBeenCalledWith(
      'run."adminId" = :adminId',
      { adminId: "admin-1" },
    );
  });

  test("rejects without admin context", async () => {
    let thrown: unknown;
    try {
      await ctx.service.findAllRuns(NOBODY, {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).message).toBe(
      "common.missing_admin_id",
    );
  });
});

void AutomationService.prototype.findOneRun;
describe("AutomationService findOneRun", () => {
  let ctx: ReturnType<typeof services>;

  beforeEach(() => {
    ctx = services();
  });

  test("returns run with access", async () => {
    const run = { id: "run-1", automationFlowId: "flow-1" };
    ctx.runRepo.findOne.mockResolvedValue(run);
    ctx.automationRepo.findOne.mockResolvedValue({ id: "flow-1" });

    const result = await ctx.service.findOneRun(ADMIN, "run-1");

    expect(result).toBe(run);
  });

  test("throws not-found for unknown run", async () => {
    ctx.runRepo.findOne.mockResolvedValue(null);

    let thrown: unknown;
    try {
      await ctx.service.findOneRun(ADMIN, "missing");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NotFoundException);
    expect((thrown as NotFoundException).message).toBe(
      "domains.automation.run_not_found",
    );
  });

  test("denies cross-tenant access", async () => {
    ctx.runRepo.findOne.mockResolvedValue({
      id: "run-1",
      automationFlowId: "flow-1",
    });
    ctx.automationRepo.findOne.mockResolvedValue(null);

    let thrown: unknown;
    try {
      await ctx.service.findOneRun(ADMIN, "run-1");
    } catch (error) {
      thrown = error;
    }

    expect(ctx.automationRepo.findOne).toHaveBeenCalledWith({
      where: { id: "flow-1", adminId: "admin-1" },
    });
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).message).toBe(
      "domains.automation.access_denied_or_not_found",
    );
  });
});

void AutomationService.prototype.getFlowsStats;
describe("AutomationService getFlowsStats", () => {
  test("aggregates counts by status", async () => {
    const ctx = services();
    ctx.automationQb.getRawMany.mockResolvedValue([
      { status: AutomationStatus.PUBLISHED, count: "2" },
      { status: AutomationStatus.DRAFT, count: "1" },
    ]);

    const result = await ctx.service.getFlowsStats(ADMIN);

    expect(result).toEqual({
      total: 3,
      published: 2,
      draft: 1,
      paused: 0,
      archived: 0,
    });
    expect(ctx.automationQb.where).toHaveBeenCalledWith(
      "flow.adminId = :adminId",
      { adminId: "admin-1" },
    );
  });
});

void AutomationService.prototype.getRunsStats;
describe("AutomationService getRunsStats", () => {
  test("aggregates counts by status", async () => {
    const ctx = services();
    ctx.runQb.getRawMany.mockResolvedValue([
      { status: "pending", count: "1" },
      { status: "cancelled", count: "5" },
    ]);

    const result = await ctx.service.getRunsStats(ADMIN);

    expect(result).toEqual({
      total: 6,
      pending: 1,
      running: 0,
      completed: 0,
      failed: 0,
      paused: 0,
    });
  });
});

void AutomationService.prototype.changeStatus;
describe("AutomationService changeStatus", () => {
  let ctx: ReturnType<typeof services>;

  beforeEach(() => {
    ctx = services();
  });

  function stored(status: AutomationStatus) {
    ctx.automationQb.getOne.mockResolvedValue({
      id: "flow-1",
      status,
      latestVersion: { id: "v-1" },
    });
  }

  test("toggles published to paused", async () => {
    stored(AutomationStatus.PUBLISHED);

    const result = await ctx.service.changeStatus(ADMIN, "flow-1", undefined as never);

    expect(ctx.automationRepo.update).toHaveBeenCalledWith("flow-1", {
      status: AutomationStatus.PAUSED,
    });
    expect(result.status).toBe(AutomationStatus.PAUSED);
  });

  test("toggles draft to published", async () => {
    stored(AutomationStatus.DRAFT);

    const result = await ctx.service.changeStatus(ADMIN, "flow-1", undefined as never);

    expect(ctx.automationRepo.update).toHaveBeenCalledWith("flow-1", {
      status: AutomationStatus.PUBLISHED,
    });
    expect(result.status).toBe(AutomationStatus.PUBLISHED);
  });

  test("applies explicit status", async () => {
    stored(AutomationStatus.DRAFT);

    const result = await ctx.service.changeStatus(
      ADMIN,
      "flow-1",
      AutomationStatus.PAUSED,
    );

    expect(ctx.automationRepo.update).toHaveBeenCalledWith("flow-1", {
      status: AutomationStatus.PAUSED,
    });
    expect(result.status).toBe(AutomationStatus.PAUSED);
  });
});
