import { Injectable } from "@nestjs/common";
import { DataSource, SelectQueryBuilder } from "typeorm";
import {
  CLIENT_AUDIENCE_FIELD_VALUE_TYPES,
  ClientAudienceAssignmentField,
  ClientAudienceClientField,
  ClientAudienceEntity,
  ClientAudienceField,
  ClientAudienceFilter,
  ClientAudienceKnownField,
  ClientAudienceGroup,
  ClientAudienceNode,
  ClientAudienceOrderField,
  ClientAudienceOrderItemField,
  ClientAudienceProductField,
  ClientAudienceRecipient,
  ClientAudienceShipmentField,
  ClientAudienceUpsellField,
  ClientAudienceValueType,
  ClientAudienceVariantField,
} from "common/client-audience-filter.types";
import { ConditionLogic, ConditionOperator } from "common/condition.types";
import { ClientEntity } from "entities/clients.entity";
import { OrderStatus } from "entities/order.entity";
import { UpsellStatus } from "entities/upsells.entity";

type ClientQB = SelectQueryBuilder<ClientEntity>;

interface RelationContext {
  entity: string;
  alias: string;
  parent?: RelationContext;
}

interface BuildContext {
  params: Record<string, any>;
  index: number;
}

@Injectable()
export class AudienceService {
  constructor(private readonly dataSource: DataSource) {}

  countRecipients(adminId: string, filter: ClientAudienceFilter): Promise<number> {
    return this.buildClientQuery(adminId, filter).getCount();
  }

  async listRecipients(
    adminId: string,
    filter: ClientAudienceFilter,
    options?: { cursor?: any; limit?: number; sortDir?: "ASC" | "DESC" },
  ): Promise<{
    records: ClientAudienceRecipient[];
    hasMore: boolean;
    limit: number;
    nextCursor?: { value: Date; id: string };
    sortBy: "createdAt";
    sortDir: "ASC" | "DESC";
  }> {
    const limit = Math.min(100, Number(options?.limit ?? 10));
    const sortDir = options?.sortDir ?? "DESC";
    const qb = this.buildRecipientsQuery(adminId, filter);

    if (options?.cursor) {
      const operator = sortDir === "DESC" ? "<" : ">";
      qb.andWhere(`(client."createdAt", client.id) ${operator} (:cursorValue, :cursorId)`, {
        cursorValue: options.cursor.value,
        cursorId: options.cursor.id,
      });
    }

    qb.orderBy(`client."createdAt"`, sortDir).addOrderBy("client.id", sortDir);

    const rows = await qb.take(limit + 1).getRawMany();
    const hasMore = rows.length > limit;
    const records = (hasMore ? rows.slice(0, limit) : rows).map((row) =>
      this.mapRecipientRow(row),
    );

    return {
      records,
      hasMore,
      limit,
      nextCursor: hasMore
        ? {
            value: rows[limit - 1].createdAt,
            id: rows[limit - 1].clientId,
          }
        : undefined,
      sortBy: "createdAt",
      sortDir,
    };
  }

  async listRecipientsPage(
    adminId: string,
    filter: ClientAudienceFilter,
    options?: { cursor?: any; limit?: number },
  ): Promise<{
    records: ClientAudienceRecipient[];
    hasMore: boolean;
    nextCursor?: { value: Date; id: string };
  }> {
    const limit = Math.min(2000, Math.max(1, Number(options?.limit ?? 1000)));
    const qb = this.buildRecipientsQuery(adminId, filter);

    if (options?.cursor) {
      qb.andWhere(`(client."createdAt", client.id) < (:cursorValue, :cursorId)`, {
        cursorValue: options.cursor.value,
        cursorId: options.cursor.id,
      });
    }

    qb.orderBy(`client."createdAt"`, "DESC").addOrderBy("client.id", "DESC");

    const rows = await qb.take(limit + 1).getRawMany();
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    return {
      records: pageRows.map((row) => this.mapRecipientRow(row)),
      hasMore,
      nextCursor: hasMore
        ? {
            value: pageRows[pageRows.length - 1].createdAt,
            id: pageRows[pageRows.length - 1].clientId,
          }
        : undefined,
    };
  }

