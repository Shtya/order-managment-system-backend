import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ActionType,
  FlowWhatsappAccountMode,
} from "entities/automation.entity";
import { WhatsappAccountEntity } from "entities/whatsapp.entity";
import {
  flowHasWhatsappSteps,
  getFlowWhatsappSettings,
  pickWhatsappAccountForRun,
  runWhatsappAccountId,
  snapshotWhatsappAccount,
} from "./runWhatsappAccount";

// Isolates transitive store import chain (same as automation-helpers.spec.ts).
vi.mock("src/stores/storesIntegrations/BaseStoreProvider", () => ({
  BaseStoreProvider: class BaseStoreProvider {},
  WebhookOrderPayload: {},
}));

function node(type: unknown) {
  return { id: "n-1", data: { type } } as never;
}

function flowWith(nodes: unknown[], whatsapp?: Record<string, unknown>) {
  return { nodes: nodes as never[], edges: [], ...(whatsapp ? { whatsapp } : {}) } as never;
}

function account(overrides: Partial<WhatsappAccountEntity> = {}) {
  return {
    id: "acc-1",
    adminId: "admin-1",
    name: "Main",
    mobileNumber: "201001234567",
    phoneNumberId: "pn-1",
    isActive: true,
    ...overrides,
  } as WhatsappAccountEntity;
}

function repo(findOneValue: unknown = null, findValue: unknown[] = []) {
  return {
    findOne: vi.fn().mockResolvedValue(findOneValue),
    find: vi.fn().mockResolvedValue(findValue),
  } as unknown as {
    findOne: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
  };
}

void flowHasWhatsappSteps;
describe("flowHasWhatsappSteps", () => {
  test("returns true for template steps", () => {
    expect(flowHasWhatsappSteps(flowWith([node(ActionType.SEND_WHATSAPP_TEMPLATE)]))).toBe(true);
  });

  test("returns true for message steps", () => {
    expect(flowHasWhatsappSteps(flowWith([node(ActionType.SEND_WHATSAPP_MESSAGE)]))).toBe(true);
  });

  test("returns true for upsell steps", () => {
    expect(flowHasWhatsappSteps(flowWith([node(ActionType.SEND_UPSELL)]))).toBe(true);
  });

  test("returns true for address-correction steps", () => {
    expect(flowHasWhatsappSteps(flowWith([node(ActionType.AI_ADDRESS_CORRECTION)]))).toBe(true);
  });

  test("returns false for non-whatsapp steps", () => {
    expect(flowHasWhatsappSteps(flowWith([node(ActionType.WAIT)]))).toBe(false);
  });

  test("returns false for empty flow", () => {
    expect(flowHasWhatsappSteps(flowWith([]))).toBe(false);
  });

  test("returns false for null flow", () => {
    expect(flowHasWhatsappSteps(null)).toBe(false);
  });

  test("returns false for undefined flow", () => {
    expect(flowHasWhatsappSteps(undefined)).toBe(false);
  });

  test("returns false when node type is missing", () => {
    expect(flowHasWhatsappSteps(flowWith([node(undefined)]))).toBe(false);
  });
});

void getFlowWhatsappSettings;
describe("getFlowWhatsappSettings", () => {
  test("returns fixed mode with account id", () => {
    expect(
      getFlowWhatsappSettings(
        flowWith([], { mode: FlowWhatsappAccountMode.FIXED, accountId: "acc-1" }),
      ),
    ).toEqual({ mode: FlowWhatsappAccountMode.FIXED, accountId: "acc-1" });
  });

  test("defaults to random when settings are missing", () => {
    expect(getFlowWhatsappSettings(flowWith([]))).toEqual({
      mode: FlowWhatsappAccountMode.RANDOM,
      accountId: null,
    });
  });

  test("defaults to random for null flow", () => {
    expect(getFlowWhatsappSettings(null)).toEqual({
      mode: FlowWhatsappAccountMode.RANDOM,
      accountId: null,
    });
  });

  test("defaults account id to null when absent", () => {
    expect(
      getFlowWhatsappSettings(flowWith([], { mode: FlowWhatsappAccountMode.FIXED })),
    ).toEqual({ mode: FlowWhatsappAccountMode.FIXED, accountId: null });
  });

  test("treats empty account id as null", () => {
    expect(
      getFlowWhatsappSettings(flowWith([], { mode: FlowWhatsappAccountMode.FIXED, accountId: "" })),
    ).toEqual({ mode: FlowWhatsappAccountMode.FIXED, accountId: null });
  });
});

