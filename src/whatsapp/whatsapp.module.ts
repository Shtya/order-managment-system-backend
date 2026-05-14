import { Module } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappAccountController } from './controllers/WhatsappAccount.controller';
import { WhatsappAccountService } from './services/WhatsappAccount.service';
import { WhatsappAccountEntity, WhatsappTemplateEntity } from 'entities/whatsapp.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WhatsappApiService } from './services/WhatsappApi.service';
import { HttpModule } from '@nestjs/axios';
import { WhatsappTemplateService } from './services/WhatsappTemplate.service';
import { WhatsappTemplateController } from './controllers/WhatsappTemplate.controller';

@Module({
  imports: [HttpModule,TypeOrmModule.forFeature([WhatsappAccountEntity,WhatsappTemplateEntity])],
  controllers: [WhatsappController, WhatsappAccountController, WhatsappTemplateController],
  providers: [WhatsappService, WhatsappAccountService, WhatsappApiService,WhatsappTemplateService],
  exports: [WhatsappService, WhatsappAccountService, WhatsappApiService,WhatsappTemplateService],
  
})
export class WhatsappModule { }
