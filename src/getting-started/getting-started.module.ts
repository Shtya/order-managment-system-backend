import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  GettingStartedAchievementEntity,
  GettingStartedEventEntity,
  GettingStartedItemEntity,
  GettingStartedStepEntity,
} from "entities/getting-started.entity";
import { User } from "entities/user.entity";
import { GettingStartedService } from "./getting-started.service";
import { GettingStartedController } from "./getting-started.controller";
import { GettingStartedStatsService } from "./getting-started-stats.service";
import { GettingStartedStatsController } from "./getting-started-stats.controller";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      GettingStartedAchievementEntity,
      GettingStartedEventEntity,
      GettingStartedItemEntity,
      GettingStartedStepEntity,
      User,
    ]),
  ],
  controllers: [GettingStartedController, GettingStartedStatsController],
  providers: [GettingStartedService, GettingStartedStatsService],
  exports: [GettingStartedService, GettingStartedStatsService],
})
export class GettingStartedModule {}
