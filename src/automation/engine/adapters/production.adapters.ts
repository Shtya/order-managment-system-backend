import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { OrdersService } from 'src/orders/services/orders.service';
import { WhatsappApiService, WhatsappInteractiveMessagePayload, WhatsappSendInteractiveMessageInput } from 'src/whatsapp/services/WhatsappApi.service';
import { InjectRepository } from '@nestjs/typeorm';
import { WhatsappTemplateEntity, WhatsappAccountEntity } from 'entities/whatsapp.entity';
import { Repository, In } from 'typeorm';
import { AutomationAdapter } from './automation-adapters.interface';
import { Upsell, UpsellHistory } from 'entities/upsells.entity';
import { WhatsappService } from 'src/whatsapp/whatsapp.service';
import { OrderEntity } from 'entities/order.entity';
import { AutomationRunEntity } from 'entities/automation.entity';
import { UpsellsService } from 'src/upsells/upsells.service';

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
    @Inject(forwardRef(() => WhatsappService))
    private readonly whatsappService: WhatsappService,
    @Inject(forwardRef(() => UpsellsService))
    private readonly upsellsService: UpsellsService,
    @InjectRepository(WhatsappTemplateEntity)
    private readonly templateRepo: Repository<WhatsappTemplateEntity>,

  ) { }


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

  async sendTemplate(
    accountId: string,
    data: {
      to: string;
      templateId: string;
      headerVariables?: Record<string, any>;
      bodyVariables?: Record<string, any>;
      buttonVariables?: Record<string, any>;
      locationData: {
        latitude: string;
        longitude: string;
        address: any,
        name: any,
      }
      headerUrl?: string;
    },
    adminId?: string,
  ) {
    
    const response = await this.whatsappService.sendTemplate(
      { id: adminId, adminId } as any,
      data,
      accountId,
      
    );

    const messageId = response.messages?.[0]?.id;

    return {
      success: true,
      messageId,
      recipient: data.to,
      templateId: data.templateId,
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

 

  async sendUpsell(
    upsell: Upsell,
    order: OrderEntity,
    run?: AutomationRunEntity,
  ) {
    return await this.upsellsService.sendUpsell(upsell, order, run);
  }

  async getUpsellsForProducts(
    productIds: string[],
    adminId: string,
  ): Promise<Upsell[]> {
    return await this.upsellsService.getUpsellsByProductIds(productIds, adminId);
  }
}
