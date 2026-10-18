import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In, EntityManager } from "typeorm";
import { EmailAssetEntity } from "entities/email-asset.entity";
import { TranslationService } from "common/translation.service";
import sharp from "sharp";
import { mkdir, writeFile, unlink } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

@Injectable()
export class EmailAssetsService {
  private active = 0;
  constructor(
    @InjectRepository(EmailAssetEntity)
    private readonly assets: Repository<EmailAssetEntity>,
    private readonly translations: TranslationService,
  ) {}
  private fail() {
    throw new BadRequestException(
      this.translations.t("domains.email.invalid_image" as any),
    );
  }
  async upload(adminId: string, buffer: Buffer) {
    if (!buffer?.length || buffer.length > 5 * 1024 * 1024 || this.active >= 2)
      this.fail();
    const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const png = buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const gif = /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString("ascii"));
    if (!jpeg && !png && !gif) this.fail();
    this.active++;
    const written: string[] = [];
    try {
      const meta = await sharp(buffer, {
        animated: true,
        limitInputPixels: 40_000_000,
      }).metadata();
      const frames = meta.pages || 1,
        width = meta.width,
        height = meta.pageHeight || meta.height;
      if (
        !["jpeg", "png", "gif"].includes(meta.format) ||
        !width ||
        !height ||
        width > 6000 ||
        height > 6000 ||
        frames > 100 ||
        width * height * frames > (frames === 1 ? 20_000_000 : 40_000_000)
      )
        this.fail();
      const id = randomUUID(),
        variants: EmailAssetEntity["variants"] = [];
      const root = join(process.cwd(), "uploads", "email");
      await mkdir(root, { recursive: true });
      const rotatedWidth = [5, 6, 7, 8].includes(meta.orientation)
        ? height
        : width;
      const sizes = gif
        ? [Math.min(width, 1600)]
        : [
            ...new Set([
              Math.min(rotatedWidth, 800),
              Math.min(rotatedWidth, 1600),
            ]),
          ];
      for (const size of sizes) {
        let pipeline = sharp(buffer, {
          animated: gif,
          limitInputPixels: 40_000_000,
        })
          .rotate()
          .resize({ width: size, withoutEnlargement: true })
          .timeout({ seconds: 10 });
        pipeline = gif
          ? pipeline.gif()
          : png
            ? pipeline.png({ compressionLevel: 9 })
            : pipeline.jpeg({ quality: 85, mozjpeg: true });
        const { data, info } = await pipeline.toBuffer({
          resolveWithObject: true,
        });
        if (data.length > 2 * 1024 * 1024) this.fail();
        const filename = `${id}-${size}.${gif ? "gif" : png ? "png" : "jpg"}`;
        const path = join(root, filename);
        written.push(path);
        await writeFile(path, data, { flag: "wx" });
        const base = process.env.BACKEND_URL?.replace(/\/+$/, "");
        if (!base?.startsWith("https://")) this.fail();
        variants.push({
          url: `${base}/uploads/email/${filename}`,
          width: info.width,
          height: gif
            ? (await sharp(data, { animated: true }).metadata()).pageHeight ||
              info.height
            : info.height,
          bytes: data.length,
        });
      }
      return await this.assets.save(
        this.assets.create({
          id,
          adminId,
          format: meta.format,
          sourceWidth: rotatedWidth,
          sourceHeight: [5, 6, 7, 8].includes(meta.orientation)
            ? width
            : height,
          variants,
          leaseUntil: new Date(Date.now() + 48 * 3600_000),
        }),
      );
    } catch (error) {
      await Promise.all(written.map((path) => unlink(path).catch(() => {})));
      if (error instanceof BadRequestException) throw error;
      this.fail();
    } finally {
      this.active--;
    }
  }
  async getMany(adminId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    if (
      unique.length > 300 ||
      unique.some(
        (id) =>
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            id || "",
          ),
      )
    )
      this.fail();
    const rows = await this.assets.find({ where: { adminId, id: In(unique) } });
    if (
      rows.length !== unique.length ||
      rows.some(
        (a) =>
          !a.saved &&
          !a.queued &&
          !a.permanent &&
          a.leaseUntil.getTime() <= Date.now(),
      )
    )
      this.fail();
    return rows;
  }
  async retain(
    adminId: string,
    ids: string[],
    reason?: "saved" | "queued" | "permanent",
    transaction?: EntityManager,
  ) {
    const retain = async (manager: EntityManager) => {
      const unique = [...new Set(ids)];
      if (
        unique.length > 300 ||
        unique.some(
          (id) =>
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              id || "",
            ),
        )
      )
        this.fail();
      const repo = manager.getRepository(EmailAssetEntity);
      const rows = await repo
        .createQueryBuilder("a")
        .setLock("pessimistic_write")
        .where('a."adminId" = :adminId AND a.id IN (:...ids)', {
          adminId,
          ids: unique,
        })
        .getMany();
      if (
        rows.length !== unique.length ||
        rows.some(
          (a) =>
            !a.saved &&
            !a.queued &&
            !a.permanent &&
            a.leaseUntil.getTime() <= Date.now(),
        )
      )
        this.fail();
      await repo.update(
        { adminId, id: In(unique) },
        {
          leaseUntil: new Date(Date.now() + 48 * 3600_000),
          ...(reason ? { [reason]: true } : {}),
        },
      );
    };
    if (ids.length) {
      if (transaction) await retain(transaction);
      else await this.assets.manager.transaction(retain);
    }
    return {
      renewed: true,
      ...(!transaction ? { assets: await this.getMany(adminId, ids) } : {}),
    };
  }
  async cleanup() {
    // Lock each candidate: renewal/pinning cannot race with deletion.
    await this.assets.manager.transaction(async (manager) => {
      const repo = manager.getRepository(EmailAssetEntity);
      const rows = await repo
        .createQueryBuilder("a")
        .setLock("pessimistic_write")
        .setOnLocked("skip_locked")
        .where(
          'a."leaseUntil" < NOW() AND NOT a.saved AND NOT a.queued AND NOT a.permanent',
        )
        .take(100)
        .getMany();
      for (const row of rows) {
        for (const v of row.variants) {
          const name = new URL(v.url).pathname.split("/").pop();
          if (name?.startsWith(row.id + "-") && /^[a-z0-9.-]+$/i.test(name))
            await unlink(join(process.cwd(), "uploads", "email", name)).catch(
              () => {},
            );
        }
        await repo.delete(row.id);
      }
    });
  }
}
