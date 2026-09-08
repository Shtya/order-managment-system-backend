import { ConditionLogic, ConditionOperator } from "./condition.types";

export enum ClientAudienceEntity {
  CLIENT = "client",
  ORDER = "order",
  ORDER_ITEM = "order_item",
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
  CLIENT_CONFIRMED_RATE = "client.confirmedRate",
  CLIENT_DELIVERED_COUNT = "client.deliveredCount",
  CLIENT_RETURNED_COUNT = "client.returnedCount",
  CLIENT_CANCELLED_COUNT = "client.cancelledCount",
  CLIENT_CANCEL_RATE = "client.cancelRate",
  CLIENT_DELIVERED_REVENUE = "client.deliveredRevenue",
}

export enum ClientAudienceOrderField {
  ORDER_STATUS_ID = "order.statusId",
  ORDER_STORE_ID = "order.storeId",
  ORDER_PRODUCTS_TOTAL = "order.productsTotal",
  ORDER_SHIPPING_COMPANY_ID = "order.shippingCompanyId",
  ORDER_FINAL_TOTAL = "order.finalTotal",
  ORDER_CONFIRMATION_SOURCE = "order.confirmationSource",
  ORDER_TAG_ID = "order.tagId",
}

export enum ClientAudienceOrderItemField {
  QUANTITY = "order_item.quantity",
  VARIANT_ID = "variant.id",
  PRODUCT_ID = "product.id",
  CATEGORY_ID = "product.categoryId",
}

export type ClientAudienceKnownField =
  | ClientAudienceClientField
  | ClientAudienceOrderField
  | ClientAudienceOrderItemField;

export type ClientAudienceField = ClientAudienceKnownField | string;

/** Explicit primitive type per filter field. Adding a field enum without an entry here fails typecheck. */
export const CLIENT_AUDIENCE_FIELD_VALUE_TYPES = {
  [ClientAudienceClientField.CLIENT_CREATED_AT]: ClientAudienceValueType.DATE,
  [ClientAudienceClientField.CLIENT_TAG_ID]: ClientAudienceValueType.UUID,
  [ClientAudienceClientField.CLIENT_TOTAL_ORDERS]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_CONFIRMED_COUNT]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_CONFIRMED_RATE]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_DELIVERED_COUNT]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_RETURNED_COUNT]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_CANCELLED_COUNT]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_CANCEL_RATE]: ClientAudienceValueType.NUMBER,
  [ClientAudienceClientField.CLIENT_DELIVERED_REVENUE]: ClientAudienceValueType.NUMBER,

  [ClientAudienceOrderField.ORDER_STATUS_ID]: ClientAudienceValueType.UUID,
  [ClientAudienceOrderField.ORDER_STORE_ID]: ClientAudienceValueType.UUID,
  [ClientAudienceOrderField.ORDER_PRODUCTS_TOTAL]: ClientAudienceValueType.NUMBER,
  [ClientAudienceOrderField.ORDER_SHIPPING_COMPANY_ID]: ClientAudienceValueType.UUID,
  [ClientAudienceOrderField.ORDER_FINAL_TOTAL]: ClientAudienceValueType.NUMBER,
  [ClientAudienceOrderField.ORDER_CONFIRMATION_SOURCE]: ClientAudienceValueType.STRING,
  [ClientAudienceOrderField.ORDER_TAG_ID]: ClientAudienceValueType.UUID,

  [ClientAudienceOrderItemField.QUANTITY]: ClientAudienceValueType.NUMBER,
  [ClientAudienceOrderItemField.VARIANT_ID]: ClientAudienceValueType.UUID,
  [ClientAudienceOrderItemField.PRODUCT_ID]: ClientAudienceValueType.UUID,
  [ClientAudienceOrderItemField.CATEGORY_ID]: ClientAudienceValueType.UUID,
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
