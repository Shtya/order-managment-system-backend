import * as ExcelJS from "exceljs";
import { mkdirSync } from "fs";
import { I18nKey } from "common/translation.service";

export const CLIENT_IMPORT_UPLOAD_DIR = "./uploads/client-imports";
export const CLIENT_IMPORT_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const CLIENT_IMPORT_TEMPLATE_FILENAME = "clients_bulk_template.xlsx";

export const CLIENT_IMPORT_COLUMNS = [
  "name",
  "email",
  "phoneNumbers",
  "notes",
  "totalOrders",
  "confirmedRate",
  "deliveredCount",
  "returnedCount",
  "cancelledCount",
  "totalSales",
  "deliveredRevenue",
] as const;

export const CLIENT_IMPORT_COLUMN_META: Record<
  (typeof CLIENT_IMPORT_COLUMNS)[number],
  { headerKey: I18nKey; width: number }
> = {
  name: { headerKey: "common.name", width: 25 },
  email: { headerKey: "common.email", width: 30 },
  phoneNumbers: { headerKey: "domains.customer.bulk_col_phone_numbers", width: 35 },
  notes: { headerKey: "common.notes", width: 35 },
  totalOrders: { headerKey: "domains.customer.bulk_col_total_orders", width: 16 },
  confirmedRate: { headerKey: "domains.customer.bulk_col_confirmed_rate", width: 18 },
  deliveredCount: { headerKey: "domains.customer.bulk_col_delivered_count", width: 18 },
  returnedCount: { headerKey: "domains.customer.bulk_col_returned_count", width: 18 },
  cancelledCount: { headerKey: "domains.customer.bulk_col_cancelled_count", width: 18 },
  totalSales: { headerKey: "domains.customer.bulk_col_total_sales", width: 16 },
  deliveredRevenue: { headerKey: "domains.customer.bulk_col_delivered_revenue", width: 20 },
};

export type ClientImportRow = {
  rowNumber: number;
  name?: string;
  email?: string;
  notes?: string;
  phoneNumbersRaw: string;
  phoneNumbers: string[];
  totalOrders: number;
  confirmedRate: number;
  deliveredCount: number;
  returnedCount: number;
  cancelledCount: number;
  totalSales: number;
  deliveredRevenue: number;
  statErrors: Partial<Record<(typeof CLIENT_IMPORT_COLUMNS)[number], boolean>>;
};

export type ClientImportCellErrors = Map<number, Map<number, string[]>>;

export const CLIENT_IMPORT_BATCH_SIZE = 1000;

export function clientImportColumnIndex(
  key: (typeof CLIENT_IMPORT_COLUMNS)[number],
): number {
  return CLIENT_IMPORT_COLUMNS.indexOf(key) + 1;
}

function applyHeaderStyle(row: ExcelJS.Row) {
  row.font = { bold: true };
  row.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFEFEFEF" },
  };
  row.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFEFEFEF" },
    };
  });
}

export function ensureClientImportUploadDir() {
  mkdirSync(CLIENT_IMPORT_UPLOAD_DIR, { recursive: true });
}

export function buildClientImportTemplate(t: (key: I18nKey) => string) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Clients");
  sheet.columns = CLIENT_IMPORT_COLUMNS.map((key) => ({
    header: t(CLIENT_IMPORT_COLUMN_META[key].headerKey),
    key,
    width: CLIENT_IMPORT_COLUMN_META[key].width,
  }));

  const headerRow = sheet.getRow(1);
  applyHeaderStyle(headerRow);

  sheet.addRow({
    name: "Example Client",
    email: "client@example.com",
    phoneNumbers: "201000000000,201111111111",
    notes: "Imported from old system",
    totalOrders: 10,
    confirmedRate: 80,
    deliveredCount: 7,
    returnedCount: 1,
    cancelledCount: 1,
    totalSales: 15000,
    deliveredRevenue: 12000,
  });
  return workbook;
}

function cellString(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value === "object") {
    const cell = value as {
      text?: string;
      result?: unknown;
      richText?: { text?: string }[];
    };
    if (typeof cell.text === "string") return cell.text.trim();
    if (Array.isArray(cell.richText)) {
      return cell.richText.map((part) => part.text || "").join("").trim();
    }
    if (cell.result != null) return cellString(cell.result);
  }
  return String(value).trim();
}

