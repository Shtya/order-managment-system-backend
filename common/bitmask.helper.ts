import { BadRequestException } from "@nestjs/common";
import { WeekDay } from "entities/assignment.entity";

export class BitmaskHelper {
    /**
     * Converts an array of enums to a bitmask number
     * Example: [ADD, EDIT] => 3
     */
    static fromArray<T extends number>(values?: T[]): number | null {
        if (!values || values.length === 0) return null;
        return values.reduce((mask, perm) => mask | perm, 0);
    }

    /**
     * Checks if a bitmask contains a value
     */
    static has(mask: number, value: number): boolean {
        return (mask & value) === value;
    }

    /**
     * Adds a value to a mask
     */
    static add(mask: number, value: number): number {
        return mask | value;
    }

    /**
     * Removes a value from a mask
     */
    static remove(mask: number, value: number): number {
        return mask & ~value;
    }
}

export class WeekDayHelper {
    static readonly ALL_DAYS =
        WeekDay.SUNDAY |
        WeekDay.MONDAY |
        WeekDay.TUESDAY |
        WeekDay.WEDNESDAY |
        WeekDay.THURSDAY |
        WeekDay.FRIDAY |
        WeekDay.SATURDAY;

    static isValid(mask?: number | null): boolean {
        if (mask == null) return true;

        return (
            Number.isInteger(mask) &&
            mask > 0 &&
            (mask & ~this.ALL_DAYS) === 0
        );
    }

    static getDays(mask: number): WeekDay[] {
        return Object.values(WeekDay).filter(
            day =>
                typeof day === "number" &&
                BitmaskHelper.has(mask, day as number),
        ) as WeekDay[];
    }

    static readonly WEEKDAY_BITS = [
        WeekDay.SUNDAY,
        WeekDay.MONDAY,
        WeekDay.TUESDAY,
        WeekDay.WEDNESDAY,
        WeekDay.THURSDAY,
        WeekDay.FRIDAY,
        WeekDay.SATURDAY,
    ];
    static validateWeekDaysInRange(
        weekDays: number,
        activeFrom: Date,
        activeUntil: Date,
    ): boolean {

        const start = new Date(activeFrom);
        const end = new Date(activeUntil);
        
        const totalDays =
            Math.floor(
                (end.getTime() - start.getTime()) /
                (24 * 60 * 60 * 1000),
            ) + 1;

        // range covers at least one full week
        if (totalDays >= 7) {
            return true;
        }

        const startDay = start.getDay();

        let availableMask = 0;

        for (let i = 0; i < totalDays; i++) {
            const dayIndex = (startDay + i) % 7;
            availableMask |= this.WEEKDAY_BITS[dayIndex];
        }

        const missingDays = weekDays & ~availableMask;

        if (missingDays !== 0) {
            return false;
        }

        return true;
    }
}