import { describe, expect, test, vi } from "vitest";
import {
  AuthorizationStatus,
  BillingAuthorizationEntity,
  BillingChargeEntity,
  BillingOperationKey,
  BillingServiceKey,
  CollectionStatus,
} from "entities/billing.entity";

vi.mock("src/admin-settings/admin-settings.service", () => ({
  AdminSettingsService: class AdminSettingsService {},
}));
vi.mock("src/wallet/wallet-hold.service", () => ({
  WalletHoldService: class WalletHoldService {},
}));
vi.mock("common/translation.service", () => ({
  RequestTranslationService: class RequestTranslationService {},
  TranslationService: class TranslationService {},
}));
import { AllowanceService } from "./allowance/allowance.service";
import { BillingService } from "./billing.service";
import {
  AuthorizationReleasedError,
  BillingConflictError,
  IdempotencyKeyReuseError,
} from "./billing.errors";
import { BillingOperationRegistry } from "./operations/billing-operation.registry";
import { AiDecisionEvaluateOperation } from "./operations/ai-decision/ai-decision-evaluate.operation";

const ADMIN = "11111111-1111-1111-1111-111111111111";
const usage = { inputTokens: 1000000n, outputTokens: 0n };

function pricingRaw(allowance: unknown) {
  return {
    tokenPrice: 1,
    reservationSafetyMarginPercent: 10,
    allowance,
  };
}

function createMemoryAllowance() {
  const usageRows = new Map<
    string,
    { used: bigint; reserved: bigint }
  >();
  const keyOf = (adminId: string, service: string, operation: string) =>
    `${adminId}:${service}:${operation}`;

  const svc = {
    usageRows,
    currentGrant(allowanceReservedUnits: bigint, unit: any) {
      return { unit, remainingUnits: allowanceReservedUnits ?? 0n };
    },
    async reserve(input: any) {
      const maxUnits = input.maxUnits < 0n ? 0n : input.maxUnits;
      if (input.capUnits === null) {
        return { unit: input.unit, remainingUnits: maxUnits };
      }
      if (
        input.durationDays != null &&
        (!input.accountCreatedAt ||
          Date.now() >
            input.accountCreatedAt.getTime() +
              input.durationDays * 24 * 60 * 60 * 1000)
      ) {
        return { unit: input.unit, remainingUnits: 0n };
      }
      if (input.capUnits <= 0n || maxUnits <= 0n) {
        return { unit: input.unit, remainingUnits: 0n };
      }
      const key = keyOf(input.adminId, input.service, input.operation);
      const row = usageRows.get(key) ?? { used: 0n, reserved: 0n };
      const available = input.capUnits - row.used - row.reserved;
      const n = available < 0n ? 0n : available < maxUnits ? available : maxUnits;
      row.reserved += n;
      usageRows.set(key, row);
      return { unit: input.unit, remainingUnits: n };
    },
    async commit(authorizationId: string, consumedUnits: bigint, manager: any) {
      const auth = await manager.findOne(BillingAuthorizationEntity, {
        where: { id: authorizationId },
      });
      if (!auth || auth.allowanceReservedUnits <= 0n) return;
      const booked = auth.allowanceReservedUnits;
      let used = consumedUnits < 0n ? 0n : consumedUnits;
      if (used > booked) used = booked;
      const key = keyOf(auth.adminId, auth.service, auth.operation);
      const row = usageRows.get(key);
      if (!row) return;
      row.reserved -= booked;
      row.used += used;
    },
    async commitUsedOnly(authorizationId: string, consumedUnits: bigint, manager: any) {
      const auth = await manager.findOne(BillingAuthorizationEntity, {
        where: { id: authorizationId },
      });
      if (!auth || consumedUnits <= 0n) return;
      let used = consumedUnits;
      if (auth.allowanceReservedUnits > 0n && used > auth.allowanceReservedUnits) {
        used = auth.allowanceReservedUnits;
      }
      const key = keyOf(auth.adminId, auth.service, auth.operation);
      const row = usageRows.get(key) ?? { used: 0n, reserved: 0n };
      row.used += used;
      usageRows.set(key, row);
    },
    async release(authorizationId: string, manager: any) {
      const auth = await manager.findOne(BillingAuthorizationEntity, {
        where: { id: authorizationId },
      });
      if (!auth || auth.allowanceReservedUnits <= 0n) return;
      await this.releaseUnits({
        adminId: auth.adminId,
        service: auth.service,
        operation: auth.operation,
        units: auth.allowanceReservedUnits,
        manager,
      });
    },
    async releaseUnits(input: any) {
      if (input.units <= 0n) return;
      const key = keyOf(input.adminId, input.service, input.operation);
      const row = usageRows.get(key);
      if (!row) return;
      row.reserved -= input.units;
    },
  };
  return svc;
}

