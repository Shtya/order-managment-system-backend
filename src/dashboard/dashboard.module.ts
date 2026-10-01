import { Module } from "@nestjs/common";
import { DashboardService } from "./dashboard.service";
import { AiDashboardService } from "./ai-dashboard.service";
import { DashboardController } from "./dashboard.controller";
import {
  OrderEntity,
  OrderScanLogEntity,
  OrderStatusEntity,
} from "entities/order.entity";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "entities/user.entity";
import { WebhookOrderFailureEntity } from "entities/stores.entity";
import { AdminSettingsModule } from "src/admin-settings/admin-settings.module";
import { AgentEntity } from "entities/agent.entity";

@Module({
  imports: [
    AdminSettingsModule,
    TypeOrmModule.forFeature([
      OrderEntity,
      OrderStatusEntity,
      User,
      OrderScanLogEntity,
      WebhookOrderFailureEntity,
      AgentEntity,
    ]),
  ],
  controllers: [DashboardController],
  providers: [DashboardService, AiDashboardService],
})
export class DashboardModule {}
