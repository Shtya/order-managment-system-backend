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
}

export enum ClientAudienceVariantField {
  ID = "variant.id",
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

export type ClientAudienceKnownField =
  | ClientAudienceClientField
  | ClientAudienceOrderField
  | ClientAudienceOrderItemField
  | ClientAudienceVariantField
  | ClientAudienceProductField
  | ClientAudienceAssignmentField
  | ClientAudienceShipmentField
  | ClientAudienceUpsellField;

export type ClientAudienceField = ClientAudienceKnownField | string;

/** Explicit primitive type per filter field. Adding a field enum without an entry here fails typecheck. */
export const CLIENT_AUDIENCE_FIELD_VALUE_TYPES = {
  [ClientAudienceClientField.CLIENT_CREATED_AT]: ClientAudienceValueType.DATE,
  [ClientAudienceClientField.CLIENT_TAG_ID]: ClientAudienceValueType.UUID,
  [ClientAudienceClientField.CLIENT_TOTAL_ORDERS]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_CONFIRMED_COUNT]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_CONFIRMED_PERCENT]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_CONFIRMED_RATE]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_SHIPPED_COUNT]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_SHIPPED_PERCENT]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_DELIVERED_COUNT]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_DELIVERED_PERCENT]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_RETURNED_COUNT]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_RETURNED_PERCENT]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_CANCELLED_COUNT]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_CANCEL_RATE]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_CANCELLED_BEFORE_SHIPPING]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_CANCELLED_BEFORE_SHIPPING_RATE]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_CANCELLED_AFTER_SHIPPING]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_CANCELLED_AFTER_SHIPPING_RATE]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_AFTER_SHIPPING_CANCEL_RATE]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_TOTAL_SALES]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_DELIVERED_REVENUE]: ClientAudienceValueType.NUMBER,

  [ClientAudienceOrderField.ORDER_STATUS_ID]: ClientAudienceValueType.UUID,
  [ClientAudienceOrderField.ORDER_STORE_ID]: ClientAudienceValueType.UUID,
  [ClientAudienceOrderField.ORDER_CITY_ID]: ClientAudienceValueType.UUID,
  [ClientAudienceOrderField.ORDER_PAYMENT_STATUS]: ClientAudienceValueType.STRING,
  [ClientAudienceOrderField.ORDER_PAYMENT_METHOD]: ClientAudienceValueType.STRING,
  [ClientAudienceOrderField.ORDER_PRODUCTS_TOTAL]: ClientAudienceValueType.NUMBER,
  [ClientAudienceOrderField.ORDER_ITEMS_QUANTITY]: ClientAudienceValueType.NUMBER,
  [ClientAudienceOrderField.ORDER_PRODUCTS_COUNT]: ClientAudienceValueType.NUMBER,
  [ClientAudienceOrderField.ORDER_SHIPPING_COMPANY_ID]: ClientAudienceValueType.UUID,
  [ClientAudienceOrderField.ORDER_FINAL_TOTAL]: ClientAudienceValueType.NUMBER,
  [ClientAudienceOrderField.ORDER_DISCOUNT]: ClientAudienceValueType.NUMBER,
  [ClientAudienceOrderField.ORDER_IS_CONFIRMED]: ClientAudienceValueType.BOOLEAN,
  [ClientAudienceOrderField.ORDER_CONFIRMATION_SOURCE]: ClientAudienceValueType.STRING,
  [ClientAudienceOrderField.ORDER_ALLOW_OPEN_PACKAGE]: ClientAudienceValueType.BOOLEAN,
  [ClientAudienceOrderField.ORDER_DUPLICATE_COUNT]: ClientAudienceValueType.NUMBER,
  [ClientAudienceOrderField.ORDER_PHONE_VALID]: ClientAudienceValueType.BOOLEAN,
  [ClientAudienceOrderField.ORDER_TAG_ID]: ClientAudienceValueType.UUID,

  [ClientAudienceOrderItemField.QUANTITY]: ClientAudienceValueType.NUMBER,
  [ClientAudienceOrderItemField.UNIT_PRICE]: ClientAudienceValueType.NUMBER,
  [ClientAudienceOrderItemField.LINE_TOTAL]: ClientAudienceValueType.NUMBER,

  [ClientAudienceVariantField.ID]: ClientAudienceValueType.UUID,
  [ClientAudienceVariantField.SKU]: ClientAudienceValueType.STRING,
  [ClientAudienceVariantField.PRICE]: ClientAudienceValueType.NUMBER,
  [ClientAudienceVariantField.STOCK_ON_HAND]: ClientAudienceValueType.NUMBER,

  [ClientAudienceProductField.ID]: ClientAudienceValueType.UUID,
  [ClientAudienceProductField.CATEGORY_ID]: ClientAudienceValueType.UUID,
  [ClientAudienceProductField.NAME]: ClientAudienceValueType.STRING,
  [ClientAudienceProductField.SKU]: ClientAudienceValueType.STRING,

  [ClientAudienceAssignmentField.CONTACT_TRIES]: ClientAudienceValueType.NUMBER,
  [ClientAudienceAssignmentField.HAS_ACTIVE]: ClientAudienceValueType.BOOLEAN,

  [ClientAudienceShipmentField.STATUS]: ClientAudienceValueType.STRING,
  [ClientAudienceShipmentField.SHIPPING_COMPANY_ID]: ClientAudienceValueType.UUID,
  [ClientAudienceShipmentField.SHIPPED_AT]: ClientAudienceValueType.DATE,

  [ClientAudienceUpsellField.ACCEPTED]: ClientAudienceValueType.BOOLEAN,
  [ClientAudienceUpsellField.STATUS]: ClientAudienceValueType.STRING,
} as const satisfies Record<ClientAudienceKnownField, ClientAudienceValueType>;

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
  name: string | null;
  clientId: string;
  customerId: string | null;
  phoneNumber: string | null;
  profilePicture: string | null;
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