  async getAllRecipients(
    adminId: string,
    filter: ClientAudienceFilter,
    options?: { max?: number },
  ): Promise<ClientAudienceRecipient[]> {
    const max = Math.min(50000, Number(options?.max ?? 10000));
    const rows = await this.buildRecipientsQuery(adminId, filter)
      .orderBy(`client."createdAt"`, "DESC")
      .addOrderBy("client.id", "DESC")
      .take(max)
      .getRawMany();

    return rows.map((row) => this.mapRecipientRow(row));
  }

  buildClientQuery(adminId: string, filter: ClientAudienceFilter): ClientQB {
    const qb = this.dataSource
      .getRepository(ClientEntity)
      .createQueryBuilder("client")
      .select("client.id")
      .where("client.adminId = :adminId", { adminId });

    const root = this.normalizeRootFilter(filter);
    const built = this.buildGroupWhere(root, { entity: ClientAudienceEntity.CLIENT, alias: "client" }, {
      params: {},
      index: 0,
    });

    if (built.sql) {
      qb.andWhere(built.sql, built.params);
    }

    return qb;
  }

  getFilterMetadata() {
    return {
      rootEntity: ClientAudienceEntity.CLIENT,
      operators: Object.values(ConditionOperator),
      entities: [
        this.entityMeta(ClientAudienceEntity.CLIENT, Object.values(ClientAudienceClientField), [
          ClientAudienceEntity.ORDER,
        ]),
        this.entityMeta(ClientAudienceEntity.ORDER, Object.values(ClientAudienceOrderField), [
          ClientAudienceEntity.ORDER_ITEM,
          ClientAudienceEntity.ASSIGNMENT,
          ClientAudienceEntity.SHIPMENT,
          ClientAudienceEntity.UPSELL,
        ]),
        this.entityMeta(ClientAudienceEntity.ORDER_ITEM, Object.values(ClientAudienceOrderItemField), [
          ClientAudienceEntity.VARIANT,
        ]),
        this.entityMeta(ClientAudienceEntity.VARIANT, Object.values(ClientAudienceVariantField), [
          ClientAudienceEntity.PRODUCT,
        ]),
        this.entityMeta(ClientAudienceEntity.PRODUCT, Object.values(ClientAudienceProductField), []),
        this.entityMeta(ClientAudienceEntity.ASSIGNMENT, Object.values(ClientAudienceAssignmentField), []),
        this.entityMeta(ClientAudienceEntity.SHIPMENT, Object.values(ClientAudienceShipmentField), []),
        this.entityMeta(ClientAudienceEntity.UPSELL, Object.values(ClientAudienceUpsellField), []),
      ],
    };
  }

  private buildRecipientsQuery(adminId: string, filter: ClientAudienceFilter) {
    return this.buildClientQuery(adminId, filter)
      .leftJoin("client.primaryContact", "pc")
      .addSelect("client.id", "clientId")
      .addSelect("client.name", "name")
      .addSelect("client.profilePicture", "profilePicture")
      .addSelect("client.createdAt", "createdAt")
      .addSelect("pc.id", "customerId")
      .addSelect("pc.phoneNumber", "phoneNumber")
      .addSelect("pc.profilePicture", "contactProfilePicture");
  }

  private buildGroupWhere(
    group: ClientAudienceGroup,
    context: RelationContext,
    build: BuildContext,
  ): { sql: string; params: Record<string, any> } {
    const clauses: string[] = [];

    for (const node of group.rules || []) {
      const clause = this.isGroup(node)
        ? this.buildRelationGroupClause(node, context, build)
        : this.buildRuleClause(node.field, node.operator, node.value, context, build);

      if (clause) clauses.push(clause);
    }

    if (!clauses.length) return { sql: "", params: build.params };

    const joiner =
      (group.logic || ConditionLogic.AND).toUpperCase() === ConditionLogic.OR
        ? " OR "
        : " AND ";
    return { sql: `(${clauses.join(joiner)})`, params: build.params };
  }

