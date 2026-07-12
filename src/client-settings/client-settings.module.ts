import { Global, Module } from '@nestjs/common';
import { ClientSettingsService } from './client-settings.service';
import { ClientSettingsController } from './client-settings.controller';
import { ClientSettingsEntity } from 'entities/clientSettings.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientSettingsSubscriber } from './client-settings.subscribtor';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ClientSettingsEntity])],
  controllers: [ClientSettingsController],
  providers: [ClientSettingsService, ClientSettingsSubscriber],
  exports: [ClientSettingsService],
})
export class ClientSettingsModule {}
