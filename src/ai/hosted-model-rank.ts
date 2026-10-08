export type RankableHostedModel = {
  id: string;
  inputTokenPrice: number | string;
  outputTokenPrice: number | string;
  sortOrder?: number | null;
};

export function hostedPriceScore(row: RankableHostedModel): number {
  return (Number(row.inputTokenPrice) + Number(row.outputTokenPrice)) / 2;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Auto order: closest to the median price, then cheaper, then sortOrder. */
export function rankHostedModelsByPriceCenter<T extends RankableHostedModel>(
  rows: T[],
): T[] {
  if (rows.length <= 1) return [...rows];
  const center = median(rows.map(hostedPriceScore));
  return [...rows].sort((a, b) => {
    const scoreA = hostedPriceScore(a);
    const scoreB = hostedPriceScore(b);
    const dist = Math.abs(scoreA - center) - Math.abs(scoreB - center);
    if (dist !== 0) return dist;
    if (scoreA !== scoreB) return scoreA - scoreB;
    return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id);
  });
}
