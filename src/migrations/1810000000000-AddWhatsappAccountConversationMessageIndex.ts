import { MigrationInterface, QueryRunner } from "typeorm";

export class AddWhatsappAccountConversationMessageIndex1810000000000
  implements MigrationInterface
{
  name = "AddWhatsappAccountConversationMessageIndex1810000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_whatsapp_messages_admin_account_conversation_createdAt" ON "whatsapp_messages" ("adminId", "accountId", "conversationId", "createdAt" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_whatsapp_messages_admin_account_conversation_createdAt"`,
    );
  }
}
