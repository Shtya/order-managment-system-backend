import {
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type {
  PaymentPurposeEnum,
  TransactionEntity,
  TransactionPaymentMethod,
  Wallet,
} from "entities/payments.entity";
import { EntityManager } from "typeorm";

export const WALLET_TRANSFER_TO_AI = "to_ai";
export const WALLET_TRANSFER_TO_WALLET = "to_wallet";
export const PURPOSE_WALLET_TO_AI = "wallet_to_ai";
export const PURPOSE_AI_TO_WALLET = "ai_to_wallet";

export type WalletTransferDirectionValue =
  | typeof WALLET_TRANSFER_TO_AI
  | typeof WALLET_TRANSFER_TO_WALLET;

export type TransferWalletApi = {
  getOrCreateWallet: (
    userId: string,
    manager?: EntityManager,
  ) => Promise<Wallet>;
  recordTransaction: (
    manager: EntityManager,
    input: {
      userId: string;
      amount: number | string;
      purpose: PaymentPurposeEnum;
      paymentMethod: TransactionPaymentMethod;
      notes: string;
      number?: string;
      orderId?: string;
      currency?: string;
    },
  ) => Promise<TransactionEntity>;
};

export function parseTransferAmount(
  amount: unknown,
  translate: (key: string) => string,
): string {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw new BadRequestException(
      translate("domains.payments.amount_must_be_positive"),
    );
  }
  const rounded = Math.round(n * 1_000_000) / 1_000_000;
  if (rounded <= 0) {
    throw new BadRequestException(
      translate("domains.payments.amount_must_be_positive"),
    );
  }
  return rounded.toFixed(6);
}

export function parseIdempotencyKey(raw: string | undefined) {
  const key = String(raw ?? "").trim();
  if (!key || key.length > 200) {
    throw new BadRequestException("Idempotency-Key is required");
  }
  return key;
}

export async function executeWalletTransfer(
  manager: EntityManager,
  input: {
    userId: string;
    amountStr: string;
    idempotencyKey: string;
    direction: WalletTransferDirectionValue;
    walletService: TransferWalletApi;
    translateNote: (key: string) => Promise<string>;
  },
) {
  const {
    userId,
    amountStr,
    idempotencyKey,
    direction,
    walletService,
    translateNote,
  } = input;
  const toAi = direction === WALLET_TRANSFER_TO_AI;
  const sourceCol = toAi ? "currentBalance" : "aiBalance";
  const destCol = toAi ? "aiBalance" : "currentBalance";
  const purpose = (
    toAi ? PURPOSE_WALLET_TO_AI : PURPOSE_AI_TO_WALLET
  ) as PaymentPurposeEnum;
  const notes = await translateNote(
    toAi
      ? "domains.payments.wallet_to_ai_note"
      : "domains.payments.ai_to_wallet_note",
  );

  await walletService.getOrCreateWallet(userId, manager);
  const inserted = await manager.query(
    `INSERT INTO wallet_transfers
       (id, "adminId", direction, amount, "idempotencyKey")
     VALUES
       (gen_random_uuid(), $1, $2, $3::numeric, $4)
     ON CONFLICT ("adminId", "idempotencyKey") DO NOTHING
     RETURNING id, amount, "transactionId"`,
    [userId, direction, amountStr, idempotencyKey],
  );
  const row = inserted?.[0] ?? inserted?.rows?.[0];
  if (!row) {
    const existingRows = await manager.query(
      `SELECT id, amount, "transactionId"
       FROM wallet_transfers
       WHERE "adminId" = $1 AND "idempotencyKey" = $2
       LIMIT 1`,
      [userId, idempotencyKey],
    );
    const existing = existingRows?.[0] ?? existingRows?.rows?.[0];
    if (!existing) {
      throw new BadRequestException("Idempotency-Key is required");
    }
    const existingAmt = Number(existing.amount).toFixed(6);
    if (existingAmt !== amountStr) {
      throw new ConflictException("This move was already completed");
    }
    const wallet = await walletService.getOrCreateWallet(userId, manager);
    return {
      ...wallet,
      transferId: existing.id,
      transactionId: existing.transactionId,
      replay: true,
    };
  }

  const moved = await manager.query(
    `UPDATE wallets
     SET "${sourceCol}" = "${sourceCol}" - $1::numeric,
         "${destCol}" = "${destCol}" + $1::numeric
     WHERE "userId" = $2
       AND "${sourceCol}" >= $1::numeric
     RETURNING id, "currentBalance", "aiBalance", "reservedBalance", "reservedAiBalance",
               "totalCharged", "totalWithdrawn"`,
    [amountStr, userId],
  );
  const walletRow = moved?.[0] ?? moved?.rows?.[0];
  if (!walletRow) {
    await manager.query(`DELETE FROM wallet_transfers WHERE id = $1`, [row.id]);
    throw new UnprocessableEntityException(
      toAi
        ? "Not enough money in the main wallet"
        : "Not enough money in the AI wallet",
    );
  }

  const tx = await walletService.recordTransaction(manager, {
    userId,
    amount: amountStr,
    purpose,
    paymentMethod: "other" as TransactionPaymentMethod,
    notes,
  });
  await manager.query(
    `UPDATE wallet_transfers SET "transactionId" = $1 WHERE id = $2`,
    [tx.id, row.id],
  );
  const wallet = await walletService.getOrCreateWallet(userId, manager);
  return {
    ...wallet,
    transferId: row.id,
    transactionId: tx.id,
    replay: false,
  };
}
