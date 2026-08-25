import { MigrationInterface, QueryRunner } from "typeorm";

export class AddShipmentShippedAt1777650000000 implements MigrationInterface {
  name = "AddShipmentShippedAt1777650000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "shipments"
      ADD COLUMN IF NOT EXISTS "shippedAt" TIMESTAMPTZ NULL DEFAULT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "shipments"
      DROP COLUMN IF EXISTS "shippedAt"
    `);
  }
}
