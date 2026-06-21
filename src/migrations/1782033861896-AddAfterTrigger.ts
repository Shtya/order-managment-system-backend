import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAfterTrigger1782033861896 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // 2. Create the AFTER UPDATE trigger function
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION log_account_update()
            RETURNS TRIGGER AS $$
            BEGIN
                UPDATE "orders" 
                SET "oldStatusId" = OLD."statusId" 
                WHERE id = NEW.id;

                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);
        await queryRunner.query(`
            CREATE TRIGGER log_update
            AFTER UPDATE ON "orders"
            FOR EACH ROW
            WHEN (OLD."statusId" IS DISTINCT FROM NEW."statusId")
            EXECUTE FUNCTION log_account_update();
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER IF EXISTS log_update ON "orders"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS log_account_update()`);
    }

}
