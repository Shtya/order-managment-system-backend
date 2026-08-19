import { Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { TypeOrmModule } from "@nestjs/typeorm";
import { SmsController } from "./sms.controller";
import { SmsService } from "./sms.service";
import { SmsegProvider } from "./providers/smseg.provider";
import { SmsSeedService } from "./sms.seed";
import {
  SmsProviderEntity,
  SmsIntegrationEntity,
  SmsSenderEntity,
  SmsSendLogEntity,
} from "entities/sms.entity";

@Module({
  imports: [
    HttpModule,
    TypeOrmModule.forFeature([
      SmsProviderEntity,
      SmsIntegrationEntity,
      SmsSenderEntity,
      SmsSendLogEntity,
    ]),
  ],
  controllers: [SmsController],
  providers: [SmsService, SmsegProvider, SmsSeedService],
  exports: [SmsService],
})
export class SmsModule {}