  private buildRelationGroupClause(
    group: ClientAudienceGroup,
    parent: RelationContext,
    build: BuildContext,
  ): string | null {
    const relation = this.relationFor(parent, group.entity);
    if (!relation) return null;

    const childContext: RelationContext = {
      entity: group.entity,
      alias: relation.alias,
      parent,
    };
    const where = this.buildGroupWhere(group, childContext, build).sql;
    const extraWhere = where ? ` AND ${where}` : "";

    return `EXISTS (${relation.sql}${extraWhere})`;
  }

  private buildRuleClause(
    field: ClientAudienceField,
    operator: string,
    value: any,
    context: RelationContext,
    build: BuildContext,
  ): string | null {
    if (
      context.entity === ClientAudienceEntity.CLIENT &&
      field === ClientAudienceClientField.CLIENT_TAG_ID
    ) {
      const paramKey = `aud_${build.index++}`;
      return this.relationFieldClause(
        `SELECT 1 FROM client_tags ct_sub WHERE ct_sub."clientId" = ${context.alias}.id`,
        `ct_sub."tagId"`,
        operator,
        value,
        paramKey,
        build.params,
      );
    }

    if (
      context.entity === ClientAudienceEntity.ORDER &&
      field === ClientAudienceOrderField.ORDER_TAG_ID
    ) {
      const paramKey = `aud_${build.index++}`;
      return this.relationFieldClause(
        `SELECT 1 FROM order_tags ot_sub WHERE ot_sub."orderId" = ${context.alias}.id`,
        `ot_sub."tagId"`,
        operator,
        value,
        paramKey,
        build.params,
      );
    }

    const expr = this.fieldExpr(field, context);
    if (!expr) return null;
    const paramKey = `aud_${build.index++}`;
    return this.matchExpr(
      expr,
      operator,
      value,
      paramKey,
      build.params,
      this.valueTypeForField(String(field)),
    );
  }

  private relationFor(
    parent: RelationContext,
    entity: string,
  ): { alias: string; sql: string } | null {
    const parentAlias = parent.alias;
    const alias = `${entity}_${Math.random().toString(36).slice(2, 8)}`;

    if (parent.entity === ClientAudienceEntity.CLIENT && entity === ClientAudienceEntity.ORDER) {
      return {
        alias,
        sql: `SELECT 1 FROM orders ${alias}
          WHERE ${alias}."clientId" = ${parentAlias}.id
            AND ${alias}."adminId" = ${parentAlias}."adminId"
            AND ${alias}.deleted_at IS NULL`,
      };
    }
    if (parent.entity === ClientAudienceEntity.ORDER && entity === ClientAudienceEntity.ORDER_ITEM) {
      return {
        alias,
        sql: `SELECT 1 FROM order_items ${alias} WHERE ${alias}."orderId" = ${parentAlias}.id`,
      };
    }
    if (parent.entity === ClientAudienceEntity.ORDER && entity === ClientAudienceEntity.ASSIGNMENT) {
      return {
        alias,
        sql: `SELECT 1 FROM order_assignments ${alias} WHERE ${alias}."orderId" = ${parentAlias}.id`,
      };
    }
    if (parent.entity === ClientAudienceEntity.ORDER && entity === ClientAudienceEntity.SHIPMENT) {
      return {
        alias,
        sql: `SELECT 1 FROM shipments ${alias} WHERE ${alias}."orderId" = ${parentAlias}.id`,
      };
    }
    if (parent.entity === ClientAudienceEntity.ORDER && entity === ClientAudienceEntity.UPSELL) {
      return {
        alias,
        sql: `SELECT 1 FROM upsell_history ${alias} WHERE ${alias}."orderId" = ${parentAlias}.id`,
      };
    }
    if (parent.entity === ClientAudienceEntity.ORDER_ITEM && entity === ClientAudienceEntity.VARIANT) {
      return {
        alias,
        sql: `SELECT 1 FROM product_variants ${alias} WHERE ${alias}.id = ${parentAlias}."variantId"`,
      };
    }
    if (parent.entity === ClientAudienceEntity.VARIANT && entity === ClientAudienceEntity.PRODUCT) {
      return {
        alias,
        sql: `SELECT 1 FROM products ${alias} WHERE ${alias}.id = ${parentAlias}."productId"`,
      };
    }

    return null;
  }

