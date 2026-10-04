import { MigrationInterface, QueryRunner } from "typeorm";

export class BackfillHandoffForOpenIssues1780000000000
  implements MigrationInterface
{
  name = "BackfillHandoffForOpenIssues1780000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "whatsapp_conversations" AS c
      SET "humanHandoff" = true
      WHERE c."humanHandoff" IS DISTINCT FROM true
        AND EXISTS (
          SELECT 1
          FROM issues i
          INNER JOIN issue_statuses s ON s.id = i."statusId"
          WHERE s.code NOT IN ('solved', 'cancelled')
            AND i."adminId" = c."adminId"
            AND (
                i."customerId" IS NOT NULL
                AND i."customerId" = c."customerId"
            )
        )
    `);
  }

  public async down(): Promise<void> {}
}
