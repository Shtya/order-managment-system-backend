import { describe, expect, test } from "vitest";
import { rankHostedModelsByPriceCenter } from "./hosted-model-rank";

describe("rankHostedModelsByPriceCenter", () => {
  test("Auto picks the mid-priced model first, then closer remaining", () => {
    const cheap = { id: "c", inputTokenPrice: 0.1, outputTokenPrice: 0.1, sortOrder: 0 };
    const mid = { id: "m", inputTokenPrice: 1, outputTokenPrice: 1, sortOrder: 0 };
    const expensive = { id: "e", inputTokenPrice: 10, outputTokenPrice: 10, sortOrder: 0 };
    const ranked = rankHostedModelsByPriceCenter([cheap, expensive, mid]);
    expect(ranked.map((r) => r.id)).toEqual(["m", "c", "e"]);
  });

  test("pinned retry is not this helper — a single row stays alone", () => {
    const only = { id: "pinned", inputTokenPrice: 10, outputTokenPrice: 10, sortOrder: 0 };
    expect(rankHostedModelsByPriceCenter([only]).map((r) => r.id)).toEqual(["pinned"]);
  });
});
