import { describe, expect, test } from "vitest";
import { dollarNumericToMicros, microsToDollarNumeric } from "./micros";

describe("micros money conversion", () => {
  test("1 dollar is 1_000_000 micros", () => {
    expect(microsToDollarNumeric(1_000_000n)).toBe("1.000000");
    expect(dollarNumericToMicros("1.00")).toBe(1_000_000n);
  });

  test("1 micro survives the round trip", () => {
    expect(dollarNumericToMicros(microsToDollarNumeric(1n))).toBe(1n);
    expect(microsToDollarNumeric(1n)).toBe("0.000001");
  });

  test("sub-cent wallet amounts stay exact", () => {
    expect(dollarNumericToMicros("10.500001")).toBe(10_500_001n);
    expect(microsToDollarNumeric(10_500_001n)).toBe("10.500001");
  });
});
