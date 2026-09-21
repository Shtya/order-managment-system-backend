import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { dollarNumericToMicros, microsToDollarNumeric } from "common/money/micros";
import {
  PaymentPurposeEnum,
  TransactionPaymentMethod,
  Wallet,
} from "entities/payments.entity";
import { EntityManager } from "typeorm";
import { WalletService } from "./wallet.service";

@Injectable()
export class WalletHoldService {
  constructor(private readonly walletService: WalletService) {}

  private async getOrCreate(userId: string, manager: EntityManager): Promise<Wallet> {
    let wallet = await manager.findOne(Wallet, { where: { userId } });
    if (!wallet) {
      wallet = await manager.save(
        manager.create(Wallet, {
          userId,
          currentBalance: 0,
          totalCharged: 0,
          totalWithdrawn: 0,
          reservedBalance: 0,
        }),
      );
    }
    return wallet;
  }

  async reserve(
    userId: string,
    amountMicros: bigint,
    manager: EntityManager,
  ): Promise<
    | { reserved: true; reservationId: string; available: bigint }
    | { reserved: false; available: bigint; required: bigint }
  > {
    const wallet = await this.getOrCreate(userId, manager);
    if (amountMicros < 0n) {
      throw new Error("Wallet reserve amount must be >= 0");
    }
    if (amountMicros === 0n) {
      return {
        reserved: true,
        reservationId: wallet.id,
        available: dollarNumericToMicros(wallet.currentBalance),
      };
    }

    const amt = microsToDollarNumeric(amountMicros);
    const updated = await manager.query(
      `WITH attempted AS (
         UPDATE wallets
         SET "currentBalance" = "currentBalance" - $1::numeric,
             "reservedBalance" = "reservedBalance" + $1::numeric
         WHERE "userId" = $2
           AND "currentBalance" >= $1::numeric
         RETURNING id, "currentBalance"
       )
       SELECT id, "currentBalance", true AS reserved FROM attempted
       UNION ALL
       SELECT id, "currentBalance", false AS reserved FROM wallets
       WHERE "userId" = $2
         AND NOT EXISTS (SELECT 1 FROM attempted)`,
      [amt, userId],
    );
    const row = updated?.[0] ?? updated?.rows?.[0];
    const available = dollarNumericToMicros(row?.currentBalance ?? 0);
    if (row?.reserved === true || row?.reserved === "t") {
      return {
        reserved: true,
        reservationId: row.id,
        available,
      };
    }
    return {
      reserved: false,
      available,
      required: amountMicros,
    };
  }

  async capture(
    userId: string,
    reservedMicros: bigint,
    capturedMicros: bigint,
    manager: EntityManager,
    notes = "billing_capture",
  ): Promise<{ walletTransactionId: string | null }> {
    if (reservedMicros < 0n || capturedMicros < 0n) {
      throw new Error("Wallet capture amounts must be >= 0");
    }
    if (capturedMicros > reservedMicros) {
      throw new Error("Wallet capture cannot exceed reserved amount");
    }
    if (reservedMicros === 0n) {
      return { walletTransactionId: null };
    }

    const remainder = microsToDollarNumeric(reservedMicros - capturedMicros);
    const reserved = microsToDollarNumeric(reservedMicros);
    const captured = microsToDollarNumeric(capturedMicros);
    const updated = await manager.query(
      `UPDATE wallets
       SET "currentBalance" = "currentBalance" + $1::numeric,
           "reservedBalance" = "reservedBalance" - $2::numeric,
           "totalWithdrawn" = "totalWithdrawn" + $3::numeric
       WHERE "userId" = $4
         AND "reservedBalance" >= $2::numeric
       RETURNING id`,
      [remainder, reserved, captured, userId],
    );
    const row = updated?.[0] ?? updated?.rows?.[0];
    if (!row) {
      throw new Error("Wallet capture failed: reserved balance is missing");
    }

    if (capturedMicros === 0n) {
      return { walletTransactionId: null };
    }

    const saved = await this.walletService.recordTransaction(manager, {
      userId,
      amount: captured,
      purpose: PaymentPurposeEnum.WALLET_WITHDRAWAL,
      paymentMethod: TransactionPaymentMethod.OTHER,
      number: `BILL-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`,
      notes,
    });
    return { walletTransactionId: saved.id };
  }

  async releaseHold(
    userId: string,
    reservedMicros: bigint,
    manager: EntityManager,
  ): Promise<void> {
    if (reservedMicros < 0n) {
      throw new Error("Wallet release amount must be >= 0");
    }
    if (reservedMicros === 0n) {
      return;
    }
    const reserved = microsToDollarNumeric(reservedMicros);
    const updated = await manager.query(
      `UPDATE wallets
       SET "currentBalance" = "currentBalance" + $1::numeric,
           "reservedBalance" = "reservedBalance" - $1::numeric
       WHERE "userId" = $2
         AND "reservedBalance" >= $1::numeric
       RETURNING id`,
      [reserved, userId],
    );
    const row = updated?.[0] ?? updated?.rows?.[0];
    if (!row) {
      throw new Error("Wallet release failed: reserved balance is missing");
    }
  }
}
