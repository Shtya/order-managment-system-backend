import { MigrationInterface, QueryRunner } from "typeorm";

export class BackfillGettingStartedAchievements1760000000000 implements MigrationInterface {
  name = "BackfillGettingStartedAchievements1760000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // First product
    await queryRunner.query(`
      INSERT INTO getting_started_achievements
        ("id", "adminId", "type", "first_completed_at")
      SELECT
        gen_random_uuid(),
        p."adminId",
        'first_product_created',
        MIN(p."created_at")
      FROM products p
      WHERE p."adminId" IS NOT NULL
      GROUP BY p."adminId"
      ON CONFLICT ("adminId", "type") DO NOTHING;
    `);

    // First warehouse
    await queryRunner.query(`
      INSERT INTO getting_started_achievements
        ("id", "adminId", "type", "first_completed_at")
      SELECT
        gen_random_uuid(),
        w."adminId",
        'first_warehouse_created',
        MIN(w."created_at")
      FROM warehouses w
      WHERE w."adminId" IS NOT NULL
      GROUP BY w."adminId"
      ON CONFLICT ("adminId", "type") DO NOTHING;
    `);

    // First order
    await queryRunner.query(`
      INSERT INTO getting_started_achievements
        ("id", "adminId", "type", "first_completed_at")
      SELECT
        gen_random_uuid(),
        o."adminId",
        'first_order_created',
        MIN(o."created_at")
      FROM orders o
      WHERE o."adminId" IS NOT NULL
      GROUP BY o."adminId"
      ON CONFLICT ("adminId", "type") DO NOTHING;
    `);

    // First shipping integration
    await queryRunner.query(`
      INSERT INTO getting_started_achievements
        ("id", "adminId", "type", "first_completed_at")
      SELECT
        gen_random_uuid(),
        s."adminId",
        'shipping_integration_connected',
        MIN(s."created_at")
      FROM shipping_integrations s
      WHERE s."adminId" IS NOT NULL
      GROUP BY s."adminId"
      ON CONFLICT ("adminId", "type") DO NOTHING;
    `);

    // First WhatsApp connection
    await queryRunner.query(`
      INSERT INTO getting_started_achievements
        ("id", "adminId", "type", "first_completed_at")
      SELECT
        gen_random_uuid(),
        w."adminId",
        'whatsapp_connected',
        MIN(w."createdAt")
      FROM whatsapp_accounts w
      WHERE w."adminId" IS NOT NULL
      GROUP BY w."adminId"
      ON CONFLICT ("adminId", "type") DO NOTHING;
    `);

    // First store connection
    await queryRunner.query(`
      INSERT INTO getting_started_achievements
        ("id", "adminId", "type", "first_completed_at")
      SELECT
        gen_random_uuid(),
        s."adminId",
        'store_connected',
        MIN(s."created_at")
      FROM stores s
      WHERE s."adminId" IS NOT NULL
      GROUP BY s."adminId"
      ON CONFLICT ("adminId", "type") DO NOTHING;
    `);

    // First team member
    await queryRunner.query(`
      INSERT INTO getting_started_achievements
        ("id", "adminId", "type", "first_completed_at")
      SELECT
        gen_random_uuid(),
        u."adminId",
        'first_team_member_created',
        MIN(u."createdAt")
      FROM users u
      WHERE u."adminId" IS NOT NULL
      GROUP BY u."adminId"
      ON CONFLICT ("adminId", "type") DO NOTHING;
    `);

    // First automation
    await queryRunner.query(`
      INSERT INTO getting_started_achievements
        ("id", "adminId", "type", "first_completed_at")
      SELECT
        gen_random_uuid(),
        a."adminId",
        'first_automation_created',
        MIN(a."createdAt")
      FROM automation_flows a
      WHERE a."adminId" IS NOT NULL
      GROUP BY a."adminId"
      ON CONFLICT ("adminId", "type") DO NOTHING;
    `);

    // First safe/account
    await queryRunner.query(`
      INSERT INTO getting_started_achievements
        ("id", "adminId", "type", "first_completed_at")
      SELECT
        gen_random_uuid(),
        a."adminId",
        'first_safe_created',
        MIN(a."createdAt")
      FROM accounts a
      WHERE a."adminId" IS NOT NULL
      GROUP BY a."adminId"
      ON CONFLICT ("adminId", "type") DO NOTHING;
    `);

    // First accepted purchase
    await queryRunner.query(`
      INSERT INTO getting_started_achievements
        ("id", "adminId", "type", "first_completed_at")
      SELECT
        gen_random_uuid(),
        p."adminId",
        'first_purchase_accepted',
        MIN(p."created_at")
      FROM purchase_invoices p
      WHERE p."adminId" IS NOT NULL
        AND p."status" = 'accepted'
      GROUP BY p."adminId"
      ON CONFLICT ("adminId", "type") DO NOTHING;
    `);

    // First supplier
    await queryRunner.query(`
      INSERT INTO getting_started_achievements
        ("id", "adminId", "type", "first_completed_at")
      SELECT
        gen_random_uuid(),
        s."adminId",
        'first_supplier_created',
        MIN(s."created_at")
      FROM suppliers s
      WHERE s."adminId" IS NOT NULL
      GROUP BY s."adminId"
      ON CONFLICT ("adminId", "type") DO NOTHING;
    `);

    // First order assignment rule
    await queryRunner.query(`
      INSERT INTO getting_started_achievements
        ("id", "adminId", "type", "first_completed_at")
      SELECT
        gen_random_uuid(),
        a."adminId",
        'first_order_assignment_automation_rule_created',
        MIN(a."createdAt")
      FROM auto_assign_rules a
      WHERE a."adminId" IS NOT NULL
      GROUP BY a."adminId"
      ON CONFLICT ("adminId", "type") DO NOTHING;
    `);

    // First bundle
    await queryRunner.query(`
      INSERT INTO getting_started_achievements
        ("id", "adminId", "type", "first_completed_at")
      SELECT
        gen_random_uuid(),
        b."adminId",
        'first_order_bundle_created',
        MIN(b."created_at")
      FROM bundles b
      WHERE b."adminId" IS NOT NULL
      GROUP BY b."adminId"
      ON CONFLICT ("adminId", "type") DO NOTHING;
    `);

    // First custom role
    await queryRunner.query(`
      INSERT INTO getting_started_achievements
        ("id", "adminId", "type", "first_completed_at")
      SELECT
        gen_random_uuid(),
        r."adminId",
        'first_custom_role_created',
        MIN(CURRENT_TIMESTAMP)
      FROM roles r
      WHERE r."adminId" IS NOT NULL
        AND r."isGlobal" = false
      GROUP BY r."adminId"
      ON CONFLICT ("adminId", "type") DO NOTHING;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM getting_started_achievements
      WHERE "type" IN (
        'first_product_created',
        'first_warehouse_created',
        'first_order_created',
        'shipping_integration_connected',
        'whatsapp_connected',
        'store_connected',
        'first_team_member_created',
        'first_automation_created',
        'first_safe_created',
        'first_purchase_accepted',
        'first_supplier_created',
        'first_order_assignment_automation_rule_created',
        'first_order_bundle_created',
        'first_custom_role_created'
      );
    `);
  }
}
