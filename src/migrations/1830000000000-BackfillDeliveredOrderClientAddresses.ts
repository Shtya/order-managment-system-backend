import { MigrationInterface, QueryRunner } from "typeorm";

export class BackfillDeliveredOrderClientAddresses1830000000000
  implements MigrationInterface
{
  name = "BackfillDeliveredOrderClientAddresses1830000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasOrderAreaId = await queryRunner.hasColumn("orders", "areaId");
    const orderAreaId = hasOrderAreaId
      ? `orders."areaId"`
      : "NULL::uuid";
    await queryRunner.query(`
      WITH resolved_orders AS (
        SELECT
          orders."adminId",
          orders."clientId",
          BTRIM(orders.address) AS address,
          BTRIM(COALESCE(orders.city, '')) AS city,
          orders."cityId",
          BTRIM(COALESCE(area_by_id."nameAr", area_by_name."nameAr", orders.area, '')) AS area,
          COALESCE(area_by_id.id, area_by_name.id) AS "areaId",
          LOWER(REGEXP_REPLACE(BTRIM(COALESCE(orders.area, '')), '\\s+', ' ', 'g')) AS raw_area_key,
          orders.landmark,
          LOWER(REGEXP_REPLACE(BTRIM(orders.address), '\\s+', ' ', 'g')) AS address_key,
          LOWER(REGEXP_REPLACE(BTRIM(COALESCE(orders.city, '')), '\\s+', ' ', 'g')) AS city_key,
          LOWER(REGEXP_REPLACE(BTRIM(COALESCE(area_by_id."nameAr", area_by_name."nameAr", orders.area, '')), '\\s+', ' ', 'g')) AS area_key,
          orders."deliveredAt",
          orders.updated_at,
          orders.id
        FROM orders
        INNER JOIN order_statuses status ON status.id = orders."statusId"
        INNER JOIN clients client
          ON client.id = orders."clientId"
         AND client."adminId" = orders."adminId"
        LEFT JOIN areas area_by_id ON area_by_id.id = ${orderAreaId}
        LEFT JOIN LATERAL (
          SELECT candidate.id, candidate."nameAr", candidate."nameEn"
          FROM areas candidate
          WHERE ${orderAreaId} IS NULL
            AND (
              LOWER(REGEXP_REPLACE(BTRIM(candidate."nameEn"), '\\s+', ' ', 'g')) = LOWER(REGEXP_REPLACE(BTRIM(COALESCE(orders.area, '')), '\\s+', ' ', 'g'))
              OR LOWER(REGEXP_REPLACE(BTRIM(candidate."nameAr"), '\\s+', ' ', 'g')) = LOWER(REGEXP_REPLACE(BTRIM(COALESCE(orders.area, '')), '\\s+', ' ', 'g'))
            )
          ORDER BY
            CASE WHEN candidate."cityId" = orders."cityId" THEN 0 ELSE 1 END,
            candidate.id
          LIMIT 1
        ) area_by_name ON true
        WHERE orders."clientId" IS NOT NULL
          AND BTRIM(COALESCE(orders.address, '')) <> ''
          AND status.code IN ('delivered', 'returned', 'partially_returned')
          AND (status.system = true OR status."adminId" = orders."adminId")
      ), eligible_orders AS (
        SELECT
          resolved.*,
          ROW_NUMBER() OVER (
            PARTITION BY
              resolved."adminId",
              resolved."clientId",
              resolved.address_key,
              resolved.city_key,
              resolved.area_key
            ORDER BY resolved."deliveredAt" DESC NULLS LAST, resolved.updated_at DESC, resolved.id DESC
          ) AS source_rank
        FROM resolved_orders resolved
      )
      INSERT INTO client_addresses (
        id,
        "adminId",
        "clientId",
        label,
        address,
        city,
        "cityId",
        area,
        "areaId",
        landmark,
        "isDefault",
        "createdAt",
        "updatedAt"
      )
      SELECT
        gen_random_uuid(),
        eligible."adminId",
        eligible."clientId",
        NULL,
        eligible.address,
        eligible.city,
        eligible."cityId",
        eligible.area,
        eligible."areaId",
        NULLIF(BTRIM(COALESCE(eligible.landmark, '')), ''),
        false,
        NOW(),
        NOW()
      FROM eligible_orders eligible
      WHERE eligible.source_rank = 1
        AND NOT EXISTS (
          SELECT 1
          FROM client_addresses existing
          WHERE existing."adminId" = eligible."adminId"
            AND existing."clientId" = eligible."clientId"
            AND LOWER(REGEXP_REPLACE(BTRIM(existing.address), '\\s+', ' ', 'g')) = eligible.address_key
            AND LOWER(REGEXP_REPLACE(BTRIM(COALESCE(existing.city, '')), '\\s+', ' ', 'g')) = eligible.city_key
            AND (
              LOWER(REGEXP_REPLACE(BTRIM(COALESCE(existing.area, '')), '\\s+', ' ', 'g')) = eligible.area_key
              OR LOWER(REGEXP_REPLACE(BTRIM(COALESCE(existing.area, '')), '\\s+', ' ', 'g')) = eligible.raw_area_key
            )
            AND existing."shippingProvider" IS NULL
        )
    `);

    await queryRunner.query(`
      WITH resolved_orders AS (
        SELECT
          orders."adminId",
          orders."clientId",
          BTRIM(orders.address) AS address,
          BTRIM(COALESCE(orders.city, '')) AS city,
          orders."cityId",
          BTRIM(COALESCE(orders.area, '')) AS area,
          orders.landmark,
          LOWER(company.code) AS shipping_provider,
          NULLIF(BTRIM(COALESCE(orders."shippingMetadata"->>'cityId', '')), '') AS provider_city_id,
          NULLIF(BTRIM(COALESCE(orders."shippingMetadata"->>'zoneId', '')), '') AS zone_id,
          NULLIF(BTRIM(COALESCE(orders."shippingMetadata"->>'districtId', '')), '') AS district_id,
          NULLIF(BTRIM(COALESCE(orders."shippingMetadata"->>'locationId', '')), '') AS location_id,
          LOWER(REGEXP_REPLACE(BTRIM(orders.address), '\\s+', ' ', 'g')) AS address_key,
          LOWER(REGEXP_REPLACE(BTRIM(COALESCE(orders.city, '')), '\\s+', ' ', 'g')) AS city_key,
          LOWER(REGEXP_REPLACE(BTRIM(COALESCE(orders.area, '')), '\\s+', ' ', 'g')) AS area_key,
          orders."deliveredAt",
          orders.updated_at,
          orders.id
        FROM orders
        INNER JOIN order_statuses status ON status.id = orders."statusId"
        INNER JOIN clients client
          ON client.id = orders."clientId"
         AND client."adminId" = orders."adminId"
        INNER JOIN shipping_companies company
          ON company.id = orders."shippingCompanyId"
        WHERE orders."clientId" IS NOT NULL
          AND BTRIM(COALESCE(orders.address, '')) <> ''
          AND LOWER(company.code) IN ('bosta', 'turbo')
          AND (
            (
              LOWER(company.code) = 'bosta'
              AND NULLIF(BTRIM(COALESCE(orders."shippingMetadata"->>'cityId', '')), '') IS NOT NULL
              AND NULLIF(BTRIM(COALESCE(orders."shippingMetadata"->>'districtId', '')), '') IS NOT NULL
            )
            OR (
              LOWER(company.code) = 'turbo'
              AND NULLIF(BTRIM(COALESCE(orders."shippingMetadata"->>'cityId', '')), '') IS NOT NULL
              AND NULLIF(BTRIM(COALESCE(orders."shippingMetadata"->>'zoneId', '')), '') IS NOT NULL
            )
          )
          AND status.code IN ('delivered', 'returned', 'partially_returned')
          AND (status.system = true OR status."adminId" = orders."adminId")
      ), eligible_orders AS (
        SELECT
          resolved.*,
          ROW_NUMBER() OVER (
            PARTITION BY
              resolved."adminId",
              resolved."clientId",
              resolved.shipping_provider,
              resolved.address_key,
              resolved.city_key,
              resolved.area_key,
              COALESCE(resolved.provider_city_id, ''),
              COALESCE(resolved.zone_id, ''),
              COALESCE(resolved.district_id, '')
            ORDER BY resolved."deliveredAt" DESC NULLS LAST, resolved.updated_at DESC, resolved.id DESC
          ) AS source_rank
        FROM resolved_orders resolved
      )
      INSERT INTO client_addresses (
        id,
        "adminId",
        "clientId",
        label,
        address,
        city,
        "cityId",
        area,
        "areaId",
        landmark,
        "shippingProvider",
        "shippingMetadata",
        "isDefault",
        "createdAt",
        "updatedAt"
      )
      SELECT
        gen_random_uuid(),
        eligible."adminId",
        eligible."clientId",
        NULL,
        eligible.address,
        eligible.city,
        eligible."cityId",
        eligible.area,
        NULL,
        NULLIF(BTRIM(COALESCE(eligible.landmark, '')), ''),
        eligible.shipping_provider,
        jsonb_strip_nulls(jsonb_build_object(
          'cityId', eligible.provider_city_id,
          'zoneId', eligible.zone_id,
          'districtId', eligible.district_id,
          'locationId', eligible.location_id
        )),
        false,
        NOW(),
        NOW()
      FROM eligible_orders eligible
      WHERE eligible.source_rank = 1
        AND NOT EXISTS (
          SELECT 1
          FROM client_addresses existing
          WHERE existing."adminId" = eligible."adminId"
            AND existing."clientId" = eligible."clientId"
            AND LOWER(COALESCE(existing."shippingProvider", 'none')) = eligible.shipping_provider
            AND LOWER(REGEXP_REPLACE(BTRIM(existing.address), '\\s+', ' ', 'g')) = eligible.address_key
            AND LOWER(REGEXP_REPLACE(BTRIM(COALESCE(existing.city, '')), '\\s+', ' ', 'g')) = eligible.city_key
            AND LOWER(REGEXP_REPLACE(BTRIM(COALESCE(existing.area, '')), '\\s+', ' ', 'g')) = eligible.area_key
            AND COALESCE(existing."shippingMetadata"->>'cityId', '') = COALESCE(eligible.provider_city_id, '')
            AND COALESCE(existing."shippingMetadata"->>'zoneId', '') = COALESCE(eligible.zone_id, '')
            AND COALESCE(existing."shippingMetadata"->>'districtId', '') = COALESCE(eligible.district_id, '')
        )
    `);
  }

  public async down(): Promise<void> {
    // Data-only backfill: inserted addresses cannot be distinguished safely
    // from addresses created later through normal application workflows.
  }
}