function createHarness(opts?: {
  available?: bigint;
  allowance?: unknown;
}) {
  const auths: BillingAuthorizationEntity[] = [];
  const charges: BillingChargeEntity[] = [];
  const snapshot = {
    version: "v1",
    capturedAt: "2026-01-01T00:00:00.000Z",
    rawSettings: pricingRaw(
      opts?.allowance === undefined
        ? { units: 0, durationDays: null }
        : opts.allowance,
    ),
  };
  const wallet = {
    available: opts?.available ?? 10_000_000_000_000n,
    reserved: 0n,
    lastCaptureNotes: undefined as string | undefined,
    async reserve(_userId: string, amount: bigint) {
      if (amount > this.available) {
        return {
          reserved: false as const,
          available: this.available,
          required: amount,
        };
      }
      this.available -= amount;
      this.reserved += amount;
      return {
        reserved: true as const,
        reservationId: "wallet-1",
        available: this.available,
      };
    },
    async capture(
      _userId: string,
      reservedMicros: bigint,
      capturedMicros: bigint,
      _em?: unknown,
      notes?: string,
    ) {
      this.lastCaptureNotes = notes;
      this.reserved -= reservedMicros;
      this.available += reservedMicros - capturedMicros;
      return { walletTransactionId: capturedMicros > 0n ? "tx-1" : null };
    },
    async releaseHold(_userId: string, reservedMicros: bigint) {
      this.reserved -= reservedMicros;
      this.available += reservedMicros;
    },
  };

  const authRepo = {
    findOne: async ({ where }: any) =>
      auths.find((row) =>
        Object.entries(where).every(([key, value]) => (row as any)[key] === value),
      ) ?? null,
    delete: async ({ id }: { id: string }) => {
      const index = auths.findIndex((row) => row.id === id);
      if (index >= 0) auths.splice(index, 1);
      return { affected: index >= 0 ? 1 : 0 };
    },
    createQueryBuilder: () => ({
      update: () => ({
        set: (patch: any) => ({
          where: (_sql: string, params: any) => ({
            execute: async () => {
              const row = auths.find((a) => a.id === params.id);
              if (!row || row.status !== params.status) {
                return { affected: 0 };
              }
              Object.assign(row, patch);
              return { affected: 1 };
            },
          }),
        }),
      }),
    }),
  };

  const chargeRepo = {
    findOne: async ({ where }: any) =>
      charges.find((row) =>
        Object.entries(where).every(([key, value]) => (row as any)[key] === value),
      ) ?? null,
    create: (value: any) => ({ ...value, id: value.id ?? "charge-1" }),
    save: async (row: any) => {
      charges.push(row);
      return row;
    },
  };

  const em = {
    getRepository: (entity: any) => {
      if (entity === BillingAuthorizationEntity) return authRepo;
      if (entity === BillingChargeEntity) return chargeRepo;
      throw new Error("unknown repository");
    },
    findOne: async (entity: any, opts: any) => {
      if (entity === BillingAuthorizationEntity) {
        return authRepo.findOne(opts);
      }
      return null;
    },
    query: async (sql: string, params: any[]) => {
      if (sql.includes('SELECT "createdAt" FROM users')) {
        return [{ createdAt: new Date() }];
      }
      if (
        sql.includes("SELECT id") &&
        sql.includes("billing_authorizations") &&
        sql.includes("expiresAt")
      ) {
        const due = auths.filter(
          (a) =>
            a.status === AuthorizationStatus.AUTHORIZED &&
            a.expiresAt &&
            new Date(a.expiresAt).getTime() < Date.now(),
        );
        return due.map((a) => ({ id: a.id }));
      }
      if (sql.includes("INSERT INTO billing_authorizations")) {
        const conflict = auths.find(
          (a) => a.adminId === params[1] && a.idempotencyKey === params[4],
        );
        if (conflict) return [];
        auths.push({
          id: params[0],
          adminId: params[1],
          service: params[2],
          operation: params[3],
          idempotencyKey: params[4],
          status: params[5],
          pricingVersion: params[6],
          pricingSnapshot: JSON.parse(params[7]),
          estimatedUsage: JSON.parse(params[8]),
          estimatedAmount: BigInt(params[9]),
          reservedAmount: BigInt(params[10]),
          reservationId: params[11],
          allowanceReservedUnits: BigInt(params[12]),
          context: params[13] ? JSON.parse(params[13]) : null,
          expiresAt: params[14],
        } as BillingAuthorizationEntity);
        return [{ id: params[0] }];
      }
      return [];
    },
  };

  const op = new AiDecisionEvaluateOperation({
    getSettings: vi.fn(),
    getCacheRevision: () => 0,
  } as never);
  op.getSettingsSnapshot = async () => snapshot;
  const allowance = createMemoryAllowance();
  const requestTranslations = {
    tAsync: async (key: string, _userId: string, options?: { args?: Record<string, unknown> }) => {
      if (key === "domains.billing.ai_decision_wallet_note") {
        return `AI usage — ${options?.args?.tokens} tokens — ${options?.args?.feature ?? ""}`;
      }
      if (key === "domains.automation.ai_address_completeness") {
        return "Verify delivery address completeness";
      }
      return key;
    },
  };
  const service = new BillingService(
    { transaction: async (fn: any) => fn(em) } as any,
    new BillingOperationRegistry([op]),
    wallet as any,
    allowance as unknown as AllowanceService,
    requestTranslations as any,
  );

  return { service, auths, charges, wallet, allowance };
}

