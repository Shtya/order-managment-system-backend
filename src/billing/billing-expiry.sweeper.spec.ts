import { describe, expect, test, vi } from "vitest";

vi.mock("./billing.service", () => ({
  BillingService: class BillingService {},
}));
vi.mock("src/wallet/wallet-hold.service", () => ({
  WalletHoldService: class WalletHoldService {},
}));

import { BillingExpirySweeper } from "./billing-expiry.sweeper";

describe("BillingExpirySweeper", () => {
  test("sweep expires in batches of 100 until a short batch", async () => {
    const billing = {
      expireDue: vi
        .fn()
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(3),
      reconcileHolds: vi.fn(),
    };
    const sweeper = new BillingExpirySweeper(billing as any);
    const total = await sweeper.sweep();
    expect(total).toBe(103);
    expect(billing.expireDue).toHaveBeenCalledTimes(2);
  });

  test("reconcile delegates to billing", async () => {
    const billing = {
      expireDue: vi.fn(),
      reconcileHolds: vi.fn().mockResolvedValue(2),
    };
    const sweeper = new BillingExpirySweeper(billing as any);
    await expect(sweeper.reconcile()).resolves.toBe(2);
  });
});
