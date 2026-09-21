import { Injectable } from "@nestjs/common";
import {
  AllowanceGrant,
  BillingAuthorizationEntity,
  BillingOperationKey,
  BillingServiceKey,
  BillingUnit,
} from "entities/billing.entity";
import { EntityManager } from "typeorm";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type AllowanceReserveInput = {
  adminId: string;
  service: BillingServiceKey;
  operation: BillingOperationKey;
  unit: BillingUnit;
  maxUnits: bigint;
  authorizationId: string;
  capUnits: bigint | null;
  durationDays: number | null;
  accountCreatedAt: Date | null;
  manager: EntityManager;
};

@Injectable()
export class AllowanceService {
  async reserve(input: AllowanceReserveInput): Promise<AllowanceGrant> {
    const maxUnits = input.maxUnits < 0n ? 0n : input.maxUnits;
    if (input.capUnits === null) {
      return { unit: input.unit, remainingUnits: maxUnits };
    }
    if (this.isExpired(input.durationDays, input.accountCreatedAt)) {
      return { unit: input.unit, remainingUnits: 0n };
    }
    if (input.capUnits <= 0n || maxUnits <= 0n) {
      return { unit: input.unit, remainingUnits: 0n };
    }

    await input.manager.query(
      `INSERT INTO billing_allowance_usage (
         id, "adminId", service, operation, "usedUnits", "reservedUnits"
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, 0, 0
       )
       ON CONFLICT ("adminId", service, operation) DO NOTHING`,
      [input.adminId, input.service, input.operation],
    );

    const booked = await input.manager.query(
      `WITH cur AS (
         SELECT
           LEAST(
             $4::bigint,
             GREATEST($5::bigint - "usedUnits" - "reservedUnits", 0)
           ) AS n
         FROM billing_allowance_usage
         WHERE "adminId" = $1 AND service = $2 AND operation = $3
         FOR UPDATE
       ),
       upd AS (
         UPDATE billing_allowance_usage u
         SET "reservedUnits" = u."reservedUnits" + cur.n
         FROM cur
         WHERE u."adminId" = $1
           AND u.service = $2
           AND u.operation = $3
           AND cur.n > 0
       )
       SELECT n FROM cur`,
      [
        input.adminId,
        input.service,
        input.operation,
        maxUnits.toString(),
        input.capUnits.toString(),
      ],
    );
    const row = booked?.[0] ?? booked?.rows?.[0];
    return {
      unit: input.unit,
      remainingUnits: BigInt(row?.n ?? 0),
    };
  }

  async commit(
    authorizationId: string,
    consumedUnits: bigint,
    manager: EntityManager,
  ): Promise<void> {
    const auth = await manager.findOne(BillingAuthorizationEntity, {
      where: { id: authorizationId },
    });
    if (!auth || auth.allowanceReservedUnits <= 0n) {
      return;
    }
    const booked = auth.allowanceReservedUnits;
    let used = consumedUnits;
    if (used < 0n) used = 0n;
    if (used > booked) used = booked;

    await manager.query(
      `UPDATE billing_allowance_usage
       SET "reservedUnits" = "reservedUnits" - $1,
           "usedUnits" = "usedUnits" + $2
       WHERE "adminId" = $3
         AND service = $4
         AND operation = $5
         AND "reservedUnits" >= $1`,
      [
        booked.toString(),
        used.toString(),
        auth.adminId,
        auth.service,
        auth.operation,
      ],
    );
  }

  async commitUsedOnly(
    authorizationId: string,
    consumedUnits: bigint,
    manager: EntityManager,
  ): Promise<void> {
    const auth = await manager.findOne(BillingAuthorizationEntity, {
      where: { id: authorizationId },
    });
    if (!auth || consumedUnits <= 0n) {
      return;
    }
    let used = consumedUnits;
    if (auth.allowanceReservedUnits > 0n && used > auth.allowanceReservedUnits) {
      used = auth.allowanceReservedUnits;
    }
    await manager.query(
      `UPDATE billing_allowance_usage
       SET "usedUnits" = "usedUnits" + $1
       WHERE "adminId" = $2
         AND service = $3
         AND operation = $4`,
      [used.toString(), auth.adminId, auth.service, auth.operation],
    );
  }

  async release(
    authorizationId: string,
    manager: EntityManager,
  ): Promise<void> {
    const auth = await manager.findOne(BillingAuthorizationEntity, {
      where: { id: authorizationId },
    });
    if (!auth || auth.allowanceReservedUnits <= 0n) {
      return;
    }
    await this.releaseUnits({
      adminId: auth.adminId,
      service: auth.service,
      operation: auth.operation,
      units: auth.allowanceReservedUnits,
      manager,
    });
  }

  async releaseUnits(input: {
    adminId: string;
    service: BillingServiceKey;
    operation: BillingOperationKey;
    units: bigint;
    manager: EntityManager;
  }): Promise<void> {
    if (input.units <= 0n) {
      return;
    }
    await input.manager.query(
      `UPDATE billing_allowance_usage
       SET "reservedUnits" = "reservedUnits" - $1
       WHERE "adminId" = $2
         AND service = $3
         AND operation = $4
         AND "reservedUnits" >= $1`,
      [
        input.units.toString(),
        input.adminId,
        input.service,
        input.operation,
      ],
    );
  }

  currentGrant(
    allowanceReservedUnits: bigint,
    unit: BillingUnit,
  ): AllowanceGrant {
    return {
      unit,
      remainingUnits: allowanceReservedUnits ?? 0n,
    };
  }

  private isExpired(
    durationDays: number | null,
    accountCreatedAt: Date | null,
  ): boolean {
    if (durationDays === null || durationDays === undefined) {
      return false;
    }
    if (!accountCreatedAt) {
      return true;
    }
    return Date.now() > accountCreatedAt.getTime() + durationDays * MS_PER_DAY;
  }
}
