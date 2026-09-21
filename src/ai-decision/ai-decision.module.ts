import { Module } from '@nestjs/common';
import { BillingModule } from 'src/billing/billing.module';
import { AiDecisionController } from './ai-decision.controller';
import { AiDecisionService } from './ai-decision.service';
import {
  JEV_OPTIONS,
  JevDecisionProvider,
  loadJevOptions,
} from './providers/jev-decision.provider';
import { AiDecisionProvider } from './providers/ai-decision.provider';

@Module({
  imports: [BillingModule], // must export BillingService
  controllers: [AiDecisionController], // test endpoint, remove or protect before production
  providers: [
    // If you use @nestjs/config, replace loadJevOptions() with values from ConfigService.
    { provide: JEV_OPTIONS, useFactory: () => loadJevOptions() },
    JevDecisionProvider,
    // Everything else injects the abstract class. Swapping the model = changing this line.
    { provide: AiDecisionProvider, useExisting: JevDecisionProvider },
    AiDecisionService,
  ],
  exports: [AiDecisionService],
})
export class AiDecisionModule {}