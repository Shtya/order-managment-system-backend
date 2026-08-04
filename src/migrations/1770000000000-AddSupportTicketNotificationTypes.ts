import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSupportTicketNotificationTypes1770000000000 implements MigrationInterface {
  name = "AddSupportTicketNotificationTypes1770000000000";
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const types = [
      "support_ticket_created",
      "support_ticket_new_message",
      "support_ticket_internal_note",
      "support_ticket_assigned",
      "support_ticket_unassigned",
      "support_ticket_status_changed",
      "support_ticket_priority_changed",
      "support_ticket_reopened",
      "support_ticket_resolved",
      "support_ticket_closed",
      "support_ticket_canceled",
    ];

    for (const type of types) {
      await queryRunner.query(
        `ALTER TYPE "public"."notifications_type_enum" ADD VALUE IF NOT EXISTS '${type}'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL does not support removing enum values. No-op.
    void queryRunner;
  }
}
