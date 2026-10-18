vi.mock("common/translation.service", () => ({ TranslationService: class {} }));
import { describe, it, expect, vi } from "vitest";
import { EmailSendingStatusService } from "./email-sending-status.service";
describe("sending status", () => {
  it("authorizes every read and rate limits polling", async () => {
    const accounts = {
      get: vi.fn(async () => ({ status: "connected", cooldownUntil: null })),
    };
    const service = new EmailSendingStatusService(
        accounts as any,
        { t: (key: string) => key } as any,
      ),
      ctx = { adminId: "tenant", actorId: "owner" };
    for (let i = 0; i < 12; i++)
      expect((await service.get(ctx, "account")).status).toBe("connected");
    expect(accounts.get).toHaveBeenCalledTimes(12);
    await expect(service.get(ctx, "account")).rejects.toMatchObject({
      status: 429,
    });
    await service.get({ ...ctx, actorId: "other-owner" }, "account");
    expect(accounts.get).toHaveBeenCalledTimes(14);
  });
});
