import { MigrationInterface, QueryRunner } from "typeorm";

// Data migration: moves the legacy single-button automatic reply
// (orderReplyFollowupText / orderReplyFollowupButtonIndex /
// orderReplyFollowupButtonText) into the multi-button
// orderReplyFollowups payload as a one-entry array.
// Idempotent: only touches rows where orderReplyFollowups is still NULL.
export class MigrateCampaignOrderReplyFollowups1763000000001 implements MigrationInterface {
  name = "MigrateCampaignOrderReplyFollowups1763000000001";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const result = await queryRunner.query(`
      UPDATE campaigns
      SET "orderReplyFollowups" = jsonb_build_array(
        jsonb_build_object(
          'buttonIndex', COALESCE("orderReplyFollowupButtonIndex", 0),
          'buttonText', "orderReplyFollowupButtonText",
          'text', "orderReplyFollowupText"
        )
      )
      WHERE "orderReplyFollowupText" IS NOT NULL
        AND "orderReplyFollowups" IS NULL;
    `);
    // Log how many rows were migrated (rowCount is driver-dependent).
    // eslint-disable-next-line no-console
    console.log(
      `[MigrateCampaignOrderReplyFollowups] migrated rows: ${result?.[1] ?? result?.rowCount ?? "unknown"}`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverses only rows that still exactly match their legacy source
    // (i.e. rows this migration created, untouched since). Campaigns
    // with real multi-button data are left alone.
    await queryRunner.query(`
      UPDATE campaigns
      SET "orderReplyFollowups" = NULL
      WHERE "orderReplyFollowups" = jsonb_build_array(
        jsonb_build_object(
          'buttonIndex', COALESCE("orderReplyFollowupButtonIndex", 0),
          'buttonText', "orderReplyFollowupButtonText",
          'text', "orderReplyFollowupText"
        )
      );
    `);
  }
}
