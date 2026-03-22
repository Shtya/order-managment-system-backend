import { Module } from "@nestjs/common";
import { AdminSettingsService } from "./admin-settings.service";
import { AdminSettingsController } from "./admin-settings.controller";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AdminSettingsEntity } from "entities/adminSettings.entity";

@Module({
  imports: [TypeOrmModule.forFeature([AdminSettingsEntity])],
  controllers: [AdminSettingsController],
  providers: [AdminSettingsService],
})
export class AdminSettingsModule {}
