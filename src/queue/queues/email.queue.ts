import { Optional } from "@nestjs/common";
import { EmailAssetsService } from "src/email/email-assets.service";
import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { EmailService } from "src/email/email.service";
import { EmailDeferredError } from "src/email/email.types";

/** PostgreSQL is the durable queue; no commit/enqueue gap or second campaign send loop. */
@Injectable()
export class EmailQueueWorker {
  private running = false;
  private readonly logger = new Logger(EmailQueueWorker.name);
  constructor(
    private readonly dataSource: DataSource,
    private readonly email: EmailService,
    @Optional() private readonly assets?: EmailAssetsService,
  ) {}
  @Interval(10_000)
  async tick() {
    if (this.running || process.env.EMAIL_FEATURE_ENABLED !== "true") return;
    this.running = true;
    try {
      await this.email.retryRevocations();
      try {
        await this.assets?.cleanup();
      } catch {
        this.logger.warn(
          "Email asset cleanup deferred; verify the email-builder migration.",
        );
      }
      const rows = await this.dataSource.query(
        `SELECT id FROM email_messages WHERE status IN ('queued','sending') AND request->'source'->>'type' != 'campaign' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW()) ORDER BY "createdAt" LIMIT 20`,
      );
      for (const row of rows) {
        try {
          await this.email.dispatch(row.id);
        } catch (error) {
          if (error instanceof EmailDeferredError) {
            await this.dataSource.query(
              `UPDATE email_messages SET "nextAttemptAt" = GREATEST(COALESCE("nextAttemptAt", NOW()), $2::timestamptz), reason = $3 WHERE id = $1 AND status = 'queued'`,
              [row.id, new Date(Date.now() + error.delayMs), error.reason],
            );
            this.logger.warn(
              JSON.stringify({
                event: "email.queue.deferred",
                messageId: row.id,
                reason: error.reason,
                delayMs: error.delayMs,
              }),
            );
          } else
            this.logger.error(
              JSON.stringify({
                event: "email.queue.failed",
                messageId: row.id,
                error: error instanceof Error ? error.name : "unknown",
              }),
            );
        }
      }
      await this.dataSource.query(
        'DELETE FROM email_oauth_states WHERE "expiresAt" < NOW()',
      );
    } finally {
      this.running = false;
    }
  }
}
