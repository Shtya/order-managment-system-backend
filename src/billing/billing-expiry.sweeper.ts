import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { BillingService } from "./billing.service";

@Injectable()
export class BillingExpirySweeper {
  private readonly logger = new Logger(BillingExpirySweeper.name);

  constructor(private readonly billing: BillingService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async sweep(): Promise<number> {
    let total = 0;
    for (;;) {
      const batch = await this.billing.expireDue(50);
      total += batch;
      if (batch < 50) {
        break;
      }
    }
    if (total > 0) {
      this.logger.warn(`Expired ${total} billing authorizations`);
    }
    return total;
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  @Cron(CronExpression.EVERY_HOUR)
  async reconcile(): Promise<number> {
    const mismatches = await this.billing.reconcileHolds(100);
  
    if (mismatches > 0) {
      this.logger.error(
        `Billing reconciliation found ${mismatches} mismatches`,
      );
    }
  
    return mismatches;
  }
}
