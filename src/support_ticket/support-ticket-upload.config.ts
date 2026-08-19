import { BadRequestException, NotFoundException } from "@nestjs/common";
import { diskStorage } from "multer";
import { extname, join } from "path";
import { createReadStream, existsSync, mkdirSync, ReadStream } from "fs";

export const SUPPORT_TICKET_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",

  "video/mp4",
  "video/webm",
  "video/quicktime",

  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",

  "text/plain",
  "text/csv",
];

const SUPPORT_TICKET_UPLOAD_DIR = "./uploads/support-tickets";

export const supportTicketFilesOptions = {
  storage: diskStorage({
    destination: (_req, _file, cb) => {
      if (!existsSync(SUPPORT_TICKET_UPLOAD_DIR)) {
        mkdirSync(SUPPORT_TICKET_UPLOAD_DIR, { recursive: true });
      }
      cb(null, SUPPORT_TICKET_UPLOAD_DIR);
    },
    filename: (_req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, `attachment-${uniqueSuffix}${extname(file.originalname)}`);
    },
  }),
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    if (!SUPPORT_TICKET_ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return cb(new BadRequestException("Unsupported file type"), false);
    }
    cb(null, true);
  },
};

export function streamAttachmentFile(
  res: any,
  attachment: {
    url: string;
    mimeType?: string | null;
    originalName?: string | null;
  },
  mode: "inline" | "attachment" = "attachment",
): Promise<void> {
  const relative = attachment.url.replace(/^\/uploads\//, "uploads/");
  const filePath = join(process.cwd(), relative);

  if (!existsSync(filePath)) {
    throw new NotFoundException("Attachment file not found");
  }

  const safeName = (attachment.originalName || "attachment").replace(
    /["\\]/g,
    "",
  );

  // Explicit 200 prevents race-induced 204 when async handler resolves
  // before the stream finishes piping.
  res.status(200);
  res.setHeader(
    "Content-Type",
    attachment.mimeType || "application/octet-stream",
  );

  if (mode === "attachment") {
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  } else {
    res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
  }

  return new Promise<void>((resolve, reject) => {
    const stream: ReadStream = createReadStream(filePath);
    stream.on("error", (err) => {
      stream.destroy();
      reject(err);
    });
    res.on("finish", () => resolve());
    res.on("close", () => resolve());
    stream.pipe(res);
  });
}
