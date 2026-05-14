
import { endOfDay, endOfMonth, startOfDay, startOfMonth, startOfWeek, startOfYear, subDays, subMonths } from 'date-fns';
import { PlanDuration } from 'entities/plans.entity';
import { copyFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { extname, join } from 'path';
import { OrderStatus } from 'entities/order.entity';
import { randomBytes } from 'crypto';

export function calculateRange(range?: string): { start?: Date; end?: Date } {
    const now = new Date();
    switch (range) {
        case 'today':
            return { start: startOfDay(now), end: endOfDay(now) };
        case 'yesterday':
            const yesterday = subDays(now, 1);
            return { start: startOfDay(yesterday), end: endOfDay(yesterday) };
        case 'this_week':
            return { start: startOfWeek(now), end: endOfDay(now) };
        case 'last_week':
            const lastWeek = subDays(now, 7);
            return { start: startOfWeek(lastWeek), end: endOfDay(subDays(startOfWeek(now), 1)) };
        case 'this_month':
            return { start: startOfMonth(now), end: endOfDay(now) };
        case 'last_month':
            const lastMonth = subMonths(now, 1);
            return { start: startOfMonth(lastMonth), end: endOfDay(subDays(startOfMonth(now), 1)) };
        case 'this_year':
            return { start: startOfYear(now), end: endOfDay(now) };
        default:
            return {};
    }
}

export function imageSrc(url) {
    if (!url) return "";
    if (url.startsWith("http")) return url;
    const base = process.env.IMAGE_BASE_URL || "";
    return `${base.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`;
}



export async function deletePhysicalFiles(urls: string[]) {
    for (const url of urls) {
        try {
            const filePath = join(process.cwd(), url);
            await unlink(filePath);
        } catch (err: any) {
            // Log error but don't crash; the DB record is already gone
            console.error(`Cleanup failed for ${url}:`, err.message);
        }
    }
}

export function getErrorMessage(error: any): string {
    return error?.response?.data?.error?.message || error?.response?.data?.message || error?.response?.message || error?.message || 'Unknown error';
}

export async function copyPhysicalFile(url: string, prefix: string = "copy"): Promise<string | null> {
    try {
        if (!url || url.startsWith("http")) return url;
        const sourcePath = join(process.cwd(), url);
        if (!existsSync(sourcePath)) return null;

        const dir = url.substring(0, url.lastIndexOf('/'));
        const ext = extname(url);
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const newFilename = `${prefix}-${uniqueSuffix}${ext}`;
        const newUrl = `${dir}/${newFilename}`;
        const destPath = join(process.cwd(), newUrl);

        await copyFile(sourcePath, destPath);
        return newUrl;
    } catch (err: any) {
        console.error(`File copy failed for ${url}:`, err.message);
        return null;
    }
}

export const defaultCurrency = process.env.DEFAULT_CURRENCY || 'EGP'


export class SubscriptionUtils {
    private static readonly MONTH_IN_DAYS = 30;

    /**
     * Calculates the expiration date based on plan duration.
     * @param startDate The date the subscription starts (usually 'now')
     * @param duration The PlanDuration enum
     * @param customDays Optional days for CUSTOM/TRIAL plans
     */
    static calculateEndDate(startDate: Date, duration: PlanDuration, customDays?: number | null): Date | null {
        const endDate = new Date(startDate);

        switch (duration) {
            case PlanDuration.MONTHLY:
                endDate.setDate(endDate.getDate() + this.MONTH_IN_DAYS);
                return endDate;

            case PlanDuration.YEARLY:
                endDate.setFullYear(endDate.getFullYear() + 1);
                return endDate;

            case PlanDuration.CUSTOM:
                if (customDays) {
                    endDate.setDate(endDate.getDate() + customDays);
                    return endDate;
                }
                return null;

            case PlanDuration.LIFETIME:
                return null;

            default:
                return null;
        }
    }
}

export function parseNumber(val: any): number | null | undefined {
    if (val === undefined) return undefined;
    if (val === null || val === "") return null;
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
}

export
    function parseJsonField<T>(val: any, fallback: T): T {
    if (val === undefined || val === null || val === "") return fallback;
    if (typeof val !== "string") return val as T;
    try {
        return JSON.parse(val) as T;
    } catch {
        return fallback;
    }
}


export async function deleteFile(filePath: string) {
    try {

        const fullPath = join(process.cwd(), filePath.startsWith('/') ? filePath.slice(1) : filePath);

        if (existsSync(fullPath)) {
            await unlink(fullPath);
        }
    } catch (err) {
        console.error(`Failed to delete file at ${filePath}:`, err);
    }
}

export function generateSlug(value: string): string {
    return value
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
}

export function generateRandomAlphanumeric(length: number): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // avoids confusing chars like O/0 and I/1
    const bytes = randomBytes(length);

    let result = "";
    for (let i = 0; i < length; i++) {
        result += chars[bytes[i] % chars.length];
    }

    return result;
}

