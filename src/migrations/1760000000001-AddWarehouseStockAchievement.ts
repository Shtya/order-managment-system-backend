import { MigrationInterface, QueryRunner } from "typeorm";

export class AddWarehouseStockAchievement1760000000001 implements MigrationInterface {
    name = "AddWarehouseStockAchievement1760000000001";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'getting_started_achievements_type_enum') THEN
                    ALTER TYPE "getting_started_achievements_type_enum" ADD VALUE IF NOT EXISTS 'first_warehouse_stock_created';
                END IF;
                IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'getting_started_items_completion_type_enum') THEN
                    ALTER TYPE "getting_started_items_completion_type_enum" ADD VALUE IF NOT EXISTS 'first_warehouse_stock_created';
                END IF;
            END
            $$;
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // PostgreSQL does not support removing enum values; left intentionally empty.
    }
}
