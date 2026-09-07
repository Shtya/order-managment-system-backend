import * as ExcelJS from "exceljs";
import { promises as fs } from "fs";
import { randomInt } from "crypto";
import { join, normalize, extname, sep, basename } from "path";
import { normalizeEgyptianPhoneNumber } from "common/whatsapp";
import { BadRequestException } from "@nestjs/common";
export const CAMPAIGN_AUDIENCE_UPLOAD_DIR = "./uploads/campaign-audiences";
export const CAMPAIGN_AUDIENCE_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const CAMPAIGN_AUDIENCE_FILE_MAX_MB = 5;
export const CAMPAIGN_AUDIENCE_FILE_MAX_ROWS = 50000;

const PHONE_HEADERS = new Set(
  [
    "phonenumber",
    "phone",
    "mobile",
    "mobilenumber",
    "msisdn",
    "رقمالهاتف",
    "هاتف",
    "موبايل",
  ].map(normalizeHeader),
);

const NAME_HEADERS = new Set(
  ["name", "customername", "fullname", "الاسم", "اسمالعميل", "اسم"].map(
    normalizeHeader,
  ),
);

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\s_]+/g, "");
}

export type AudienceFileRow = {
  phoneNumber: string;
  name?: string | null;
};

export type AudienceFileParseResult = {
  rows: AudienceFileRow[];
  validCount: number;
  invalidCount: number;
};

export function isLocalUploadsUrl(url?: string | null): boolean {
  return !!url && (url.startsWith("/uploads/") || url.startsWith("uploads/"));
}

// Resolves a stored /uploads/... url to an absolute disk path.
// Returns null for non-local urls or paths escaping the uploads dir.
export function resolveUploadsDiskPath(url: string): string | null {
  if (!isLocalUploadsUrl(url)) return null;
  const relative = url.replace(/^\/+/, "");
  const absolute = normalize(join(process.cwd(), relative));
  const uploadsRoot = normalize(join(process.cwd(), "uploads"));
  if (absolute !== uploadsRoot && !absolute.startsWith(uploadsRoot + sep)) {
    return null;
  }
  return absolute;
}

export async function deleteLocalUploadsFile(
  url?: string | null,
): Promise<void> {
  if (!url) return;
  const diskPath = resolveUploadsDiskPath(url);
  if (!diskPath) return;
  try {
    await fs.unlink(diskPath);
  } catch {
    // Best-effort cleanup: missing/already-deleted files are not errors.
  }
}

// Copies a stored audience file to a fresh unique path so a duplicated
// campaign owns its own file. Returns null when the source is not a
// local upload or no longer exists on disk.
export async function duplicateAudienceFile(sourceUrl?: string | null): Promise<string | null> {
  const sourcePath = sourceUrl ? resolveUploadsDiskPath(sourceUrl) : null;
  if (!sourcePath) return null;
  try {
    await fs.access(sourcePath);
  } catch {
    return null;
  }
  await fs.mkdir(CAMPAIGN_AUDIENCE_UPLOAD_DIR, { recursive: true });
  const uniqueSuffix = Date.now() + "-" + randomInt(1e9);
  const fileName = `audience-${uniqueSuffix}${extname(basename(sourcePath)).toLowerCase() || ".xlsx"}`;
  const targetPath = join(CAMPAIGN_AUDIENCE_UPLOAD_DIR, fileName);
  await fs.copyFile(sourcePath, targetPath);
  return `/uploads/campaign-audiences/${fileName}`;
}

export function buildAudienceFileTemplate(): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Audience");
  sheet.columns = [
    { header: "phoneNumber", key: "phoneNumber", width: 22 },
    { header: "name", key: "name", width: 30 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.addRow({ phoneNumber: "01001234567", name: "أحمد محمد" });
  sheet.addRow({ phoneNumber: "01112345678", name: "Sara Ali" });
  return workbook;
}

export async function parseAudienceFile(
  diskPath: string,
): Promise<AudienceFileParseResult> {
  const extension = extname(diskPath).toLowerCase();
  const workbook = new ExcelJS.Workbook();
  if (extension === ".csv") {
    await workbook.csv.readFile(diskPath);
  } else if (extension === ".xlsx" || extension === ".xls") {
    await workbook.xlsx.readFile(diskPath);
  } else {
    throw new BadRequestException("unsupported_format");
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new BadRequestException("invalid_format");

  const headerRow = sheet.getRow(1);
  let phoneIndex = -1;
  let nameIndex = -1;
  headerRow.eachCell((cell, colNumber) => {
    const key = normalizeHeader(cell.value);
    if (phoneIndex === -1 && PHONE_HEADERS.has(key)) phoneIndex = colNumber;
    if (nameIndex === -1 && NAME_HEADERS.has(key)) nameIndex = colNumber;
  });
  if (phoneIndex === -1) throw new BadRequestException("missing_phone_column");

  const rows: AudienceFileRow[] = [];
  let invalidCount = 0;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    if (rows.length + invalidCount >= CAMPAIGN_AUDIENCE_FILE_MAX_ROWS) {
      throw new BadRequestException("too_many_rows");
    }
    const phone = normalizeEgyptianPhoneNumber(
      String(row.getCell(phoneIndex).value ?? ""),
    );
    if (!phone) {
      invalidCount += 1;
      return;
    }
    const name =
      nameIndex === -1
        ? null
        : String(row.getCell(nameIndex).value ?? "").trim() || null;
    rows.push({ phoneNumber: phone, name });
  });

  return { rows, validCount: rows.length, invalidCount };
}