export function normalizeSku(sku: string) {
    return sku
        .normalize("NFKD")
        .replace(/[^a-zA-Z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .toUpperCase();
}



export const STATUS_TRANSITIONS = {
    [OrderStatus.NEW]: [
        OrderStatus.UNDER_REVIEW,
        OrderStatus.CONFIRMED,
        OrderStatus.NO_ANSWER,
        OrderStatus.WRONG_NUMBER,
        OrderStatus.OUT_OF_DELIVERY_AREA,
        OrderStatus.DUPLICATE,
        OrderStatus.CANCELLED,
    ],

    [OrderStatus.UNDER_REVIEW]: [
        OrderStatus.CONFIRMED,
        OrderStatus.NO_ANSWER,
        OrderStatus.WRONG_NUMBER,
        OrderStatus.OUT_OF_DELIVERY_AREA,
        OrderStatus.DUPLICATE,
        OrderStatus.CANCELLED,
        OrderStatus.REJECTED,
    ],

    [OrderStatus.CONFIRMED]: [
        OrderStatus.DISTRIBUTED,
        OrderStatus.SHIPPED, // ✅ direct shipping allowed
        OrderStatus.CANCELLED,
        OrderStatus.REJECTED,
    ],

    [OrderStatus.DISTRIBUTED]: [
        OrderStatus.PRINTED,
        OrderStatus.PREPARING, // optional shortcut
        OrderStatus.CANCELLED,
    ],

    [OrderStatus.PRINTED]: [
        OrderStatus.PREPARING,
        OrderStatus.CANCELLED,
        OrderStatus.REJECTED,
    ],

    [OrderStatus.PREPARING]: [
        OrderStatus.READY,
        OrderStatus.CANCELLED,
        OrderStatus.REJECTED,
    ],

    [OrderStatus.READY]: [
        OrderStatus.PACKED,
        OrderStatus.CANCELLED,
    ],

    [OrderStatus.PACKED]: [
        OrderStatus.SHIPPED,
        OrderStatus.CANCELLED,
    ],

    [OrderStatus.SHIPPED]: [
        OrderStatus.DELIVERED,
        OrderStatus.FAILED_DELIVERY,
    ],

    [OrderStatus.FAILED_DELIVERY]: [
        OrderStatus.DISTRIBUTED, // 🔁 reassign to shipping company
        OrderStatus.SHIPPED,     // 🔁 resend directly
        OrderStatus.RETURN_PREPARING,
    ],

    [OrderStatus.RETURN_PREPARING]: [
        OrderStatus.RETURNED,
    ],

    // ❌ TERMINAL STATES (no transitions)
    [OrderStatus.DELIVERED]: [],
    [OrderStatus.CANCELLED]: [],
    [OrderStatus.REJECTED]: [],
    [OrderStatus.RETURNED]: [],
};


export const GLOBAL_CUSTOM_ALLOWED = [
    OrderStatus.NO_ANSWER,
    OrderStatus.WRONG_NUMBER,
    OrderStatus.OUT_OF_DELIVERY_AREA,
    OrderStatus.DUPLICATE,
    OrderStatus.CANCELLED,
    OrderStatus.REJECTED,
];

export function formatReferenceMeta(meta: Record<string, any> = {}) {
    if (!meta) return null;

    const keyMap: Record<string, string> = {
        orderNumber: "Order No",
        purchaseNumber: "Purchase No",
        purchaseReturnNumber: "Purchase Return No",
        trackingNumber: "Tracking No",
        shippingCompanyProvider: "Shipping Company",
        category: "Category",
        supplierName: "Supplier",
    };

    return Object.entries(meta)
        .filter(([_, value]) => value !== null && value !== undefined)
        .map(([key, value]) => {
            const label = keyMap[key] || key;
            return `${label}: ${value}`;
        })
        .join(" | ");
}