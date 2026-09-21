import { Injectable, Logger } from "@nestjs/common";
import { createHash, randomUUID } from "crypto";
import {
  AuthorizationStatus,
  AuthorizeInput,
  AuthorizeResult,
  BillingAuthorizationEntity,
  BillingChargeEntity,
  ChargeLine,
  ChargeResult,
  CollectionStatus,
  FinalizeInput,
  Micros,
  ReleaseInput,
} from "entities/billing.entity";
import { DataSource, EntityManager } from "typeorm";
import { dollarNumericToMicros } from "common/money/micros";
import { AllowanceService } from "./allowance/allowance.service";
import {
  AuthorizationNotFoundError,
  AuthorizationReleasedError,
  BillingConflictError,
  IdempotencyKeyReuseError,
} from "./billing.errors";
import { BillingOperationRegistry } from "./operations/billing-operation.registry";
import { WalletHoldService } from "src/wallet/wallet-hold.service";
import { RequestTranslationService } from "common/translation.service";
import type { I18nKey } from "common/translation.service";

const DEFAULT_TTL_MS = 5 * 60 * 1000;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function fingerprintOf(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function serializeChargeLines(lines: ChargeLine[]): unknown[] {
  return lines.map((line) => ({
    meter: line.meter,
    unit: line.unit,
    quantity: line.quantity.toString(),
    freeQuantity: line.freeQuantity.toString(),
    unitPricePerMillion: line.unitPricePerMillion.toString(),
    amount: line.amount.toString(),
  }));
}

function serializeCharge(charge: ChargeResult) {
  return {
    lines: serializeChargeLines(charge.lines),
    grossAmount: charge.grossAmount.toString(),
    payableAmount: charge.payableAmount.toString(),
    allowanceUnitsConsumed: charge.allowanceUnitsConsumed.toString(),
  };
}

function minMicros(a: Micros, b: Micros): Micros {
  return a < b ? a : b;
}

function parseReplay(raw: unknown): { answers: unknown; modelVersion: string } | null {
  if (!raw) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object" || parsed.answers == null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly registry: BillingOperationRegistry,
    private readonly walletHoldService: WalletHoldService,
    private readonly allowanceService: AllowanceService,
    private readonly requestTranslations: RequestTranslationService,
  ) {}

  private tokensFromUsage(actual: unknown): bigint {
    if (!actual || typeof actual !== "object") return 0n;
    const usage = actual as { inputTokens?: bigint; outputTokens?: bigint };
    return (usage.inputTokens ?? 0n) + (usage.outputTokens ?? 0n);
  }

  private async walletCaptureNotes(
    auth: BillingAuthorizationEntity,
    actual: unknown,
  ): Promise<string> {
    const tokens = this.tokensFromUsage(actual).toLocaleString("en-US");
    const rawNote = auth.context?.note?.trim() ?? "";
    let feature = rawNote;
    if (rawNote.startsWith("domains.")) {
      feature = await this.requestTranslations.tAsync(
        rawNote as I18nKey,
        auth.adminId,
      );
    }
    return this.requestTranslations.tAsync(
      "domains.billing.ai_decision_wallet_note",
      auth.adminId,
      { args: { tokens, feature } },
    );
  }

  private ttlMs(): number {
    const raw = process.env.BILLING_AUTHORIZATION_TTL_MS;
    const parsed = raw ? Number(raw) : DEFAULT_TTL_MS;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS;
  }

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const operation = this.registry.get(input.service, input.operation);
    const estimated = operation.parseUsage(input.estimatedUsage);
    const requestHash =
      input.context?.requestHash ?? fingerprintOf(input.estimatedUsage);
    const context: Record<string, string> = {
      ...(input.context ?? {}),
      requestHash,
    };

    return this.dataSource.transaction(async (em) => {
      const authRepo = em.getRepository(BillingAuthorizationEntity);
      const existing = await authRepo.findOne({
        where: {
          adminId: input.adminId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      if (existing) {
        return this.resultForExistingAuth(
          existing,
          requestHash,
          input.idempotencyKey,
        );
      }

      const settingsSnapshot = await operation.getSettingsSnapshot();
      const pricing = operation.parsePricing(settingsSnapshot.rawSettings);
      const policy = operation.allowancePolicy(pricing);
      const maxUnits = operation.authorizationRequirement(
        estimated,
        pricing,
      ).maxUnits.quantity;
      const authorizationId = randomUUID();
      const account = await em.query(
        `SELECT "createdAt" FROM users WHERE id = $1 LIMIT 1`,
        [input.adminId],
      );
      const accountRow = account?.[0] ?? account?.rows?.[0];
      const accountCreatedAt = accountRow?.createdAt
        ? new Date(accountRow.createdAt)
        : null;
      const grant = await this.allowanceService.reserve({
        adminId: input.adminId,
        service: input.service,
        operation: input.operation,
        unit: operation.primaryUnit,
        maxUnits,
        authorizationId,
        capUnits: policy.capUnits,
        durationDays: policy.durationDays,
        accountCreatedAt,
        manager: em,
      });
      const payable = operation.calculateCharge(
        estimated,
        pricing,
        grant,
      ).payableAmount;
      const amountToReserve =
        payable <= 0n
          ? 0n
          : ceilDiv(
              payable *
                (100n + BigInt(policy.reservationSafetyMarginPercent)),
              100n,
            );

      const inserted = await em.query(
        `INSERT INTO billing_authorizations (
           id, "adminId", service, operation, "idempotencyKey",
           status, "pricingVersion", "pricingSnapshot", "estimatedUsage",
           "estimatedAmount", "reservedAmount", "reservationId", "allowanceReservedUnits",
           context, "expiresAt"
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14::jsonb,$15
         )
         ON CONFLICT ("adminId", "idempotencyKey") DO NOTHING
         RETURNING id`,
        [
          authorizationId,
          input.adminId,
          input.service,
          input.operation,
          input.idempotencyKey,
          AuthorizationStatus.AUTHORIZED,
          settingsSnapshot.version,
          JSON.stringify(settingsSnapshot),
          JSON.stringify(canonicalize(input.estimatedUsage ?? null)),
          amountToReserve.toString(),
          amountToReserve.toString(),
          authorizationId,
          grant.remainingUnits.toString(),
          JSON.stringify(context),
          new Date(Date.now() + this.ttlMs()),
        ],
      );
      const insertedId = inserted?.[0]?.id ?? inserted?.rows?.[0]?.id;
      if (!insertedId) {
        if (policy.capUnits !== null && grant.remainingUnits > 0n) {
          await this.allowanceService.releaseUnits({
            adminId: input.adminId,
            service: input.service,
            operation: input.operation,
            units: grant.remainingUnits,
            manager: em,
          });
        }
        const conflict = await authRepo.findOne({
          where: {
            adminId: input.adminId,
            idempotencyKey: input.idempotencyKey,
          },
        });
        if (!conflict) {
          throw new AuthorizationNotFoundError(authorizationId);
        }
        return this.resultForExistingAuth(
          conflict,
          requestHash,
          input.idempotencyKey,
        );
      }

      const hold = await this.walletHoldService.reserve(
        input.adminId,
        amountToReserve,
        em,
      );
      if (hold.reserved === false) {
        await this.allowanceService.release(authorizationId, em);
        await authRepo.delete({ id: authorizationId });
        return {
          authorized: false as const,
          reason: "INSUFFICIENT_BALANCE" as const,
          required: hold.required,
          available: hold.available,
        };
      }

      return {
        authorized: true as const,
        authorizationId,
        reservationId: authorizationId,
      };
    });
  }

  async finalize(input: FinalizeInput): Promise<BillingChargeEntity> {
    return this.dataSource.transaction(async (em) => {
      const authRepo = em.getRepository(BillingAuthorizationEntity);
      const chargeRepo = em.getRepository(BillingChargeEntity);
      const auth = await authRepo.findOne({
        where: { id: input.authorizationId },
        lock: { mode: "pessimistic_write" },
      });
      if (!auth) {
        throw new AuthorizationNotFoundError(input.authorizationId);
      }

      if (auth.status === AuthorizationStatus.FINALIZED) {
        const existing = await chargeRepo.findOne({
          where: { authorizationId: auth.id },
        });
        if (!existing) {
          throw new BillingConflictError(
            `Finalized authorization ${auth.id} has no charge`,
          );
        }
        const nextFp = fingerprintOf(input.usage);
        const prevFp = fingerprintOf(existing.actualUsage);
        if (nextFp !== prevFp) {
          throw new BillingConflictError(
            "Authorization already finalized with different usage",
          );
        }
        return existing;
      }

      if (auth.status === AuthorizationStatus.RELEASED) {
        throw new AuthorizationReleasedError();
      }
      if (auth.status === AuthorizationStatus.EXPIRED) {
        return this.lateFinalize(auth, input, em, authRepo, chargeRepo);
      }
      if (auth.status !== AuthorizationStatus.AUTHORIZED) {
        throw new BillingConflictError(
          `Cannot finalize authorization in status ${auth.status}`,
        );
      }

      const operation = this.registry.get(auth.service, auth.operation);
      const snapshot = auth.pricingSnapshot;
      const pricing = operation.parsePricing(snapshot.rawSettings);
      const actual = operation.parseUsage(input.usage);
      const grant = this.allowanceService.currentGrant(
        auth.allowanceReservedUnits,
        operation.primaryUnit,
      );
      const charge = operation.calculateCharge(actual, pricing, grant);
      const capturedAmount = minMicros(charge.payableAmount, auth.reservedAmount);
      const overageAmount =
        charge.payableAmount > auth.reservedAmount
          ? charge.payableAmount - auth.reservedAmount
          : 0n;
      if (overageAmount > 0n) {
        this.logger.error(
          `Billing overage authorizationId=${auth.id} overage=${overageAmount} payable=${charge.payableAmount} reserved=${auth.reservedAmount}`,
        );
      }

      const { walletTransactionId } = await this.walletHoldService.capture(
        auth.adminId,
        auth.reservedAmount,
        capturedAmount,
        em,
        await this.walletCaptureNotes(auth, actual),
      );
      await this.allowanceService.commit(auth.id, charge.allowanceUnitsConsumed, em);

      const serialized = serializeCharge(charge);
      const chargeRow = chargeRepo.create({
        authorizationId: auth.id,
        adminId: auth.adminId,
        service: auth.service,
        operation: auth.operation,
        actualUsage: input.usage,
        chargeLines: serialized.lines as ChargeLine[],
        grossAmount: charge.grossAmount,
        payableAmount: charge.payableAmount,
        capturedAmount,
        overageAmount,
        allowanceUnitsConsumed: charge.allowanceUnitsConsumed,
        currency: "USD",
        collectionStatus: CollectionStatus.COLLECTED,
        walletTransactionId,
      });

      try {
        await chargeRepo.save(chargeRow);
      } catch (err: any) {
        if (err?.code !== "23505" && err?.driverError?.code !== "23505") {
          throw err;
        }
        const raced = await chargeRepo.findOne({
          where: { authorizationId: auth.id },
        });
        if (!raced) throw err;
        return raced;
      }

      const moved = await authRepo
        .createQueryBuilder()
        .update(BillingAuthorizationEntity)
        .set({
          status: AuthorizationStatus.FINALIZED,
          finalizedAt: new Date(),
        })
        .where("id = :id AND status = :status", {
          id: auth.id,
          status: AuthorizationStatus.AUTHORIZED,
        })
        .execute();
      if (!moved.affected) {
        const latest = await authRepo.findOne({ where: { id: auth.id } });
        if (latest?.status === AuthorizationStatus.FINALIZED) {
          const existing = await chargeRepo.findOne({
            where: { authorizationId: auth.id },
          });
          if (existing) return existing;
        }
        throw new BillingConflictError(
          `Authorization ${auth.id} moved before finalize committed`,
        );
      }

      return chargeRow;
    });
  }

  async release(input: ReleaseInput): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const authRepo = em.getRepository(BillingAuthorizationEntity);
      const moved = await authRepo
        .createQueryBuilder()
        .update(BillingAuthorizationEntity)
        .set({
          status: AuthorizationStatus.RELEASED,
          releasedAt: new Date(),
          releaseReason: input.reason ?? "RELEASED",
        })
        .where("id = :id AND status = :status", {
          id: input.authorizationId,
          status: AuthorizationStatus.AUTHORIZED,
        })
        .execute();

      if (moved.affected) {
        const auth = await authRepo.findOne({
          where: { id: input.authorizationId },
        });
        if (auth && auth.reservedAmount > 0n) {
          await this.walletHoldService.releaseHold(
            auth.adminId,
            auth.reservedAmount,
            em,
          );
        }
        await this.allowanceService.release(input.authorizationId, em);
        return;
      }

      const auth = await authRepo.findOne({
        where: { id: input.authorizationId },
      });
      if (!auth) {
        throw new AuthorizationNotFoundError(input.authorizationId);
      }
      if (auth.status === AuthorizationStatus.FINALIZED) {
        this.logger.warn(
          `Ignoring release after finalize authorizationId=${auth.id}`,
        );
        return;
      }
      if (
        auth.status === AuthorizationStatus.RELEASED ||
        auth.status === AuthorizationStatus.EXPIRED
      ) {
        return;
      }
      throw new BillingConflictError(
        `Cannot release authorization in status ${auth.status}`,
      );
    });
  }

  async saveDecisionReplay(
    authorizationId: string,
    replay: { answers: unknown; modelVersion: string },
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE billing_authorizations
       SET context = COALESCE(context, '{}'::jsonb) || $2::jsonb
       WHERE id = $1`,
      [authorizationId, JSON.stringify({ replay: JSON.stringify(replay) })],
    );
  }

  private resultForExistingAuth(
    existing: BillingAuthorizationEntity,
    requestHash: string,
    idempotencyKey: string,
  ): AuthorizeResult {
    const storedHash = existing.context?.requestHash;
    if (storedHash && storedHash !== requestHash) {
      throw new IdempotencyKeyReuseError(idempotencyKey);
    }
    const replayPayload = parseReplay(existing.context?.replay);
    if (
      existing.status === AuthorizationStatus.AUTHORIZED ||
      existing.status === AuthorizationStatus.FINALIZED
    ) {
      return {
        authorized: true,
        authorizationId: existing.id,
        reservationId: existing.reservationId ?? existing.id,
        replay: true,
        ...(replayPayload ? { replayPayload } : {}),
      };
    }
    if (existing.status === AuthorizationStatus.RELEASED) {
      throw new AuthorizationReleasedError();
    }
    throw new BillingConflictError(
      `Idempotent authorize replay in status ${existing.status}`,
    );
  }

  async expire(authorizationId: string): Promise<boolean> {
    return this.dataSource.transaction(async (em) => {
      return this.expireInTransaction(authorizationId, em);
    });
  }

  async expireDue(limit = 30, batchSize = 3): Promise<number> {
    return this.dataSource.transaction(async (em) => {
      const rows = await em.query(
        `SELECT id
         FROM billing_authorizations
         WHERE status = $1
           AND "expiresAt" < NOW()
         ORDER BY "expiresAt" ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [AuthorizationStatus.AUTHORIZED, limit],
      );
  
      const list = Array.isArray(rows) ? rows : (rows?.rows ?? []);
  
      let processed = 0;
  
      for (let i = 0; i < list.length; i += batchSize) {
        const batch = list.slice(i, i + batchSize);
  
        const results = await Promise.allSettled(
          batch.map((row) => this.expireInTransaction(row.id, em)),
        );
  
        for (const result of results) {
          if (result.status === 'fulfilled') {
            processed++;
          } else {
            throw result.reason;
          }
        }
      }
  
      return processed;
    });
  }

  async reconcileHolds(limit = 100): Promise<number> {
    let lastAdminId = '';
    let mismatchesCount = 0;
  
    while (true) {
      const rows = await this.dataSource.query(
        `WITH admin_ids AS (
           SELECT "userId" AS "adminId"
           FROM wallets
           WHERE "userId" > $1
  
           UNION
  
           SELECT "adminId"
           FROM billing_authorizations
           WHERE status = $2
             AND "adminId" > $1
         ),
         batch AS (
           SELECT "adminId"
           FROM admin_ids
           ORDER BY "adminId"
           LIMIT $3
         )
         SELECT
           b."adminId",
           w."reservedBalance",
           COALESCE(SUM(ba."reservedAmount"), 0)::text AS held
         FROM batch b
         LEFT JOIN wallets w
           ON w."userId" = b."adminId"
         LEFT JOIN billing_authorizations ba
           ON ba."adminId" = b."adminId"
          AND ba.status = $2
         GROUP BY b."adminId", w."reservedBalance"
         ORDER BY b."adminId"`,
        [lastAdminId, AuthorizationStatus.AUTHORIZED, limit],
      );
  
      const list = Array.isArray(rows) ? rows : (rows?.rows ?? []);
  
      if (list.length === 0) {
        break;
      }
  
      for (const row of list) {
        const walletMicros = dollarNumericToMicros(row.reservedBalance ?? 0);
        const billingMicros = BigInt(row.held ?? 0);
  
        if (walletMicros !== billingMicros) {
          mismatchesCount++;
  
          if (mismatchesCount <= 5) {
            this.logger.error(
              `Billing reconciliation mismatch admin=${row.adminId} ` +
              `walletReserved=${walletMicros} billingHeld=${billingMicros}`,
            );
          }
        }
      }
  
      lastAdminId = list[list.length - 1].adminId;
  
      if (list.length < limit) {
        break;
      }
    }
  
    if (mismatchesCount > 0) {
      this.logger.error(
        `Billing reconciliation mismatches=${mismatchesCount}`,
      );
    }
  
    return mismatchesCount;
  }

  private async expireInTransaction(
    authorizationId: string,
    em: EntityManager,
  ): Promise<boolean> {
    const authRepo = em.getRepository(BillingAuthorizationEntity);
    const moved = await authRepo
      .createQueryBuilder()
      .update(BillingAuthorizationEntity)
      .set({
        status: AuthorizationStatus.EXPIRED,
        releasedAt: new Date(),
        releaseReason: "EXPIRED",
      })
      .where("id = :id AND status = :status", {
        id: authorizationId,
        status: AuthorizationStatus.AUTHORIZED,
      })
      .execute();
    if (!moved.affected) {
      return false;
    }
    const auth = await authRepo.findOne({
      where: { id: authorizationId },
    });
    if (auth && auth.reservedAmount > 0n) {
      await this.walletHoldService.releaseHold(
        auth.adminId,
        auth.reservedAmount,
        em,
      );
    }
    await this.allowanceService.release(authorizationId, em);
    return true;
  }

  private async lateFinalize(
    auth: BillingAuthorizationEntity,
    input: FinalizeInput,
    em: EntityManager,
    authRepo: any,
    chargeRepo: any,
  ): Promise<BillingChargeEntity> {
    const existing = await chargeRepo.findOne({
      where: { authorizationId: auth.id },
    });
    if (existing) {
      return existing;
    }
    const operation = this.registry.get(auth.service, auth.operation);
    const snapshot = auth.pricingSnapshot;
    const pricing = operation.parsePricing(snapshot.rawSettings);
    const actual = operation.parseUsage(input.usage);
    const grant = this.allowanceService.currentGrant(
      auth.allowanceReservedUnits,
      operation.primaryUnit,
    );
    const charge = operation.calculateCharge(actual, pricing, grant);
    let capturedAmount = 0n;
    let overageAmount = 0n;
    let collectionStatus = CollectionStatus.COLLECTED;
    let walletTransactionId: string | null = null;

    if (charge.payableAmount > 0n) {
      const hold = await this.walletHoldService.reserve(
        auth.adminId,
        charge.payableAmount,
        em,
      );
      if (hold.reserved) {
        const captured = await this.walletHoldService.capture(
          auth.adminId,
          charge.payableAmount,
          charge.payableAmount,
          em,
          await this.walletCaptureNotes(auth, actual),
        );
        capturedAmount = charge.payableAmount;
        walletTransactionId = captured.walletTransactionId;
      } else {
        collectionStatus = CollectionStatus.UNCOLLECTED;
        overageAmount = charge.payableAmount;
        this.logger.error(
          `Late finalize uncollected authorizationId=${auth.id} payable=${charge.payableAmount} available=${hold.available}`,
        );
      }
    }

    await this.allowanceService.commitUsedOnly(
      auth.id,
      charge.allowanceUnitsConsumed,
      em,
    );

    const serialized = serializeCharge(charge);
    const chargeRow = chargeRepo.create({
      authorizationId: auth.id,
      adminId: auth.adminId,
      service: auth.service,
      operation: auth.operation,
      actualUsage: input.usage,
      chargeLines: serialized.lines as ChargeLine[],
      grossAmount: charge.grossAmount,
      payableAmount: charge.payableAmount,
      capturedAmount,
      overageAmount,
      allowanceUnitsConsumed: charge.allowanceUnitsConsumed,
      currency: "USD",
      collectionStatus,
      walletTransactionId,
    });
    await chargeRepo.save(chargeRow);

    await authRepo
      .createQueryBuilder()
      .update(BillingAuthorizationEntity)
      .set({
        status: AuthorizationStatus.FINALIZED,
        finalizedAt: new Date(),
      })
      .where("id = :id AND status = :status", {
        id: auth.id,
        status: AuthorizationStatus.EXPIRED,
      })
      .execute();

    return chargeRow;
  }
}

