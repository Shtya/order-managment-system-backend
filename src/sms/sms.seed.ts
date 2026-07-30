import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { SmsProviderEntity, SmsProviderType } from "entities/sms.entity";

export const DEFAULT_SMS_PROVIDERS = [
  {
    code: SmsProviderType.SMSEG,
    name: "SMSEG",
    isActive: true,
  },
];

@Injectable()
export class SmsSeedService implements OnModuleInit {
  private readonly logger = new Logger(SmsSeedService.name);

  constructor(
    @InjectRepository(SmsProviderEntity)
    private providersRepo: Repository<SmsProviderEntity>,
  ) { }

  async onModuleInit() {
    await this.seedProvidersOnce();
  }

  private async seedProvidersOnce() {
    for (const def of DEFAULT_SMS_PROVIDERS) {
      const existing = await this.providersRepo.findOne({ where: { code: def.code } });

      if (!existing) {
        await this.providersRepo.save(this.providersRepo.create(def as any));
        this.logger.log(`Seeded SMS provider: ${def.code}`);
      } else {
        existing.name = def.name;
        existing.isActive = def.isActive;
        await this.providersRepo.save(existing);
        this.logger.log(`Updated SMS provider: ${def.code}`);
      }
    }
  }
}
