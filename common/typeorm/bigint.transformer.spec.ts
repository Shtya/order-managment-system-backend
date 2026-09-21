import { describe, expect, test } from "vitest";
import { bigintTransformer } from "./bigint.transformer";

describe("bigintTransformer", () => {
  test("writes bigint as a decimal string", () => {
    expect(bigintTransformer.to(1100000000000n)).toBe("1100000000000");
    expect(bigintTransformer.to(0n)).toBe("0");
  });

  test("reads postgres string back to bigint", () => {
    expect(bigintTransformer.from("1100000000000")).toBe(1100000000000n);
    expect(bigintTransformer.from("0")).toBe(0n);
  });

  test("nullish values become 0n / '0'", () => {
    expect(bigintTransformer.from(null)).toBe(0n);
    expect(bigintTransformer.from(undefined)).toBe(0n);
    expect(bigintTransformer.to(null)).toBe("0");
  });

  test("huge values stay exact", () => {
    const n = 9999999999999999999n;
    expect(bigintTransformer.from(bigintTransformer.to(n))).toBe(n);
  });
});
