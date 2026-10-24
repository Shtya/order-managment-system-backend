import { MigrationInterface, QueryRunner } from "typeorm";

export class AddContactConversationStatsIndexes1800000000000
  implements MigrationInterface
{
  name = "AddContactConversationStatsIndexes1800000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_customers_admin_createdAt" ON "customers" ("adminId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_whatsapp_messages_admin_conversation_createdAt" ON "whatsapp_messages" ("adminId", "conversationId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_whatsapp_conversations_admin_status" ON "whatsapp_conversations" ("adminId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_whatsapp_conversations_admin_lastMessageAt" ON "whatsapp_conversations" ("adminId", "lastMessageAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_whatsapp_conversations_admin_lastMessageAt"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_whatsapp_conversations_admin_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_whatsapp_messages_admin_conversation_createdAt"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_customers_admin_createdAt"`,
    );
  }
}
