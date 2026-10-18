vi.mock("common/translation.service", () => ({ TranslationService: class {} }));
import { describe, it, expect, vi, afterEach } from "vitest";
import sharp from "sharp";
import { unlink, readFile } from "fs/promises";
import { join } from "path";
import { EmailAssetsService } from "./email-assets.service";
const translations = { t: (key: string) => key } as any;
describe("email image boundary", () => {
  afterEach(() => vi.unstubAllEnvs());
  const service = () =>
    new EmailAssetsService(
      { create: (value) => value, save: async (value) => value } as any,
      translations,
    );
  it("rejects SVG, WebP, AVIF, malformed data and oversized bytes", async () => {
    const asset = service();
    for (const data of [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      Buffer.from("RIFF....WEBP"),
      Buffer.from("....ftypavif"),
      Buffer.from([255, 216, 255]),
      Buffer.alloc(5 * 1024 * 1024 + 1),
    ])
      await expect(asset.upload("tenant", data)).rejects.toThrow(
        "domains.email.invalid_image",
      );
  });
  it("rejects oversized pixel dimensions before storing", async () => {
    const buffer = await sharp({
      create: { width: 6001, height: 1, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    await expect(service().upload("tenant", buffer)).rejects.toThrow(
      "domains.email.invalid_image",
    );
  });
  it("stores bounded 1x/2x variants without upscaling", async () => {
    vi.stubEnv("BACKEND_URL", "https://api.example.com");
    const buffer = await sharp({
      create: { width: 1200, height: 600, channels: 3, background: "white" },
    })
      .jpeg()
      .toBuffer();
    const result = await service().upload("tenant", buffer);
    try {
      expect(result.variants.map((v) => v.width)).toEqual([800, 1200]);
      expect(result.variants.every((v) => v.bytes <= 2 * 1024 * 1024)).toBe(
        true,
      );
      expect(result.leaseUntil.getTime()).toBeGreaterThan(
        Date.now() + 47 * 3600_000,
      );
    } finally {
      for (const v of result.variants)
        await unlink(
          join(
            process.cwd(),
            "uploads",
            "email",
            new URL(v.url).pathname.split("/").pop(),
          ),
        );
    }
  });
  it("preserves GIF animation and rejects excessive frames", async () => {
    vi.stubEnv("BACKEND_URL", "https://api.example.com");
    const animated = async (count: number) =>
      sharp(
        Buffer.concat(
          Array.from({ length: count }, (_, i) =>
            Buffer.from(
              Array.from({ length: 12 }, (_, j) => (i * 17 + j * 7) % 256),
            ),
          ),
        ),
        { raw: { width: 2, height: count * 2, channels: 3, pageHeight: 2 } },
      )
        .gif({ delay: Array(count).fill(100) })
        .toBuffer();
    const result = await service().upload("tenant", await animated(2));
    const path = join(
      process.cwd(),
      "uploads",
      "email",
      new URL(result.variants[0].url).pathname.split("/").pop(),
    );
    try {
      expect(
        (await sharp(await readFile(path), { animated: true }).metadata())
          .pages,
      ).toBe(2);
    } finally {
      await unlink(path);
    }
    await expect(
      service().upload("tenant", await animated(101)),
    ).rejects.toThrow("domains.email.invalid_image");
  });
});
