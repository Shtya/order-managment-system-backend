export function getEffectiveDeductedQuantity(item: {
  quantity?: number;
  stockDeducted?: boolean;
  stockDeductedQuantity?: number;
}) {
  const qty = item.quantity || 0;
  const deductedQty = item.stockDeductedQuantity || 0;

  if (deductedQty > 0) return deductedQty;
  if (item.stockDeducted) return qty;
  return 0;
}

export function getMissingDeductionQuantity(item: {
  quantity?: number;
  stockDeducted?: boolean;
  stockDeductedQuantity?: number;
}) {
  const qty = item.quantity || 0;
  const deducted = getEffectiveDeductedQuantity(item);
  return Math.max(0, qty - deducted);
}

export function resolveRestockQuantity(
  returnedQuantity: number,
  restockQuantity?: number,
) {
  return typeof restockQuantity === "number" ? restockQuantity : 0;
}
