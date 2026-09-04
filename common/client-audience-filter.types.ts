import { ConditionLogic, ConditionOperator } from "./condition.types";

export enum ClientAudienceEntity {
  CLIENT = "client",
  ORDER = "order",
  ORDER_ITEM = "order_item",
  VARIANT = "variant",
  PRODUCT = "product",
  ASSIGNMENT = "assignment",
  SHIPMENT = "shipment",
  UPSELL = "upsell",
}

export enum ClientAudienceValueType {
  STRING = "string",
  NUMBER = "number",
  BOOLEAN = "boolean",
  DATE = "date",
  UUID = "uuid",
  UUID_ARRAY = "uuid_array",
}

export enum ClientAudienceClientField {
  CLIENT_CREATED_AT = "client.createdAt",
  CLIENT_TAG_ID = "client.tagId",
  CLIENT_TOTAL_ORDERS = "client.totalOrders",
  CLIENT_CONFIRMED_COUNT = "client.confirmedCount",
  CLIENT_CONFIRMED_PERCENT = "client.confirmedPercent",
  CLIENT_CONFIRMED_RATE = "client.confirmedRate",
  CLIENT_SHIPPED_COUNT = "client.shippedCount",
  CLIENT_SHIPPED_PERCENT = "client.shippedPercent",
  CLIENT_DELIVERED_COUNT = "client.deliveredCount",
  CLIENT_DELIVERED_PERCENT = "client.deliveredPercent",
  CLIENT_RETURNED_COUNT = "client.returnedCount",
  CLIENT_RETURNED_PERCENT = "client.returnedPercent",
  CLIENT_CANCELLED_COUNT = "client.cancelledCount",
  CLIENT_CANCEL_RATE = "client.cancelRate",
  CLIENT_CANCELLED_BEFORE_SHIPPING = "client.cancelledBeforeShippingCount",
  CLIENT_CANCELLED_BEFORE_SHIPPING_RATE = "client.beforeShippingCancelRate",
  CLIENT_CANCELLED_AFTER_SHIPPING = "client.cancelledAfterShippingCount",
  CLIENT_CANCELLED_AFTER_SHIPPING_RATE = "client.afterShippingCancelRate",
  CLIENT_AFTER_SHIPPING_CANCEL_RATE = "client.afterShippingCancelRateOfShipped",
  CLIENT_TOTAL_SALES = "client.totalSales",
  CLIENT_DELIVERED_REVENUE = "client.deliveredRevenue",
}

export enum ClientAudienceOrderField {
  ORDER_STATUS_ID = "order.statusId",
  ORDER_STORE_ID = "order.storeId",
  ORDER_CITY_ID = "order.cityId",
  ORDER_PAYMENT_STATUS = "order.paymentStatus",
  ORDER_PAYMENT_METHOD = "order.paymentMethod",
  ORDER_PRODUCTS_TOTAL = "order.productsTotal",
  ORDER_ITEMS_QUANTITY = "order.itemsQuantity",
  ORDER_PRODUCTS_COUNT = "order.productsCount",
  ORDER_SHIPPING_COMPANY_ID = "order.shippingCompanyId",
  ORDER_FINAL_TOTAL = "order.finalTotal",
  ORDER_DISCOUNT = "order.discount",
  ORDER_IS_CONFIRMED = "order.isConfirmed",
  ORDER_CONFIRMATION_SOURCE = "order.confirmationSource",
  ORDER_ALLOW_OPEN_PACKAGE = "order.allowOpenPackage",
  ORDER_DUPLICATE_COUNT = "order.duplicateCount",
  ORDER_PHONE_VALID = "order.phone.valid",
  ORDER_TAG_ID = "order.tagId",
}

export enum ClientAudienceOrderItemField {
  QUANTITY = "order_item.quantity",
  UNIT_PRICE = "order_item.unitPrice",
  LINE_TOTAL = "order_item.lineTotal",
  VARIANT_ID = "order_item.variantId",
}

export enum ClientAudienceVariantField {
  ID = "variant.id",
  PRODUCT_ID = "variant.productId",
  SKU = "variant.sku",
  PRICE = "variant.price",
  STOCK_ON_HAND = "variant.stockOnHand",
}

export enum ClientAudienceProductField {
  ID = "product.id",
  CATEGORY_ID = "product.categoryId",
  NAME = "product.name",
  SKU = "product.sku",
}

export enum ClientAudienceAssignmentField {
  CONTACT_TRIES = "assignment.contactTries",
  HAS_ACTIVE = "assignment.hasActive",
}

export enum ClientAudienceShipmentField {
  STATUS = "shipment.status",
  SHIPPING_COMPANY_ID = "shipment.shippingCompanyId",
  SHIPPED_AT = "shipment.shippedAt",
}

export enum ClientAudienceUpsellField {
  ACCEPTED = "upsell.accepted",
  STATUS = "upsell.status",
}

export type ClientAudienceField =
  | ClientAudienceClientField
  | ClientAudienceOrderField
  | ClientAudienceOrderItemField
  | ClientAudienceVariantField
  | ClientAudienceProductField
  | ClientAudienceAssignmentField
  | ClientAudienceShipmentField
  | ClientAudienceUpsellField
  | string;

export interface ClientAudienceRule {
  field: ClientAudienceField;
  operator: ConditionOperator | string;
  value?: any;
}

export interface ClientAudienceGroup {
  entity: ClientAudienceEntity | string;
  logic: ConditionLogic | string;
  rules: ClientAudienceNode[];
}

export type ClientAudienceNode = ClientAudienceRule | ClientAudienceGroup;

export interface ClientAudienceFilter extends ClientAudienceGroup {
  rootEntity?: ClientAudienceEntity.CLIENT;
  entity: ClientAudienceEntity.CLIENT;
}

export interface ClientAudienceRecipient {
  clientId: string;
  customerId: string | null;
  phoneNumber: string | null;
}

// Backward-compatible aliases for existing campaign exports/imports during the refactor.
export { ClientAudienceClientField as ClientAudienceClientConditionField };
export { ClientAudienceOrderField as ClientAudienceOrderConditionField };
export type ClientAudienceClientConditionRule = ClientAudienceRule;
export type ClientAudienceOrderConditionRule = ClientAudienceRule;
export type ClientAudienceOrderConditionGroup = ClientAudienceGroup;
export type ClientAudienceCondition = ClientAudienceNode;
export enum ClientAudienceConditionType {
  CLIENT = "client",
  HAS_ORDER = "has_order",
}