void snapshotWhatsappAccount;
describe("snapshotWhatsappAccount", () => {
  test("maps account fields to snapshot", () => {
    expect(snapshotWhatsappAccount(account())).toEqual({
      whatsappAccountId: "acc-1",
      whatsappAccountName: "Main",
      whatsappAccountPhone: "201001234567",
    });
  });

  test("returns nulls for null account", () => {
    expect(snapshotWhatsappAccount(null)).toEqual({
      whatsappAccountId: null,
      whatsappAccountName: null,
      whatsappAccountPhone: null,
    });
  });

  test("returns nulls for undefined account", () => {
    expect(snapshotWhatsappAccount(undefined)).toEqual({
      whatsappAccountId: null,
      whatsappAccountName: null,
      whatsappAccountPhone: null,
    });
  });

  test("maps missing name and phone to null", () => {
    expect(
      snapshotWhatsappAccount(account({ name: "", mobileNumber: "" as never })),
    ).toEqual({
      whatsappAccountId: "acc-1",
      whatsappAccountName: null,
      whatsappAccountPhone: null,
    });
  });
});

void pickWhatsappAccountForRun;
describe("pickWhatsappAccountForRun", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function whatsappFlow(whatsapp?: Record<string, unknown>) {
    return flowWith([node(ActionType.SEND_WHATSAPP_TEMPLATE)], whatsapp);
  }

  test("returns existing account without checking flow", async () => {
    const existing = account({ id: "acc-9" });
    const fake = repo(existing);

    const result = await pickWhatsappAccountForRun(fake as never, "", null, "acc-9");

    expect(result).toBe(existing);
  });

  test("falls through when existing account is missing", async () => {
    const fake = repo(null, []);

    const result = await pickWhatsappAccountForRun(fake as never, "admin-1", whatsappFlow(), "gone");

    expect(result).toBeNull();
    expect(fake.find).toHaveBeenCalled();
  });

  test("returns null without querying when admin is missing", async () => {
    const fake = repo();

    const result = await pickWhatsappAccountForRun(fake as never, "", whatsappFlow());

    expect(result).toBeNull();
    expect(fake.findOne).not.toHaveBeenCalled();
    expect(fake.find).not.toHaveBeenCalled();
  });

  test("returns null for flows without whatsapp steps", async () => {
    const fake = repo();

    const result = await pickWhatsappAccountForRun(
      fake as never,
      "admin-1",
      flowWith([node(ActionType.WAIT)]),
    );

    expect(result).toBeNull();
    expect(fake.find).not.toHaveBeenCalled();
  });

  test("loads fixed account scoped to admin", async () => {
    const fixed = account({ id: "acc-fixed" });
    const fake = repo(fixed);

    const result = await pickWhatsappAccountForRun(
      fake as never,
      "admin-1",
      whatsappFlow({ mode: FlowWhatsappAccountMode.FIXED, accountId: "acc-fixed" }),
    );

    expect(result).toBe(fixed);
    expect(fake.findOne).toHaveBeenCalledWith({
      where: { id: "acc-fixed", adminId: "admin-1", isActive: true },
    });
    expect(fake.find).not.toHaveBeenCalled();
  });

  test("falls back to random when fixed has no account id", async () => {
    const picked = account({ id: "acc-2" });
    const fake = repo(null, [picked]);

    const result = await pickWhatsappAccountForRun(
      fake as never,
      "admin-1",
      whatsappFlow({ mode: FlowWhatsappAccountMode.FIXED }),
    );

    expect(result).toBe(picked);
  });

  test("returns null when no active accounts exist", async () => {
    const fake = repo(null, []);

    const result = await pickWhatsappAccountForRun(fake as never, "admin-1", whatsappFlow());

    expect(result).toBeNull();
  });

  test("dedupes accounts sharing a phone number", async () => {
    const first = account({ id: "acc-1", phoneNumberId: "pn-same", mobileNumber: "201001111111" });
    const duplicate = account({ id: "acc-2", phoneNumberId: "pn-same", mobileNumber: "201002222222" });
    const fake = repo(null, [first, duplicate]);

    const result = await pickWhatsappAccountForRun(fake as never, "admin-1", whatsappFlow());

    expect(result).toBe(first);
  });

  test("picks last account when random is high", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const first = account({ id: "acc-1", phoneNumberId: "pn-1" });
    const last = account({ id: "acc-2", phoneNumberId: "pn-2" });
    const fake = repo(null, [first, last]);

    const result = await pickWhatsappAccountForRun(fake as never, "admin-1", whatsappFlow());

    expect(result).toBe(last);
  });
});

void runWhatsappAccountId;
describe("runWhatsappAccountId", () => {
  test("returns the run account id", () => {
    expect(runWhatsappAccountId({ whatsappAccountId: "acc-1" })).toBe("acc-1");
  });

  test("returns undefined for null run", () => {
    expect(runWhatsappAccountId(null)).toBeUndefined();
  });

  test("returns undefined for undefined run", () => {
    expect(runWhatsappAccountId(undefined)).toBeUndefined();
  });

  test("returns undefined when account id is null", () => {
    expect(runWhatsappAccountId({ whatsappAccountId: null })).toBeUndefined();
  });

  test("returns undefined when account id is empty", () => {
    expect(runWhatsappAccountId({ whatsappAccountId: "" })).toBeUndefined();
  });
});
