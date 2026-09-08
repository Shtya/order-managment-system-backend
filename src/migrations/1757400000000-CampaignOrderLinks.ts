import { MigrationInterface, QueryRunner } from "typeorm";

export class CampaignOrderLinks1757400000000 implements MigrationInterface {
  name = "CampaignOrderLinks1757400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "campaigns"
      ADD COLUMN IF NOT EXISTS "discount" numeric(12,2) NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "campaigns"
      ADD COLUMN IF NOT EXISTS "orderReplyFollowupEnabled" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "campaigns"
      ADD COLUMN IF NOT EXISTS "orderReplyFollowupText" text
    `);
    await queryRunner.query(`
      ALTER TABLE "campaigns"
      ADD COLUMN IF NOT EXISTS "orderReplyFollowupButtonIndex" integer
    `);
    await queryRunner.query(`
      ALTER TABLE "campaigns"
      ADD COLUMN IF NOT EXISTS "orderReplyFollowupButtonText" varchar(200)
    `);
    await queryRunner.query(`
      ALTER TABLE "campaign_recipients"
      ADD COLUMN IF NOT EXISTS "accessToken" varchar(64)
    `);
    await queryRunner.query(`
      ALTER TABLE "campaign_recipients"
      ADD COLUMN IF NOT EXISTS "orderLinkSentAt" timestamptz
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_campaign_recipients_accessToken"
      ON "campaign_recipients" ("accessToken")
      WHERE "accessToken" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_campaign_recipients_accessToken"`);
    await queryRunner.query(`ALTER TABLE "campaign_recipients" DROP COLUMN IF EXISTS "orderLinkSentAt"`);
    await queryRunner.query(`ALTER TABLE "campaign_recipients" DROP COLUMN IF EXISTS "accessToken"`);
    await queryRunner.query(`ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "orderReplyFollowupButtonText"`);
    await queryRunner.query(`ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "orderReplyFollowupButtonIndex"`);
    await queryRunner.query(`ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "orderReplyFollowupText"`);
    await queryRunner.query(`ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "orderReplyFollowupEnabled"`);
    await queryRunner.query(`ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "discount"`);
  }
}
