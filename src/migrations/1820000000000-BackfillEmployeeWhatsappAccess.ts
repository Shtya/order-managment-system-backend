import { MigrationInterface, QueryRunner } from "typeorm";

export class BackfillEmployeeWhatsappAccess1820000000000
  implements MigrationInterface
{
  name = "BackfillEmployeeWhatsappAccess1820000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "users"
      SET "whatsappAccessMode" = 'all'
      WHERE "adminId" IS NOT NULL
        AND "whatsappAccessMode" = 'selected'
    `);
  }

  public async down(): Promise<void> {}
}
