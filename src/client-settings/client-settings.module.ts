import { forwardRef, Global, Module } from "@nestjs/common";
import { ClientSettingsService } from "./client-settings.service";
import { ClientSettingsController } from "./client-settings.controller";
import { ClientSettingsEntity } from "entities/clientSettings.entity";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ClientSettingsSubscriber } from "./client-settings.subscribtor";
import { OrphanFileEntity } from "entities/files.entity";
import { OrphanFilesModule } from "src/orphan-files/orphan-files.module";

@Global()
@Module({
  imports: [forwardRef(() => OrphanFilesModule) ,TypeOrmModule.forFeature([ClientSettingsEntity, OrphanFileEntity])],
  controllers: [ClientSettingsController],
  providers: [ClientSettingsService, ClientSettingsSubscriber],
  exports: [ClientSettingsService],
})
export class ClientSettingsModule {}
