import { ValueTransformer } from "typeorm";

/**
 * Postgres `bigint` comes back as a string. Billing money is micros (`bigint` in TS).
 */
export const bigintTransformer: ValueTransformer = {
  to(value?: bigint | number | string | null): string {
    if (value === null || value === undefined) return "0";
    return value.toString();
  },
  from(value?: string | number | bigint | null): bigint {
    if (value === null || value === undefined || value === "") return 0n;
    if (typeof value === "bigint") return value;
    return BigInt(value);
  },
};