function parseNumericCell(
  value: unknown,
  options?: { min?: number; max?: number },
): { value: number; valid: boolean } {
  const min = options?.min ?? 0;
  const max = options?.max;

  if (value == null || value === "") {
    return { value: 0, valid: true };
  }

  let raw: unknown = value;
  if (typeof value === "object") {
    const cell = value as { result?: unknown; text?: string };
    if (cell.result != null) raw = cell.result;
  }

  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < min || (max != null && raw > max)) {
      return { value: 0, valid: false };
    }
    return { value: raw, valid: true };
  }

  const text = cellString(raw).replace(/,/g, "").replace(/%$/, "").trim();
  if (text === "") {
    return { value: 0, valid: true };
  }
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    return { value: 0, valid: false };
  }

  const num = Number(text);
  if (!Number.isFinite(num) || num < min || (max != null && num > max)) {
    return { value: 0, valid: false };
  }
  return { value: num, valid: true };
}

function splitPhones(value: unknown): string[] {
  return cellString(value)
    .split(/[,;،]+/)
    .map((phone) => phone.trim())
    .filter(Boolean);
}

function isEmptyRow(values: unknown[]): boolean {
  return values.every((value) => cellString(value) === "");
}

function parseWorkbook(workbook: ExcelJS.Workbook): ClientImportRow[] {
  const sheet = workbook.getWorksheet("Clients") || workbook.worksheets[0];
  if (!sheet) {
    throw new Error("Spreadsheet has no worksheets");
  }

  const rows: ClientImportRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = CLIENT_IMPORT_COLUMNS.map(
      (_key, index) => row.getCell(index + 1).value,
    );
    if (isEmptyRow(values)) return;

    const totalOrders = parseNumericCell(values[4]);
    const confirmedRate = parseNumericCell(values[5], { min: 0, max: 100 });
    const deliveredCount = parseNumericCell(values[6]);
    const returnedCount = parseNumericCell(values[7]);
    const cancelledCount = parseNumericCell(values[8]);
    const totalSales = parseNumericCell(values[9]);
    const deliveredRevenue = parseNumericCell(values[10]);
    const phoneNumbersRaw = cellString(values[2]);

    rows.push({
      rowNumber,
      name: cellString(values[0]) || undefined,
      email: cellString(values[1]) || undefined,
      notes: cellString(values[3]) || undefined,
      phoneNumbersRaw,
      phoneNumbers: splitPhones(values[2]),
      totalOrders: totalOrders.value,
      confirmedRate: confirmedRate.value,
      deliveredCount: deliveredCount.value,
      returnedCount: returnedCount.value,
      cancelledCount: cancelledCount.value,
      totalSales: totalSales.value,
      deliveredRevenue: deliveredRevenue.value,
      statErrors: {
        totalOrders: !totalOrders.valid,
        confirmedRate: !confirmedRate.valid,
        deliveredCount: !deliveredCount.valid,
        returnedCount: !returnedCount.valid,
        cancelledCount: !cancelledCount.valid,
        totalSales: !totalSales.valid,
        deliveredRevenue: !deliveredRevenue.valid,
      },
    });
  });

  return rows;
}

export async function parseClientImportFile(
  filePath: string,
): Promise<ClientImportRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return parseWorkbook(workbook);
}

export async function parseClientImportBuffer(
  buffer: Buffer,
): Promise<ClientImportRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  return parseWorkbook(workbook);
}

export async function generateClientImportErrorReport(
  rows: ClientImportRow[],
  cellErrors: ClientImportCellErrors,
  t: (key: I18nKey) => string,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Clients");
  sheet.columns = CLIENT_IMPORT_COLUMNS.map((key) => ({
    header: t(CLIENT_IMPORT_COLUMN_META[key].headerKey),
    key,
    width: CLIENT_IMPORT_COLUMN_META[key].width,
  }));
  applyHeaderStyle(sheet.getRow(1));

  for (const row of rows) {
    const excelRow = sheet.addRow({
      name: row.name ?? "",
      email: row.email ?? "",
      phoneNumbers: row.phoneNumbersRaw,
      notes: row.notes ?? "",
      totalOrders: row.totalOrders,
      confirmedRate: row.confirmedRate,
      deliveredCount: row.deliveredCount,
      returnedCount: row.returnedCount,
      cancelledCount: row.cancelledCount,
      totalSales: row.totalSales,
      deliveredRevenue: row.deliveredRevenue,
    });

    const rowErrorMap = cellErrors.get(row.rowNumber);
    if (!rowErrorMap) continue;

    for (const [colNumber, messages] of rowErrorMap.entries()) {
      const cell = excelRow.getCell(colNumber);
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFFC7CE" },
      };
      cell.font = {
        color: { argb: "FF9C0006" },
      };
      cell.note = messages.join("\n");
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
