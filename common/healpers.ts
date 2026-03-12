
import { endOfDay, endOfMonth, startOfDay, startOfMonth, startOfWeek, startOfYear, subDays, subMonths } from 'date-fns';
import { PlanDuration } from 'entities/plans.entity';

import { unlink } from 'fs/promises';
import { join } from 'path';

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
        } catch (err) {
            // Log error but don't crash; the DB record is already gone
            console.error(`Cleanup failed for ${url}:`, err.message);
        }
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