import { MigrationInterface, QueryRunner } from "typeorm";

export class EmailDispatchAttempts1792400000000 implements MigrationInterface {
  name = "EmailDispatchAttempts1792400000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "email_messages" ADD COLUMN IF NOT EXISTS "dispatchAttempts" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `UPDATE "email_messages" SET status = 'cancelled', reason = 'test_queue_retired', "nextAttemptAt" = NULL WHERE status = 'queued' AND request->'source'->>'type' = 'test'`,
    );
    await queryRunner.query(
      `UPDATE "email_messages" SET status = 'unknown', reason = 'test_queue_retired_while_sending', "nextAttemptAt" = NULL WHERE status = 'sending' AND request->'source'->>'type' = 'test'`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "email_messages" DROP COLUMN IF EXISTS "dispatchAttempts"`,
    );
  }
}
