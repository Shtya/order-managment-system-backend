import { Between, MoreThanOrEqual, LessThanOrEqual, SelectQueryBuilder } from 'typeorm';

export class DateFilterUtil {
    /**
     * Core logic to safely parse strings into local start/end Date boundaries
     */
    static getBoundaries(startDate?: string | Date, endDate?: string | Date) {
        let start = startDate ? new Date(startDate) : null;
        let end = endDate ? new Date(endDate) : null;

        if (start) start.setHours(0, 0, 0, 0);
        if (end) end.setHours(23, 59, 59, 999);

        return { start, end };
    }

    /**
     * Use this for standard Repository .find() or .findOne() methods
     */
    static getFindOperator(startDate?: string | Date, endDate?: string | Date) {
        const { start, end } = this.getBoundaries(startDate, endDate);

        if (start && end) return Between(start, end);
        if (start) return MoreThanOrEqual(start);
        if (end) return LessThanOrEqual(end);

        return null;
    }

    /**
     * Use this to mutate a QueryBuilder instance directly.
     * Note: It dynamically names the parameters (e.g., :order_created_at_start) 
     * to prevent collisions if you filter multiple dates in the same query.
     */
    static applyToQueryBuilder<T>(
        qb: SelectQueryBuilder<T>,
        columnName: string,
        startDate?: string | Date,
        endDate?: string | Date,
    ): SelectQueryBuilder<T> {
        const { start, end } = this.getBoundaries(startDate, endDate);

        // Creates safe parameter names like "order_created_at_start"
        const safeParam = columnName.replace('.', '_');

        if (start && end) {
            qb.andWhere(`${columnName} BETWEEN :${safeParam}_start AND :${safeParam}_end`, {
                [`${safeParam}_start`]: start,
                [`${safeParam}_end`]: end,
            });
        } else if (start) {
            qb.andWhere(`${columnName} >= :${safeParam}_start`, {
                [`${safeParam}_start`]: start,
            });
        } else if (end) {
            qb.andWhere(`${columnName} <= :${safeParam}_end`, {
                [`${safeParam}_end`]: end,
            });
        }

        return qb;
    }
}