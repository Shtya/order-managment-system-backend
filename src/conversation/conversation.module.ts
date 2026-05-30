import { Module } from '@nestjs/common';
import { ConversationService } from './conversation.service';
import { ConversationController } from './conversation.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConversationEntity } from 'entities/whatsapp.entity';
import { WhatsappAccountEntity, WhatsappMessageEntity, WhatsappTemplateEntity } from 'entities/whatsapp.entity';
import { CustomerEntity } from 'entities/customers.entity';
import { CustomerModule } from '../customer/customer.module';

@Module({
  imports: [
    CustomerModule,
    TypeOrmModule.forFeature([WhatsappAccountEntity, WhatsappTemplateEntity,
      WhatsappMessageEntity, CustomerEntity, ConversationEntity]),
  ],
  controllers: [ConversationController],
  providers: [ConversationService],
  exports: [ConversationService],
})
export class ConversationModule { }
