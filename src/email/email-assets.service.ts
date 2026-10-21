import { BadRequestException, Inject, Injectable, Optional } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In, EntityManager } from "typeorm";
import { EmailAssetEntity } from "entities/email-asset.entity";
import { TranslationService } from "common/translation.service";
import sharp from "sharp";
import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import type { OrphanFilesService } from "src/orphan-files/orphan-files.service";
import { execFile } from "child_process";
import { promisify } from "util";
import ffprobePath from "ffprobe-static";
import ffmpegPath from "ffmpeg-static";

const execFileAsync = promisify(execFile);
type MediaKind = "image" | "video" | "document";

@Injectable()
export class EmailAssetsService {
  private active = 0;
  constructor(
    @InjectRepository(EmailAssetEntity)
    private readonly assets: Repository<EmailAssetEntity>,
    private readonly translations: TranslationService,
    @Optional() @Inject("EMAIL_ORPHAN_FILES") private readonly orphans?: OrphanFilesService,
  ) {}
  private fail() {
    throw new BadRequestException(
      this.translations.t("domains.email.invalid_image" as any),
    );
  }
  async upload(adminId: string, input: Express.Multer.File | Buffer, kind: MediaKind = "image") {
    if (!["image", "video", "document"].includes(kind)) this.fail();
    const file = Buffer.isBuffer(input)
      ? ({ buffer: input, originalname: "image", mimetype: "application/octet-stream", size: input.length } as Express.Multer.File)
      : input;
    const buffer = file?.buffer;
    const limits = {
      image: Number(process.env.EMAIL_MAX_IMAGE_BYTES || 5 * 1024 * 1024),
      video: Number(process.env.EMAIL_MAX_VIDEO_BYTES || 50 * 1024 * 1024),
      document: Number(process.env.EMAIL_MAX_DOCUMENT_BYTES || 10 * 1024 * 1024),
    };
    if (!buffer?.length || buffer.length > limits[kind] || this.active >= 2)
      this.fail();
    if (kind !== "image") return this.uploadFile(adminId, file, kind);
    const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const png = buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const gif = /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString("ascii"));
    const webp = buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
    if (!jpeg && !png && !gif && !webp) this.fail();
    this.active++;
    const written: string[] = [];
    try {
      const meta = await sharp(buffer, {
        animated: true,
      }).metadata();
      const frames = meta.pages || 1,
        width = meta.width,
        height = meta.pageHeight || meta.height;
      if (
        !["jpeg", "png", "gif", "webp"].includes(meta.format) ||
        !width ||
        !height ||
        frames > 100
      )
        this.fail();
      const id = randomUUID(), orphanIds: string[] = [],
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
        })
          .rotate()
          .resize({ width: size, withoutEnlargement: true })
          .timeout({ seconds: 10 });
        pipeline = gif
          ? pipeline.gif()
          : png || webp
            ? pipeline.png({ compressionLevel: 9 })
            : pipeline.jpeg({ quality: 85, mozjpeg: true });
        const { data, info } = await pipeline.toBuffer({
          resolveWithObject: true,
        });
        const filename = `${id}-${size}.${gif ? "gif" : png || webp ? "png" : "jpg"}`;
        const path = join(root, filename);
        written.push(path);
        await writeFile(path, data, { flag: "wx" });
        const base = process.env.BACKEND_URL?.replace(/\/+$/, "");
        if (!base?.startsWith("https://")) this.fail();
        const url = `${base}/uploads/email/${filename}`;
        const orphan = await this.orphans?.create(adminId, url, new Date(Date.now() + 48 * 3600_000));
        if (orphan) orphanIds.push(orphan.id);
        variants.push({
          url,
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
          kind,
          originalName: file.originalname,
          mimeType: file.mimetype,
          bytes: buffer.length,
          format: meta.format,
          sourceWidth: rotatedWidth,
          sourceHeight: [5, 6, 7, 8].includes(meta.orientation)
            ? width
            : height,
          variants,
          orphanIds,
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
  private async uploadFile(adminId: string, file: Express.Multer.File, kind: Exclude<MediaKind, "image">) {
    const allowed = kind === "video"
      ? { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" }
      : { "application/pdf": "pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx", "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx", "text/csv": "csv", "text/plain": "txt" };
    const ext = allowed[file.mimetype];
    if (!ext) this.fail();
    if (kind === "document") {
      const head = file.buffer.subarray(0, 8);
      const zip = head.subarray(0, 2).toString("ascii") === "PK";
      const pdf = head.subarray(0, 5).toString("ascii") === "%PDF-";
      const text = !file.buffer.subarray(0, Math.min(file.buffer.length, 4096)).includes(0);
      if ((ext === "pdf" && !pdf) || (["docx", "xlsx", "pptx"].includes(ext) && !zip) || (["csv", "txt"].includes(ext) && !text)) this.fail();
    }
    const id = randomUUID();
    const root = join(process.cwd(), "uploads", "email");
    const filename = `${id}.${ext}`;
    const path = join(root, filename);
    await mkdir(root, { recursive: true });
    await writeFile(path, file.buffer, { flag: "wx" });
    const written = [path];
    try {
      const metadata: Record<string, any> = {};
      const variants: EmailAssetEntity["variants"] = [];
      const orphanIds: string[] = [];
      if (kind === "video") {
        const { stdout } = await execFileAsync(ffprobePath.path, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", path], { timeout: 15000, maxBuffer: 1024 * 1024 });
        const probe = JSON.parse(stdout);
        const video = probe.streams?.find((s) => s.codec_type === "video");
        const audio = probe.streams?.find((s) => s.codec_type === "audio");
        const codecs = { mp4: [["h264"], ["aac", undefined]], mov: [["h264"], ["aac", undefined]], webm: [["vp8", "vp9"], ["opus", "vorbis", undefined]] }[ext];
        if (!video || !codecs[0].includes(video.codec_name) || !codecs[1].includes(audio?.codec_name)) this.fail();
        Object.assign(metadata, { duration: Number(probe.format?.duration || 0), videoCodec: video.codec_name, audioCodec: audio?.codec_name, width: video.width, height: video.height });
        // A generated poster is a derivative of the video asset, so it follows
        // the same lease/promotion/deletion lifecycle as the source file.
        const thumbnailName = `${id}-thumbnail.jpg`;
        const thumbnailPath = join(root, thumbnailName);
        const ffmpegCandidates = [
          process.env.EMAIL_FFMPEG_PATH?.trim(),
          ffmpegPath,
          "ffmpeg",
        ].filter((candidate, index, rows) => candidate && rows.indexOf(candidate) === index) as string[];
        for (const executable of ffmpegCandidates) {
          try {
            const seek = Math.max(0, Math.min(1, Number(metadata.duration || 0) / 2));
            await execFileAsync(executable, [
              "-ss", seek.toFixed(3), "-i", path, "-frames:v", "1",
              "-vf", "scale=1200:675:force_original_aspect_ratio=increase,crop=1200:675",
              "-q:v", "3", "-y", thumbnailPath,
            ], { timeout: 20000, maxBuffer: 1024 * 1024 });
            written.push(thumbnailPath);
            const thumbnail = await readFile(thumbnailPath);
            variants.push({
              url: "", // populated after BACKEND_URL is validated below
              width: 1200,
              height: 675,
              bytes: thumbnail.length,
            });
            break;
          } catch {
            await unlink(thumbnailPath).catch(() => {});
          }
        }
        metadata.thumbnailGenerated = variants.length > 0;
      }
      const base = process.env.BACKEND_URL?.replace(/\/+$/, "");
      if (!base?.startsWith("https://")) this.fail();
      const url = `${base}/uploads/email/${filename}`;
      const orphan = await this.orphans?.create(adminId, url, new Date(Date.now() + 48 * 3600_000));
      if (orphan) orphanIds.push(orphan.id);
      if (variants.length) {
        variants[0].url = `${base}/uploads/email/${id}-thumbnail.jpg`;
        const thumbnailOrphan = await this.orphans?.create(adminId, variants[0].url, new Date(Date.now() + 48 * 3600_000));
        if (thumbnailOrphan) orphanIds.push(thumbnailOrphan.id);
      }
      return await this.assets.save(this.assets.create({ id, adminId, kind, originalName: file.originalname, mimeType: file.mimetype, format: ext, bytes: file.size || file.buffer.length, url, metadata, orphanIds, variants, leaseUntil: new Date(Date.now() + 48 * 3600_000) }));
    } catch (error) {
      await Promise.all(written.map((filePath) => unlink(filePath).catch(() => {})));
      if (error instanceof BadRequestException) throw error;
      this.fail();
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
      const orphanIds = rows.flatMap((row) => row.orphanIds || []);
      if (reason) await this.orphans?.promote(adminId, orphanIds, manager);
      else await this.orphans?.renew(adminId, orphanIds, new Date(Date.now() + Number(process.env.EMAIL_ASSET_LEASE_HOURS || 48) * 3600_000));
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
        for (const v of row.variants || []) {
          const name = new URL(v.url).pathname.split("/").pop();
          if (name?.startsWith(row.id + "-") && /^[a-z0-9.-]+$/i.test(name))
            await unlink(join(process.cwd(), "uploads", "email", name)).catch(
              () => {},
            );
        }
        if (row.url) {
          const name = new URL(row.url).pathname.split("/").pop();
          if (name?.startsWith(row.id) && /^[a-z0-9.-]+$/i.test(name))
            await unlink(join(process.cwd(), "uploads", "email", name)).catch(() => {});
        }
        await repo.delete(row.id);
      }
    });
  }
  async release(adminId: string, id: string) {
    const asset = await this.assets.findOne({ where: { adminId, id } });
    if (!asset) return { released: true };
    if (asset.saved || asset.queued || asset.permanent) return { released: false, inUse: true };
    asset.leaseUntil = new Date(Date.now() + 30 * 60_000);
    await this.assets.save(asset);
    await this.orphans?.renew(adminId, asset.orphanIds || [], asset.leaseUntil);
    return { released: true };
  }
}
