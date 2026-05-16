import { MigrationInterface, QueryRunner } from "typeorm";

export class AddStoreOrderSkuFallback1771600000000 implements MigrationInterface {
  name = "AddStoreOrderSkuFallback1771600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_retry_settings"
      ADD COLUMN IF NOT EXISTS "storeOrderSkuFallback" boolean NOT NULL DEFAULT true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_retry_settings"
      DROP COLUMN IF EXISTS "storeOrderSkuFallback"
    `);
  }
}