  private fieldExpr(field: ClientAudienceField, context: RelationContext): string | null {
    const alias = context.alias;
    switch (context.entity) {
      case ClientAudienceEntity.CLIENT:
        return this.clientFieldExpr(field);
      case ClientAudienceEntity.ORDER:
        return this.orderFieldExpr(field, alias);
      case ClientAudienceEntity.ORDER_ITEM:
        return this.orderItemFieldExpr(field, alias);
      case ClientAudienceEntity.VARIANT:
        return this.variantFieldExpr(field, alias);
      case ClientAudienceEntity.PRODUCT:
        return this.productFieldExpr(field, alias);
      case ClientAudienceEntity.ASSIGNMENT:
        return this.assignmentFieldExpr(field, alias);
      case ClientAudienceEntity.SHIPMENT:
        return this.shipmentFieldExpr(field, alias);
      case ClientAudienceEntity.UPSELL:
        return this.upsellFieldExpr(field, alias);
      default:
        return null;
    }
  }

  private clientFieldExpr(field: ClientAudienceField): string | null {
    if (field === ClientAudienceClientField.CLIENT_CREATED_AT) return `client."createdAt"`;
    return this.clientStatField(field as ClientAudienceClientField);
  }

  private orderFieldExpr(field: ClientAudienceField, alias: string): string | null {
    switch (field) {
      case ClientAudienceOrderField.ORDER_STATUS_ID:
        return `${alias}."statusId"`;
      case ClientAudienceOrderField.ORDER_STORE_ID:
        return `${alias}."storeId"`;
      case ClientAudienceOrderField.ORDER_CITY_ID:
        return `${alias}."cityId"`;
      case ClientAudienceOrderField.ORDER_PAYMENT_STATUS:
        return `${alias}."paymentStatus"`;
      case ClientAudienceOrderField.ORDER_PAYMENT_METHOD:
        return `${alias}."paymentMethod"`;
      case ClientAudienceOrderField.ORDER_PRODUCTS_TOTAL:
        return `COALESCE(${alias}."productsTotal", 0)`;
      case ClientAudienceOrderField.ORDER_ITEMS_QUANTITY:
        return `(SELECT COALESCE(SUM(oi_qty.quantity), 0) FROM order_items oi_qty WHERE oi_qty."orderId" = ${alias}.id)`;
      case ClientAudienceOrderField.ORDER_PRODUCTS_COUNT:
        return `(SELECT COUNT(*) FROM order_items oi_cnt WHERE oi_cnt."orderId" = ${alias}.id)`;
      case ClientAudienceOrderField.ORDER_SHIPPING_COMPANY_ID:
        return `${alias}."shippingCompanyId"`;
      case ClientAudienceOrderField.ORDER_FINAL_TOTAL:
        return `COALESCE(${alias}."finalTotal", 0)`;
      case ClientAudienceOrderField.ORDER_DISCOUNT:
        return `COALESCE(${alias}."discount", 0)`;
      case ClientAudienceOrderField.ORDER_IS_CONFIRMED:
        return `(COALESCE(${alias}."isConfirmed", false) = true)`;
      case ClientAudienceOrderField.ORDER_CONFIRMATION_SOURCE:
        return `${alias}."confirmationSource"`;
      case ClientAudienceOrderField.ORDER_ALLOW_OPEN_PACKAGE:
        return `(COALESCE(${alias}."allowOpenPackage", false) = true)`;
      case ClientAudienceOrderField.ORDER_DUPLICATE_COUNT:
        return `COALESCE(${alias}."duplicateCount", 0)`;
      case ClientAudienceOrderField.ORDER_PHONE_VALID:
        return `(COALESCE(${alias}.normalized_phone, '') ~ '^201(0|1|2|5)\\d{8}$')`;
      default:
        return null;
    }
  }

