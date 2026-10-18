vi.mock("common/translation.service", () => ({ TranslationService: class {} }));
const translations = { t: (key: string) => key } as any;
import { describe, it, expect, vi } from "vitest";
import { EmailAccountsService } from "./email-accounts.service";

describe("email account isolation", () => {
  it("always restricts account lookup to both tenant and connecting owner", async () => {
    const repo = { findOne: vi.fn().mockResolvedValue(null) };
    const service = new EmailAccountsService(repo as any, translations);
    await expect(
      service.get({ adminId: "tenant", actorId: "owner" }, "account"),
    ).rejects.toThrow();
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { id: "account", adminId: "tenant", ownerId: "owner" },
    });
  });
  it("never lets undefined context become an unscoped database lookup", async () => {
    const repo = { findOne: vi.fn() };
    await expect(
      new EmailAccountsService(repo as any, translations).get(
        { adminId: "tenant", actorId: undefined } as any,
        "account",
      ),
    ).rejects.toThrow();
    expect(repo.findOne).not.toHaveBeenCalled();
  });
});
