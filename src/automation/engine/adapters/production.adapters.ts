import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { OrdersService } from 'src/orders/services/orders.service';
import { WhatsappApiService } from 'src/whatsapp/services/WhatsappApi.service';
import { InjectRepository } from '@nestjs/typeorm';
import { WhatsappTemplateEntity } from 'entities/whatsapp.entity';
import { Repository } from 'typeorm';
import { AutomationAdapter } from './automation-adapters.interface';

/**
 * Production implementation of AutomationAdapter
 * Actually performs database updates and API calls
 */
@Injectable()
export class ProductionAutomationAdapter implements AutomationAdapter {
  private readonly logger = new Logger(ProductionAutomationAdapter.name);

  constructor(
    @Inject(forwardRef(() => OrdersService))
    private readonly ordersService: OrdersService,
    private readonly whatsappApiService: WhatsappApiService,
    @InjectRepository(WhatsappTemplateEntity)
    private readonly templateRepo: Repository<WhatsappTemplateEntity>,
  ) {}

  async changeStatus(
    user: { adminId: string; id: string | null },
    orderId: string,
    data: { statusId: string; notes?: string },
  ) {
    await this.ordersService.changeStatus(user, orderId, data);

    return {
      success: true,
      orderId,
      newStatusId: data.statusId,
    };
  }

  async sendTemplateFromEntity(
    accountId: string,
    data: {
      to: string;
      template: any;
      components?: any[];
    },
  ) {
    const response = await this.whatsappApiService.sendTemplateFromEntity(accountId, data);
    const messageId = response.messages?.[0]?.id;

    return {
      success: true,
      messageId,
      recipient: data.to,
      templateId: data.template.id,
      templateName: data.template.name,
    };
  }

  async getTemplateById(templateId: string) {
    return this.templateRepo.findOne({
      where: { id: templateId },
      relations: ['account']
    });
  }

  async findStatusById(
    statusId: string,
    adminId: string,
    manager?: any,
  ) {
    return this.ordersService.findStatusById(statusId, adminId, manager);
  }
}