  private orderItemFieldExpr(field: ClientAudienceField, alias: string): string | null {
    switch (field) {
      case ClientAudienceOrderItemField.QUANTITY:
        return `COALESCE(${alias}.quantity, 0)`;
      case ClientAudienceOrderItemField.UNIT_PRICE:
        return `COALESCE(${alias}."unitPrice", 0)`;
      case ClientAudienceOrderItemField.LINE_TOTAL:
        return `COALESCE(${alias}."lineTotal", 0)`;
      default:
        return null;
    }
  }

  private variantFieldExpr(field: ClientAudienceField, alias: string): string | null {
    switch (field) {
      case ClientAudienceVariantField.ID:
        return `${alias}.id`;
      case ClientAudienceVariantField.SKU:
        return `${alias}.sku`;
      case ClientAudienceVariantField.PRICE:
        return `COALESCE(${alias}.price, 0)`;
      case ClientAudienceVariantField.STOCK_ON_HAND:
        return `COALESCE(${alias}."stockOnHand", 0)`;
      default:
        return null;
    }
  }

  private productFieldExpr(field: ClientAudienceField, alias: string): string | null {
    switch (field) {
      case ClientAudienceProductField.ID:
        return `${alias}.id`;
      case ClientAudienceProductField.CATEGORY_ID:
        return `${alias}."categoryId"`;
      case ClientAudienceProductField.NAME:
        return `${alias}.name`;
      case ClientAudienceProductField.SKU:
        return `${alias}.sku`;
      default:
        return null;
    }
  }

  private assignmentFieldExpr(field: ClientAudienceField, alias: string): string | null {
    switch (field) {
      case ClientAudienceAssignmentField.CONTACT_TRIES:
        return `COALESCE(${alias}."contactTries", 0)`;
      case ClientAudienceAssignmentField.HAS_ACTIVE:
        return `(COALESCE(${alias}."isAssignmentActive", false) = true)`;
      default:
        return null;
    }
  }

  private shipmentFieldExpr(field: ClientAudienceField, alias: string): string | null {
    switch (field) {
      case ClientAudienceShipmentField.STATUS:
        return `${alias}.status`;
      case ClientAudienceShipmentField.SHIPPING_COMPANY_ID:
        return `${alias}."shippingCompanyId"`;
      case ClientAudienceShipmentField.SHIPPED_AT:
        return `${alias}."shippedAt"`;
      default:
        return null;
    }
  }

  private upsellFieldExpr(field: ClientAudienceField, alias: string): string | null {
    switch (field) {
      case ClientAudienceUpsellField.ACCEPTED:
        return `(${alias}.status = '${UpsellStatus.ACCEPTED}')`;
      case ClientAudienceUpsellField.STATUS:
        return `${alias}.status`;
      default:
        return null;
    }
  }

  private matchExpr(
    actualSql: string,
    operator: string,
    expected: any,
    paramKey: string,
    params: Record<string, any>,
    valueType?: ClientAudienceValueType,
  ): string {
    if (valueType === ClientAudienceValueType.DATE) {
      return this.matchDateExpr(actualSql, operator, expected, paramKey, params);
    }

    const normalizedActual = this.normalizeSql(actualSql);

    switch (operator as ConditionOperator) {
      case ConditionOperator.EQ:
        params[paramKey] = this.normalizeValue(expected);
        return `${normalizedActual} = :${paramKey}`;
      case ConditionOperator.NEQ:
        params[paramKey] = this.normalizeValue(expected);
        return `${normalizedActual} != :${paramKey}`;
      case ConditionOperator.IN:
        params[paramKey] = this.normalizeList(expected);
        return `${normalizedActual} IN (:...${paramKey})`;
      case ConditionOperator.NOT_IN:
        params[paramKey] = this.normalizeList(expected);
        return `${normalizedActual} NOT IN (:...${paramKey})`;
      case ConditionOperator.IS_NULL:
        return `((${actualSql}) IS NULL OR CAST((${actualSql}) AS text) = '')`;
      case ConditionOperator.IS_NOT_NULL:
        return `((${actualSql}) IS NOT NULL AND CAST((${actualSql}) AS text) <> '')`;
      case ConditionOperator.GTE:
        params[paramKey] = Number(expected);
        return `CAST(COALESCE((${actualSql}), 0) AS numeric) >= :${paramKey}`;
      case ConditionOperator.LTE:
        params[paramKey] = Number(expected);
        return `CAST(COALESCE((${actualSql}), 0) AS numeric) <= :${paramKey}`;
      default:
        return "FALSE";
    }
  }

