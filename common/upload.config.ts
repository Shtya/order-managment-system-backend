// src/common/upload.ts
import { diskStorage, MulterError } from 'multer';
import { extname, join } from 'path';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import type { Express } from 'express';
import { BadRequestException, Catch, ExceptionFilter, ArgumentsHost, ParseFilePipe, MaxFileSizeValidator, FileTypeValidator } from '@nestjs/common';

/* ===================== Config ===================== */
export const IMAGE_MAX_BYTES = +(process.env.UPLOAD_IMAGE_MAX_BYTES ?? 10 * 1024 * 1024); // 10MB
export const IMAGE_MIN_WIDTH = +(process.env.UPLOAD_IMAGE_MIN_W ?? 400);
export const IMAGE_MIN_HEIGHT = +(process.env.UPLOAD_IMAGE_MIN_H ?? 400);

export const UPLOADS_ROOT_ABS = join(process.cwd(), 'uploads');
export const IMAGES_DIR_ABS = join(UPLOADS_ROOT_ABS, 'images');
export const IMAGES_SERVE_ROOT = '/uploads/images';

export function toWebPathImages(filename: string) {
  return `${IMAGES_SERVE_ROOT}/${filename}`;
}
export function toAbsPathImages(filename: string) {
  return join(IMAGES_DIR_ABS, filename);
}
export const GENERIC_DIR_ABS = join(UPLOADS_ROOT_ABS, 'files');
export const GENERIC_SERVE_ROOT = '/uploads/files';

export function toWebPathFiles(filename: string) {
  return `${GENERIC_SERVE_ROOT}/${filename}`;
}
export function toAbsPathFiles(filename: string) {
  return join(GENERIC_DIR_ABS, filename);
}

/* ===================== Optional: per-route validator ===================== */
export function imageOptionalPipe(maxBytes = IMAGE_MAX_BYTES) {
  return new ParseFilePipe({
    validators: [
      new MaxFileSizeValidator({
        maxSize: maxBytes,
        message: `File too large. Max ${(maxBytes / (1024 * 1024)).toFixed(0)}MB.`,
      }),
      new FileTypeValidator({
        fileType: /^image\/(jpeg|png|webp|gif|jpg|svg\+xml)$/,
      }),
    ],
    fileIsRequired: false,
  });
}

/* ===================== Friendly Multer errors ===================== */
@Catch(MulterError) // <-- correct usage: catch Multer errors only
export class MulterExceptionFilter implements ExceptionFilter {
  catch(exception: MulterError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();

    let message = exception.message || 'Upload error.';
    if (exception.code === 'LIMIT_FILE_SIZE') {
      message = `File too large. Max ${(IMAGE_MAX_BYTES / (1024 * 1024)).toFixed(0)}MB.`;
    } else if (exception.code === 'LIMIT_UNEXPECTED_FILE') {
      message = 'Unexpected file field.';
    }

    res.status(400).json({ statusCode: 400, error: 'Bad Request', message });
  }
}

/* ===================== Optional: Sharp optimization ===================== */
// npm i sharp
export async function validateAndOptimizeImageIfPossible(absPath: string) {
  let sharpModule: typeof import('sharp') | undefined;
  try {
    sharpModule = (await import('sharp')).default;
  } catch {
    return; // Sharp not installed — skip optimization
  }

  const sharp = sharpModule;
  const ext = extname(absPath).toLowerCase();

  // Skip GIF and SVG (keep original files intact)
  if (ext === '.gif' || ext === '.svg') return;

  try {
    const img = sharp(absPath);
    const meta = await img.metadata();

    if (!meta.width || !meta.height || meta.width < IMAGE_MIN_WIDTH || meta.height < IMAGE_MIN_HEIGHT) {
      try {
        unlinkSync(absPath);
      } catch {}
      throw new BadRequestException(`Image too small. Minimum ${IMAGE_MIN_WIDTH}x${IMAGE_MIN_HEIGHT}px.`);
    }

    // Resize (no enlargement), and re-encode in the SAME format to keep extension/content-type consistent.
    const width = Math.min(meta.width, 1600);
    let pipeline = img.rotate().resize({ width, withoutEnlargement: true });

    if (ext === '.png') {
      await pipeline.png({ compressionLevel: 8 }).toFile(absPath);
    } else if (ext === '.jpg' || ext === '.jpeg') {
      await pipeline.jpeg({ quality: 82 }).toFile(absPath);
    } else if (ext === '.webp') {
      await pipeline.webp({ quality: 82 }).toFile(absPath);
    } else {
      // Fallback: just write back without format change
      await pipeline.toFile(absPath);
    }
  } catch (e) {
    if (e instanceof BadRequestException) throw e;
    try {
      unlinkSync(absPath);
    } catch {}
    throw new BadRequestException('Could not process the image. Please upload a valid image file.');
  }
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function randomName(base: string, original: string) {
  const name = base.replace(/\.[^/.]+$/, '');
  const extension = extname(original);
  const rand = Array(16)
    .fill(null)
    .map(() => Math.floor(Math.random() * 16).toString(16))
    .join('');
  return `${name}-${rand}${extension}`;
}

export const imageUploadOptions = {
  storage: diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = join(process.cwd(), 'uploads', 'images');
      ensureDir(uploadDir);
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => cb(null, randomName(file.originalname, file.originalname)),
  }),
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|jpg|gif|webp|svg\+xml)$/.test(file.mimetype)) return cb(null, true);
    cb(new Error('Unsupported image type'), false);
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
};

export const videoUploadOptions = {
  storage: diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = join(process.cwd(), 'uploads', 'videos');
      ensureDir(uploadDir);
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => cb(null, randomName(file.originalname, file.originalname)),
  }),
  fileFilter: (req, file, cb) => {
    if (/^video\/(mp4|quicktime|x-matroska|webm|x-msvideo)$/.test(file.mimetype)) return cb(null, true);
    cb(new Error('Unsupported video type'), false);
  },
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
};
export const genericUploadOptions = {
  storage: diskStorage({
    destination: (req, file, cb) => {
      ensureDir(GENERIC_DIR_ABS);
      cb(null, GENERIC_DIR_ABS);
    },
    filename: (req, file, cb) => cb(null, randomName(file.originalname, file.originalname)),
  }),
  fileFilter: (req: Express.Request, file: Express.Multer.File, cb: Function) => {
    // Accept images, PDF, and Word documents
    const allowedTypes = [
      /^image\/(jpeg|png|jpg|gif|webp|svg\+xml)$/, // images
      /^application\/pdf$/,                         // PDF
      /^application\/msword$/,                      // .doc
      /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/, // .docx
    ];

    if (allowedTypes.some((regex) => regex.test(file.mimetype))) return cb(null, true);
    cb(new Error('Unsupported file type'), false);
  },
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
};