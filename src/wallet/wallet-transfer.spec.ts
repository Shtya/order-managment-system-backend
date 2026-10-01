import { describe, expect, test } from "vitest";
import {
  ConflictException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  executeWalletTransfer,
  parseTransferAmount,
  PURPOSE_AI_TO_WALLET,
  PURPOSE_WALLET_TO_AI,
  WALLET_TRANSFER_TO_AI,
  WALLET_TRANSFER_TO_WALLET,
} from "./wallet-transfer";

const USER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function createTransferHarness(balances?: {
  currentBalance?: number;
  aiBalance?: number;
}) {
  const wallet = {
    id: "wallet-1",
    userId: USER,
    currentBalance: balances?.currentBalance ?? 10,
    aiBalance: balances?.aiBalance ?? 5,
    reservedBalance: 0,
    reservedAiBalance: 0,
    totalCharged: 0,
    totalWithdrawn: 0,
  };
  const transfers: Array<{
    id: string;
    adminId: string;
    direction: string;
    amount: string;
    idempotencyKey: string;
    transactionId: string | null;
  }> = [];
  const transactions: Array<{ id: string; purpose: string }> = [];

  const manager = {
    query: async (sql: string, params: any[]) => {
      if (sql.includes("INSERT INTO wallet_transfers")) {
        const conflict = transfers.find(
          (row) => row.adminId === params[0] && row.idempotencyKey === params[3],
        );
        if (conflict) return [];
        const row = {
          id: `tr-${transfers.length + 1}`,
          adminId: params[0],
          direction: params[1],
          amount: params[2],
          idempotencyKey: params[3],
          transactionId: null as string | null,
        };
        transfers.push(row);
        return [{ id: row.id, amount: row.amount, transactionId: null }];
      }
      if (sql.includes("FROM wallet_transfers") && sql.includes("SELECT")) {
        const row = transfers.find(
          (item) =>
            item.adminId === params[0] && item.idempotencyKey === params[1],
        );
        return row ? [row] : [];
      }
      if (sql.includes("UPDATE wallets") && sql.includes("currentBalance")) {
        const amount = Number(params[0]);
        const toAi = sql.includes('"currentBalance" = "currentBalance" -');
        if (toAi) {
          if (Number(wallet.currentBalance) < amount) return [];
          wallet.currentBalance = Number(wallet.currentBalance) - amount;
          wallet.aiBalance = Number(wallet.aiBalance) + amount;
        } else {
          if (Number(wallet.aiBalance) < amount) return [];
          wallet.aiBalance = Number(wallet.aiBalance) - amount;
          wallet.currentBalance = Number(wallet.currentBalance) + amount;
        }
        return [{ ...wallet }];
      }
      if (sql.includes("DELETE FROM wallet_transfers")) {
        const index = transfers.findIndex((row) => row.id === params[0]);
        if (index >= 0) transfers.splice(index, 1);
        return [];
      }
      if (sql.includes("UPDATE wallet_transfers SET")) {
        const row = transfers.find((item) => item.id === params[1]);
        if (row) row.transactionId = params[0];
        return [];
      }
      return [];
    },
  };

  const walletService = {
    getOrCreateWallet: async () => ({ ...wallet }),
    recordTransaction: async (
      _manager: unknown,
      input: { purpose: string },
    ) => {
      const saved = {
        id: `tx-${transactions.length + 1}`,
        purpose: input.purpose,
      };
      transactions.push(saved);
      return saved;
    },
  };

  const run = (direction: typeof WALLET_TRANSFER_TO_AI | typeof WALLET_TRANSFER_TO_WALLET, amount: number, key: string) =>
    executeWalletTransfer(manager as any, {
      userId: USER,
      amountStr: parseTransferAmount(amount, (k) => k),
      idempotencyKey: key,
      direction,
      walletService: walletService as any,
      translateNote: async (key) => key,
    });

  return { run, wallet, transfers, transactions };
}

describe("wallet transfers", () => {
  test("move to AI writes one SUCCESS transaction", async () => {
    const { run, wallet, transfers, transactions } = createTransferHarness();
    const result = await run(WALLET_TRANSFER_TO_AI, 2, "key-1");
    expect(result.replay).toBe(false);
    expect(result.transactionId).toBeTruthy();
    expect(Number(wallet.currentBalance)).toBe(8);
    expect(Number(wallet.aiBalance)).toBe(7);
    expect(transfers).toHaveLength(1);
    expect(transfers[0].transactionId).toBe(result.transactionId);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].purpose).toBe(PURPOSE_WALLET_TO_AI);
  });

  test("replay with the same key does not insert another transaction", async () => {
    const { run, transactions, wallet } = createTransferHarness();
    const first = await run(WALLET_TRANSFER_TO_AI, 2, "key-1");
    const second = await run(WALLET_TRANSFER_TO_AI, 2, "key-1");
    expect(second.replay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(transactions).toHaveLength(1);
    expect(Number(wallet.currentBalance)).toBe(8);
  });

  test("same key with a different amount is 409", async () => {
    const { run, transactions } = createTransferHarness();
    await run(WALLET_TRANSFER_TO_AI, 2, "key-1");
    await expect(run(WALLET_TRANSFER_TO_AI, 3, "key-1")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(transactions).toHaveLength(1);
  });

  test("overdraft does not leave a transfer or transaction row", async () => {
    const { run, transfers, transactions } = createTransferHarness({
      currentBalance: 1,
      aiBalance: 0,
    });
    await expect(
      run(WALLET_TRANSFER_TO_AI, 5, "key-over"),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(transfers).toHaveLength(0);
    expect(transactions).toHaveLength(0);
  });

  test("move back to main wallet records ai_to_wallet", async () => {
    const { run, wallet, transactions } = createTransferHarness();
    const result = await run(WALLET_TRANSFER_TO_WALLET, 3, "key-back");
    expect(result.replay).toBe(false);
    expect(Number(wallet.currentBalance)).toBe(13);
    expect(Number(wallet.aiBalance)).toBe(2);
    expect(transactions[0].purpose).toBe(PURPOSE_AI_TO_WALLET);
  });
});
