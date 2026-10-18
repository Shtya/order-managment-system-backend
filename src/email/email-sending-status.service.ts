import { TranslationService } from "common/translation.service";
import { Injectable, HttpException } from "@nestjs/common";
import { EmailAccountsService } from "./email-accounts.service";
import { EmailContext } from "./email.types";

@Injectable()
export class EmailSendingStatusService {
  private cache = new Map<string, { until: number; value: any }>();
  private requests = new Map<string, number[]>();
  constructor(
    private readonly accounts: EmailAccountsService,
    private readonly translations: TranslationService,
  ) {}
  async get(ctx: EmailContext, id: string) {
    const account = await this.accounts.get(ctx, id, false);
    const key = `${ctx.adminId}:${ctx.actorId}:${id}`,
      now = Date.now();
    if (this.requests.size > 10000)
      for (const [k, times] of this.requests)
        if (times[times.length - 1] < now - 60000) this.requests.delete(k);
    const times = (this.requests.get(key) || []).filter((t) => t > now - 60000);
    if (times.length >= 12)
      throw new HttpException(
        {
          statusCode: 429,
          message: this.translations.t(
            "domains.email.status_rate_limited" as any,
          ),
          retryAfter: Math.max(1, Math.ceil((times[0] + 60000 - now) / 1000)),
        },
        429,
      );
    times.push(now);
    this.requests.set(key, times);
    const cached = this.cache.get(key);
    if (cached?.until > now)
      return {
        ...cached.value,
        status: account.status,
        cooldownUntil: account.cooldownUntil,
      };
    const value = {
      accountId: id,
      status: account.status,
      cooldownUntil: account.cooldownUntil,
      measuredAt: new Date().toISOString(),
    };
    if (this.cache.size > 10000) this.cache.clear();
    this.cache.set(key, { until: now + 15000, value });
    return value;
  }
}