  private matchDateExpr(
    actualSql: string,
    operator: string,
    expected: any,
    paramKey: string,
    params: Record<string, any>,
  ): string {
    const dateSql = `(${actualSql})::date`;

    switch (operator as ConditionOperator) {
      case ConditionOperator.EQ:
        params[paramKey] = this.normalizeDateValue(expected);
        return `${dateSql} = CAST(:${paramKey} AS date)`;
      case ConditionOperator.NEQ:
        params[paramKey] = this.normalizeDateValue(expected);
        return `${dateSql} IS DISTINCT FROM CAST(:${paramKey} AS date)`;
      case ConditionOperator.IN:
        params[paramKey] = this.normalizeDateList(expected);
        return `${dateSql} IN (:...${paramKey})`;
      case ConditionOperator.NOT_IN:
        params[paramKey] = this.normalizeDateList(expected);
        return `${dateSql} NOT IN (:...${paramKey})`;
      case ConditionOperator.IS_NULL:
        return `(${actualSql}) IS NULL`;
      case ConditionOperator.IS_NOT_NULL:
        return `(${actualSql}) IS NOT NULL`;
      case ConditionOperator.GTE:
        params[paramKey] = this.normalizeDateValue(expected);
        return `${dateSql} >= CAST(:${paramKey} AS date)`;
      case ConditionOperator.LTE:
        params[paramKey] = this.normalizeDateValue(expected);
        return `${dateSql} <= CAST(:${paramKey} AS date)`;
      default:
        return "FALSE";
    }
  }

