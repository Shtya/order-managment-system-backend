vi.mock("common/translation.service", () => ({ TranslationService: class {} }));
const translations = { t: (key: string) => key } as any;
import { describe, it, expect, vi } from "vitest";
import { EmailPolicyService } from "./email-policy.service";

describe("EmailPolicyService", () => {
  it("builds unsubscribe links from BACKEND_URL while preserving the API prefix", () => {
    vi.stubEnv("BACKEND_URL", "https://api.example.com/api///");
    vi.stubEnv("EMAIL_UNSUBSCRIBE_SECRET", "a".repeat(32));
    try {
      expect(
        new EmailPolicyService({} as any, translations).unsubscribeUrl(
          "tenant",
          "mona@example.com",
        ),
      ).toMatch(
        /^https:\/\/api\.example\.com\/api\/email\/unsubscribe\/[a-f0-9]{64}$/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("requires separate email consent and respects withdrawals for every sender", async () => {
    vi.stubEnv("NEED_MARKETING_CONSENT", "true");
    const repo = { findOneBy: vi.fn().mockResolvedValue(null) };
    const policy = new EmailPolicyService(repo as any, translations);
    expect(
      await policy.eligibility("tenant", "a@example.com", "marketing"),
    ).toBe("no_email_consent");
    repo.findOneBy.mockResolvedValue({ consented: true, suppressed: false });
    expect(
      await policy.eligibility("tenant", "a@example.com", "marketing"),
    ).toBeNull();
    repo.findOneBy.mockResolvedValue({ consented: false, suppressed: true });
    expect(
      await policy.eligibility("tenant", "a@example.com", "marketing"),
    ).toBe("unsubscribed");
    vi.unstubAllEnvs();
  });
  it("does not allow a consent import to overwrite an unsubscribe", async () => {
    const repo = {
      findOneBy: vi.fn().mockResolvedValue({ suppressed: true }),
      upsert: vi.fn(),
    };
    await expect(
      new EmailPolicyService(repo as any, translations).recordConsent(
        { adminId: "tenant", actorId: "actor" },
        "a@example.com",
        "CRM import",
      ),
    ).rejects.toThrow();
    expect(repo.upsert).not.toHaveBeenCalled();
  });
  it("hashes unsubscribe tokens and updates without exposing recipient data", async () => {
    const repo = { update: vi.fn().mockResolvedValue({ affected: 1 }) };
    const token = "a".repeat(64);
    await new EmailPolicyService(repo as any, translations).unsubscribe(token);
    expect(repo.update.mock.calls[0][0].unsubscribeHash).not.toBe(token);
    expect(repo.update.mock.calls[0][1]).toMatchObject({
      suppressed: true,
      consented: false,
    });
  });
});
