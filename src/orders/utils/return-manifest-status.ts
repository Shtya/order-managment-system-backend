import { OrderItemEntity, ReturnRequestItemEntity } from "entities/order.entity";

export function isPartiallyReturnedForManifest(
  orderItems: Pick<OrderItemEntity, "id" | "quantity">[],
  returnItems: Pick<ReturnRequestItemEntity, "originalOrderItemId" | "quantity">[],
) {
  const returnedQtyMap = new Map<string, number>();
  for (const item of returnItems) {
    const key = item.originalOrderItemId;
    if (!key) continue;
    returnedQtyMap.set(key, (returnedQtyMap.get(key) || 0) + (item.quantity || 0));
  }

  return orderItems.some((it) => (returnedQtyMap.get(it.id) || 0) < (it.quantity || 0));
}

