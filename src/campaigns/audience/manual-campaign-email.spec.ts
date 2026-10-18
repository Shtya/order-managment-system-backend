import { describe, it, expect, vi } from "vitest";
vi.mock("common/translation.service", () => ({ TranslationService: class {} }));
vi.mock("entities/campaigns.entity", () => ({
  CampaignAudienceType: { MANUAL: "manual" },
}));
import { ManualCampaignAudience } from "./manual-campaign.audience";

describe("manual campaign destinations", () => {
  const audience = new ManualCampaignAudience({ t: (s: string) => s } as any);
  it("accepts email-only recipients and deduplicates by email rather than phone", () => {
    const rows = audience.buildSnapshot(
      [
        { email: "Mona@example.com" },
        { email: "mona@example.com" },
        { email: "omar@example.com" },
      ],
      "email",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      email: "mona@example.com",
      phoneNumber: null,
    });
  });
  it("keeps WhatsApp phone validation", () => {
    expect(() =>
      audience.buildSnapshot([{ email: "mona@example.com" }]),
    ).toThrow();
    expect(
      audience.buildSnapshot([{ phoneNumber: "01001234567" }]),
    ).toHaveLength(1);
  });
});
