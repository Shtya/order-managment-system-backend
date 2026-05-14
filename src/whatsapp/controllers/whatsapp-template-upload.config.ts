import * as fs from "fs";
import { diskStorage } from "multer";
import { extname } from "path";
import { BadRequestException } from "@nestjs/common";

const UPLOAD_DIR = "./uploads/whatsapp-templates";

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

export const whatsappTemplateHeaderStorage = diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `wa-template-header-${uniqueSuffix}${extname(file.originalname).toLowerCase()}`);
  },
});

/** Allowed MIME types for WhatsApp template header media (IMAGE / VIDEO / DOCUMENT) */
export const whatsappTemplateHeaderMulterOptions = {
  storage: whatsappTemplateHeaderStorage,
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      /^image\/(jpeg|jpg|png)$/i.test(file.mimetype) ||
      file.mimetype === "video/mp4" ||
      file.mimetype === "application/pdf";
    if (!ok) {
      return cb(new BadRequestException("Invalid header media type"), false);
    }
    cb(null, true);
  },
};
