import { forwardRef, Module } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappAccountController } from './controllers/WhatsappAccount.controller';
import { WhatsappAccountService } from './services/WhatsappAccount.service';
import { WhatsappAccountEntity, WhatsappMessageEntity, WhatsappTemplateEntity, WhatsappWebhookEventEntity } from 'entities/whatsapp.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WhatsappApiService } from './services/WhatsappApi.service';
import { HttpModule } from '@nestjs/axios';
import { WhatsappTemplateService } from './services/WhatsappTemplate.service';
import { WhatsappTemplateController } from './controllers/WhatsappTemplate.controller';
import { AutomationModule } from 'src/automation/automation.module';
import { OrdersModule } from 'src/orders/orders.module';
import { ConversationEntity } from 'entities/whatsapp.entity';
import { ConversationModule } from 'src/conversation/conversation.module';
import { CustomerEntity } from 'entities/customers.entity';
import { CustomerModule } from '../customer/customer.module';
import { UpsellsModule } from 'src/upsells/upsells.module';
import { AutomationRunEntity } from 'entities/automation.entity';

@Module({
  imports: [
    HttpModule,
    forwardRef(() => AutomationModule),
    forwardRef(() => OrdersModule),
    forwardRef(() => ConversationModule),
    forwardRef(() => CustomerModule),
    forwardRef(() => UpsellsModule),
    TypeOrmModule.forFeature([WhatsappAccountEntity, WhatsappMessageEntity, WhatsappTemplateEntity,
      WhatsappWebhookEventEntity, ConversationEntity, CustomerEntity,AutomationRunEntity])],
  controllers: [WhatsappController, WhatsappAccountController, WhatsappTemplateController],
  providers: [WhatsappService, WhatsappAccountService, WhatsappApiService, WhatsappTemplateService],
  exports: [WhatsappService, WhatsappAccountService, WhatsappApiService, WhatsappTemplateService],

})
export class WhatsappModule { }
