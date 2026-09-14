import { beforeEach, describe, expect, test, vi } from "vitest";
import { evaluateCondition } from "./automation-helpers";

vi.mock("src/stores/storesIntegrations/BaseStoreProvider", () => ({
  BaseStoreProvider: class BaseStoreProvider {},
  WebhookOrderPayload: {},
}));

void evaluateCondition;
describe("evaluateCondition", () => {
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    warn = vi.fn();
  });

  function logger() {
    return { warn } as never;
  }

  test("matches equal strings", () => {
    expect(evaluateCondition("s-1", "==", "s-1")).toBe(true);
  });

  test("trims whitespace before comparing", () => {
    expect(evaluateCondition("  s-1  ", "==", "s-1")).toBe(true);
  });

  test("compares numbers as strings", () => {
    expect(evaluateCondition(3, "==", "3")).toBe(true);
  });

  test("compares booleans", () => {
    expect(evaluateCondition(true, "==", true)).toBe(true);
  });

  test("treats null actual as empty string", () => {
    expect(evaluateCondition(null, "==", "")).toBe(true);
  });

  test("treats undefined actual as empty string", () => {
    expect(evaluateCondition(undefined, "!=", "x")).toBe(true);
  });

  //null != x
  test("teasts null acual as empty string", () => {
    expect(evaluateCondition(null, "!=", "x")).toBe(true);
  });

  test("detects differences", () => {
    expect(evaluateCondition("s-1", "!=", "s-2")).toBe(true);
  });

  test("compares greater than", () => {
    expect(evaluateCondition(3, ">", 2)).toBe(true);
  });

  test("compares less than", () => {
    expect(evaluateCondition(2, "<", 3)).toBe(true);
  });

  test("compares greater-or-equal at boundary", () => {
    expect(evaluateCondition(2, ">=", 2)).toBe(true);
  });

  test("compares less-or-equal at boundary", () => {
    expect(evaluateCondition(2, "<=", 2)).toBe(true);
  });

  test("rejects non-numeric operands", () => {
    expect(evaluateCondition("x", ">", 2)).toBe(false);
  });

  test("matches substrings case-insensitively", () => {
    expect(evaluateCondition("Cairo City", "contains", "cairo")).toBe(true);
  });

  test("negates substring matches", () => {
    expect(evaluateCondition("Cairo", "not_contains", "giza")).toBe(true);
  });

  test("matches prefixes case-insensitively", () => {
    expect(evaluateCondition("Cairo", "starts_with", "CAI")).toBe(true);
  });

  test("warns and returns false for unknown operator", () => {
    expect(evaluateCondition("a", "??", "a", logger())).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("returns false silently without logger", () => {
    expect(evaluateCondition("a", "??", "a")).toBe(false);
  });
});