  private normalizeDateValue(value: any): string {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString().slice(0, 10);
    }
    const raw = String(value ?? "").trim();
    return raw.slice(0, 10);
  }

  private normalizeDateList(value: any): string[] {
    const list = Array.isArray(value) ? value : [value];
    const dates = list.map((item) => this.normalizeDateValue(item)).filter(Boolean);
    return dates.length ? dates : ["1970-01-01"];
  }

  private normalizeSql(actualSql: string): string {
    return `CASE
      WHEN (${actualSql}) IS NULL THEN ''
      WHEN CAST((${actualSql}) AS text) IN ('t', 'true') THEN 'true'
      WHEN CAST((${actualSql}) AS text) IN ('f', 'false') THEN 'false'
      ELSE CAST((${actualSql}) AS text)
    END`;
  }

  private normalizeList(value: any): string[] {
    const list = Array.isArray(value) ? value : [value];
    return list.length ? list.map((v) => this.normalizeValue(v)) : [""];
  }

  private normalizeValue(value: any): string {
    if (value === true || value === "true") return "true";
    if (value === false || value === "false") return "false";
    if (value === null || value === undefined) return "";
    return String(value);
  }

  private relationFieldClause(
    baseSelect: string,
    columnSql: string,
    operator: string,
    value: any,
    paramKey: string,
    params: Record<string, any>,
  ): string {
    if (operator === ConditionOperator.IS_NULL || operator === "is_null") {
      return `NOT EXISTS (${baseSelect})`;
    }
    if (operator === ConditionOperator.IS_NOT_NULL || operator === "is_not_null") {
      return `EXISTS (${baseSelect})`;
    }

    const positiveOperator =
      operator === ConditionOperator.NOT_IN || operator === "not_in"
        ? ConditionOperator.IN
        : operator === ConditionOperator.NEQ || operator === "neq"
          ? ConditionOperator.EQ
          : operator;
    const comparison = this.matchExpr(columnSql, positiveOperator, value, paramKey, params);
    const exists = `EXISTS (${baseSelect} AND ${comparison})`;

    if (
      operator === ConditionOperator.NOT_IN ||
      operator === "not_in" ||
      operator === ConditionOperator.NEQ ||
      operator === "neq"
    ) {
      return `NOT ${exists}`;
    }

    return exists;
  }

  private clientStatField(field: ClientAudienceClientField): string | null {
    const totalOrders = this.clientOrdersAgg("COUNT(stat_ord.id)");
    const confirmedCount = this.clientOrdersAgg(
      `COUNT(CASE WHEN os.code = '${OrderStatus.CONFIRMED}' THEN 1 END)`,
    );
    const allConfirmedCount = this.clientOrdersAgg(
      'COUNT(CASE WHEN stat_ord."isConfirmed" = true THEN 1 END)',
    );
    const shippedCount = this.clientOrdersAgg(
      `COUNT(CASE WHEN os.code = '${OrderStatus.SHIPPED}' THEN 1 END)`,
    );
    const deliveredCount = this.clientOrdersAgg(
      `COUNT(CASE WHEN os.code = '${OrderStatus.DELIVERED}' THEN 1 END)`,
    );
    const returnedCount = this.clientOrdersAgg(
      `COUNT(CASE WHEN os.code = '${OrderStatus.RETURNED}' THEN 1 END)`,
    );
    const cancelledCount = this.clientOrdersAgg(
      `COUNT(CASE WHEN os.code = '${OrderStatus.CANCELLED}' THEN 1 END)`,
    );
    const cancelledBeforeShippingCount = this.clientOrdersAgg(
      `COUNT(CASE WHEN os.code = '${OrderStatus.CANCELLED}' AND ${this.cancelledAfterShippingSql()} = false THEN 1 END)`,
    );
    const cancelledAfterShippingCount = this.clientOrdersAgg(
      `COUNT(CASE WHEN os.code = '${OrderStatus.CANCELLED}' AND ${this.cancelledAfterShippingSql()} = true THEN 1 END)`,
    );
    const totalSales = this.clientOrdersAgg('COALESCE(SUM(stat_ord."finalTotal"), 0)');
    const deliveredRevenue = this.clientOrdersAgg(
      `COALESCE(SUM(CASE WHEN os.code = '${OrderStatus.DELIVERED}' THEN stat_ord."finalTotal" ELSE 0 END), 0)`,
    );
    const allShippedCount = `(SELECT COUNT(DISTINCT so.id)
      FROM orders so
      INNER JOIN shipments sh ON sh."orderId" = so.id
      WHERE so."clientId" = client.id
        AND so."adminId" = client."adminId"
        AND so.deleted_at IS NULL
        AND sh."shippedAt" IS NOT NULL)`;

    switch (field) {
      case ClientAudienceClientField.CLIENT_TOTAL_ORDERS:
        return `COALESCE(${totalOrders}, 0)`;
      case ClientAudienceClientField.CLIENT_CONFIRMED_COUNT:
        return `COALESCE(${confirmedCount}, 0)`;
      case ClientAudienceClientField.CLIENT_CONFIRMED_PERCENT:
        return this.rateSql(confirmedCount, totalOrders);
      case ClientAudienceClientField.CLIENT_CONFIRMED_RATE:
        return this.rateSql(allConfirmedCount, totalOrders);
      case ClientAudienceClientField.CLIENT_SHIPPED_COUNT:
        return `COALESCE(${shippedCount}, 0)`;
      case ClientAudienceClientField.CLIENT_SHIPPED_PERCENT:
        return this.rateSql(shippedCount, totalOrders);
      case ClientAudienceClientField.CLIENT_DELIVERED_COUNT:
        return `COALESCE(${deliveredCount}, 0)`;
      case ClientAudienceClientField.CLIENT_DELIVERED_PERCENT:
        return this.rateSql(deliveredCount, totalOrders);
      case ClientAudienceClientField.CLIENT_RETURNED_COUNT:
        return `COALESCE(${returnedCount}, 0)`;
      case ClientAudienceClientField.CLIENT_RETURNED_PERCENT:
        return this.rateSql(returnedCount, totalOrders);
      case ClientAudienceClientField.CLIENT_CANCELLED_COUNT:
        return `COALESCE(${cancelledCount}, 0)`;
      case ClientAudienceClientField.CLIENT_CANCEL_RATE:
        return this.rateSql(cancelledCount, totalOrders);
      case ClientAudienceClientField.CLIENT_CANCELLED_BEFORE_SHIPPING:
        return `COALESCE(${cancelledBeforeShippingCount}, 0)`;
      case ClientAudienceClientField.CLIENT_CANCELLED_BEFORE_SHIPPING_RATE:
        return this.rateSql(cancelledBeforeShippingCount, totalOrders);
      case ClientAudienceClientField.CLIENT_CANCELLED_AFTER_SHIPPING:
        return `COALESCE(${cancelledAfterShippingCount}, 0)`;
      case ClientAudienceClientField.CLIENT_CANCELLED_AFTER_SHIPPING_RATE:
        return this.rateSql(cancelledAfterShippingCount, totalOrders);
      case ClientAudienceClientField.CLIENT_AFTER_SHIPPING_CANCEL_RATE:
        return this.rateSql(cancelledAfterShippingCount, allShippedCount);
      case ClientAudienceClientField.CLIENT_TOTAL_SALES:
        return `COALESCE(${totalSales}, 0)`;
      case ClientAudienceClientField.CLIENT_DELIVERED_REVENUE:
        return `COALESCE(${deliveredRevenue}, 0)`;
      default:
        return null;
    }
  }

  private clientOrdersAgg(selectExpr: string): string {
    return `(SELECT ${selectExpr}
      FROM orders stat_ord
      LEFT JOIN order_statuses os ON os.id = stat_ord."statusId"
      WHERE stat_ord."clientId" = client.id
        AND stat_ord."adminId" = client."adminId"
        AND stat_ord.deleted_at IS NULL)`;
  }

  private cancelledAfterShippingSql(): string {
    return `COALESCE((
      SELECT occ."cancelledAfterShipping"
      FROM order_cancel_causes occ
      WHERE occ."orderId" = stat_ord.id
      ORDER BY occ.created_at DESC
      LIMIT 1
    ), stat_ord."shippedAt" IS NOT NULL)`;
  }

  private rateSql(countExpr: string, denominatorExpr: string): string {
    return `CASE
      WHEN COALESCE((${denominatorExpr}), 0) <= 0 THEN 0
      ELSE ROUND((COALESCE((${countExpr}), 0)::numeric / (${denominatorExpr})::numeric) * 100, 2)
    END`;
  }

  private normalizeRootFilter(filter: ClientAudienceFilter): ClientAudienceFilter {
    return {
      rootEntity: ClientAudienceEntity.CLIENT,
      entity: ClientAudienceEntity.CLIENT,
      logic: filter?.logic || ConditionLogic.AND,
      rules: filter?.rules || [],
    };
  }

  private isGroup(node: ClientAudienceNode): node is ClientAudienceGroup {
    return !!(node as ClientAudienceGroup).entity;
  }

  private mapRecipientRow(row: any): ClientAudienceRecipient {
    return {
      name: row.client?.name ?? row.name ?? null,
      clientId: row.clientId,
      customerId: row.customerId ?? null,
      phoneNumber: row.phoneNumber ?? null,
      profilePicture: row.profilePicture || row.contactProfilePicture || null,
    };
  }

  private entityMeta(entity: ClientAudienceEntity, fields: string[], children: ClientAudienceEntity[]) {
    return {
      entity,
      fields: fields.map((field) => ({
        field,
        valueType: this.valueTypeForField(field),
      })),
      children,
    };
  }

  private valueTypeForField(field: string): ClientAudienceValueType {
    return CLIENT_AUDIENCE_FIELD_VALUE_TYPES[field as ClientAudienceKnownField]
      ?? ClientAudienceValueType.STRING;
  }
}