const baseInput = {
  adminId: ADMIN,
  service: BillingServiceKey.AI_DECISION,
  operation: BillingOperationKey.EVALUATE,
  idempotencyKey: "run-1:step-1:ai-decision",
  estimatedUsage: usage,
};

describe("BillingService", () => {
  test("authorize reserves worst-case with 10% margin then finalize captures actual", async () => {
    const { service, wallet, charges, auths } = createHarness();
    const auth = await service.authorize(baseInput);
    expect(auth.authorized).toBe(true);
    if (!auth.authorized) return;
    expect(wallet.reserved).toBe(1_100_000n);

    const charge = await service.finalize({
      authorizationId: auth.authorizationId,
      usage: usage,
    });
    expect(charge.collectionStatus).toBe(CollectionStatus.COLLECTED);
    expect(charge.capturedAmount).toBe(1_000_000n);
    expect(charge.overageAmount).toBe(0n);
    expect(wallet.reserved).toBe(0n);
    expect(auths[0].status).toBe(AuthorizationStatus.FINALIZED);
    expect(charges).toHaveLength(1);
    expect(wallet.lastCaptureNotes).toBe("AI usage — 1,000,000 tokens — ");
  });

  test("finalize wallet note uses usage tokens and translated feature note", async () => {
    const { service, wallet } = createHarness();
    const auth = await service.authorize({
      ...baseInput,
      context: { note: "domains.automation.ai_address_completeness" },
    });
    expect(auth.authorized).toBe(true);
    if (!auth.authorized) return;
    await service.finalize({
      authorizationId: auth.authorizationId,
      usage,
    });
    expect(wallet.lastCaptureNotes).toBe(
      "AI usage — 1,000,000 tokens — Verify delivery address completeness",
    );
  });

  test("authorize is idempotent for the same key", async () => {
    const { service, wallet } = createHarness();
    const first = await service.authorize(baseInput);
    const reservedAfterFirst = wallet.reserved;
    const second = await service.authorize(baseInput);
    expect(second).toMatchObject({
      authorized: true,
      authorizationId: first.authorized ? first.authorizationId : undefined,
      replay: true,
    });
    expect(wallet.reserved).toBe(reservedAfterFirst);
  });

  test("same idempotency key with a different request hash is rejected", async () => {
    const { service } = createHarness();
    await service.authorize({
      ...baseInput,
      context: { requestHash: "aaa" },
    });
    await expect(
      service.authorize({
        ...baseInput,
        estimatedUsage: { inputTokens: 2n, outputTokens: 0n },
        context: { requestHash: "bbb" },
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
  });

  test("insufficient balance is a result, not an exception", async () => {
    const { service, auths } = createHarness({ available: 1n });
    const result = await service.authorize(baseInput);
    expect(result).toMatchObject({
      authorized: false,
      reason: "INSUFFICIENT_BALANCE",
    });
    expect(auths).toHaveLength(0);
  });

  test("finalize twice with the same usage returns the existing charge", async () => {
    const { service } = createHarness();
    const auth = await service.authorize(baseInput);
    if (!auth.authorized) return;
    const first = await service.finalize({
      authorizationId: auth.authorizationId,
      usage,
    });
    const second = await service.finalize({
      authorizationId: auth.authorizationId,
      usage,
    });
    expect(second.id).toBe(first.id);
  });

  test("finalize twice with different usage throws", async () => {
    const { service } = createHarness();
    const auth = await service.authorize(baseInput);
    if (!auth.authorized) return;
    await service.finalize({
      authorizationId: auth.authorizationId,
      usage,
    });
    await expect(
      service.finalize({
        authorizationId: auth.authorizationId,
        usage: { inputTokens: 1n, outputTokens: 0n },
      }),
    ).rejects.toBeInstanceOf(BillingConflictError);
  });

  test("release after authorize returns the hold; later finalize fails", async () => {
    const { service, wallet } = createHarness();
    const start = wallet.available;
    const auth = await service.authorize(baseInput);
    if (!auth.authorized) return;
    await service.release({
      authorizationId: auth.authorizationId,
      reason: "PROVIDER_ERROR",
    });
    expect(wallet.reserved).toBe(0n);
    expect(wallet.available).toBe(start);
    await expect(
      service.finalize({ authorizationId: auth.authorizationId, usage }),
    ).rejects.toBeInstanceOf(AuthorizationReleasedError);
  });

  test("release after finalize is a no-op", async () => {
    const { service, charges } = createHarness();
    const auth = await service.authorize(baseInput);
    if (!auth.authorized) return;
    await service.finalize({ authorizationId: auth.authorizationId, usage });
    await service.release({ authorizationId: auth.authorizationId });
    expect(charges).toHaveLength(1);
  });

  test("overage is clamped to reserved and recorded", async () => {
    const { service, auths } = createHarness();
    const auth = await service.authorize(baseInput);
    if (!auth.authorized) return;
    auths[0].reservedAmount = 1n;
    const charge = await service.finalize({
      authorizationId: auth.authorizationId,
      usage,
    });
    expect(charge.capturedAmount).toBe(1n);
    expect(charge.overageAmount).toBe(999_999n);
  });

  test("free tokens with empty wallet authorize and finalize at $0", async () => {
    const freeUsage = { inputTokens: 50000n, outputTokens: 0n };
    const { service, wallet, auths, allowance } = createHarness({
      available: 0n,
      allowance: { units: 100000, durationDays: null },
    });
    const auth = await service.authorize({
      ...baseInput,
      estimatedUsage: freeUsage,
    });
    expect(auth.authorized).toBe(true);
    expect(wallet.reserved).toBe(0n);
    expect(auths[0].allowanceReservedUnits).toBe(50000n);

    const charge = await service.finalize({
      authorizationId: (auth as any).authorizationId,
      usage: freeUsage,
    });
    expect(charge.payableAmount).toBe(0n);
    expect(charge.capturedAmount).toBe(0n);
    expect(charge.allowanceUnitsConsumed).toBe(50000n);
    const row = [...allowance.usageRows.values()][0];
    expect(row.used).toBe(50000n);
    expect(row.reserved).toBe(0n);
  });

  test("cap exhausted still needs wallet money", async () => {
    const { service, auths } = createHarness({
      available: 0n,
      allowance: { units: 0, durationDays: null },
    });
    const result = await service.authorize({
      ...baseInput,
      estimatedUsage: { inputTokens: 50000n, outputTokens: 0n },
    });
    expect(result).toMatchObject({
      authorized: false,
      reason: "INSUFFICIENT_BALANCE",
    });
    expect(auths).toHaveLength(0);
  });

  test("release returns booked free units to the pool", async () => {
    const freeUsage = { inputTokens: 50000n, outputTokens: 0n };
    const { service, allowance } = createHarness({
      available: 0n,
      allowance: { units: 100000, durationDays: null },
    });
    const auth = await service.authorize({
      ...baseInput,
      estimatedUsage: freeUsage,
    });
    if (!auth.authorized) return;
    expect([...allowance.usageRows.values()][0].reserved).toBe(50000n);
    await service.release({ authorizationId: auth.authorizationId });
    expect([...allowance.usageRows.values()][0].reserved).toBe(0n);
  });

  test("unlimited allowance locks nothing", async () => {
    const { service, wallet, auths, allowance } = createHarness({
      available: 0n,
      allowance: null,
    });
    const auth = await service.authorize(baseInput);
    expect(auth.authorized).toBe(true);
    expect(wallet.reserved).toBe(0n);
    expect(allowance.usageRows.size).toBe(0);
    const charge = await service.finalize({
      authorizationId: (auth as any).authorizationId,
      usage,
    });
    expect(charge.payableAmount).toBe(0n);
    expect(auths[0].status).toBe(AuthorizationStatus.FINALIZED);
  });

  test("expire releases the wallet hold", async () => {
    const { service, wallet, auths } = createHarness();
    const start = wallet.available;
    const auth = await service.authorize(baseInput);
    if (!auth.authorized) return;
    const expired = await service.expire(auth.authorizationId);
    expect(expired).toBe(true);
    expect(auths[0].status).toBe(AuthorizationStatus.EXPIRED);
    expect(wallet.reserved).toBe(0n);
    expect(wallet.available).toBe(start);
    expect(await service.expire(auth.authorizationId)).toBe(false);
  });

  test("late finalize after expire collects when wallet has funds", async () => {
    const { service, wallet, auths } = createHarness();
    const auth = await service.authorize(baseInput);
    if (!auth.authorized) return;
    await service.expire(auth.authorizationId);
    const charge = await service.finalize({
      authorizationId: auth.authorizationId,
      usage,
    });
    expect(charge.collectionStatus).toBe(CollectionStatus.COLLECTED);
    expect(charge.capturedAmount).toBe(1_000_000n);
    expect(auths[0].status).toBe(AuthorizationStatus.FINALIZED);
    expect(wallet.reserved).toBe(0n);
  });

  test("late finalize without funds is UNCOLLECTED", async () => {
    const { service, wallet } = createHarness();
    const auth = await service.authorize(baseInput);
    if (!auth.authorized) return;
    await service.expire(auth.authorizationId);
    wallet.available = 0n;
    const charge = await service.finalize({
      authorizationId: auth.authorizationId,
      usage,
    });
    expect(charge.collectionStatus).toBe(CollectionStatus.UNCOLLECTED);
    expect(charge.capturedAmount).toBe(0n);
    expect(charge.overageAmount).toBe(1_000_000n);
  });

  test("expireDue sweeps past-TTL authorizations", async () => {
    const { service, auths, wallet } = createHarness();
    const auth = await service.authorize(baseInput);
    if (!auth.authorized) return;
    auths[0].expiresAt = new Date(Date.now() - 1000);
    const n = await service.expireDue();
    expect(n).toBe(1);
    expect(auths[0].status).toBe(AuthorizationStatus.EXPIRED);
    expect(wallet.reserved).toBe(0n);
  });
});
