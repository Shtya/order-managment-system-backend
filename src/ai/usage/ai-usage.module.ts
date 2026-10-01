import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AiUsageEntity } from "entities/ai-usage.entity";
import { AiUsageLedgerService } from "./ai-usage-ledger.service";

@Module({
  imports: [TypeOrmModule.forFeature([AiUsageEntity])],
  providers: [AiUsageLedgerService],
  exports: [AiUsageLedgerService],
})
export class AiUsageModule {}
