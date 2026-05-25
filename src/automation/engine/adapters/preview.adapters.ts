import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { WhatsappTemplateEntity, WhatsappAccountEntity } from 'entities/whatsapp.entity';
import { Repository, In } from 'typeorm';
import { AutomationAdapter } from './automation-adapters.interface';
import { randomUUID } from 'crypto';
import { OrdersService } from 'src/orders/services/orders.service';
import { WhatsappInteractiveMessagePayload } from 'src/whatsapp/services/WhatsappApi.service';
import { Upsell } from 'entities/upsells.entity';

/**
 * Preview implementation of AutomationAdapter
 * Returns mock data without side effects (no database updates, no API calls)
 */
@Injectable()
export class PreviewAutomationAdapter implements AutomationAdapter {
  private readonly logger = new Logger(PreviewAutomationAdapter.name);

  constructor(
    @InjectRepository(WhatsappTemplateEntity)
    public readonly templateRepo: Repository<WhatsappTemplateEntity>,
    @InjectRepository(WhatsappAccountEntity)
    public readonly accountRepo: Repository<WhatsappAccountEntity>,
    @InjectRepository(Upsell)
    public readonly upsellRepo: Repository<Upsell>,
    @Inject(forwardRef(() => OrdersService))
    public readonly ordersService: OrdersService,
  ) { }


  async sendInteractiveMessage(accountId: string, data: { to: string; interactive: any; }): Promise<{ success: boolean; messageId?: string; }> {
    this.logger.log(`[PREVIEW] Skipping actual interactive message send to ${data.to}`);
    return {
      success: true,
      messageId: `preview-${randomUUID()}`,
    };
  }


  async changeStatus(
    user: { adminId: string; id: string | null },
    orderId: string,
    data: { statusId: string; notes?: string },
  ) {
    this.logger.log(`[PREVIEW] Skipping actual status update for order ${orderId} to status ${data.statusId}`);

    return {
      success: true,
      orderId,
      newStatusId: data.statusId,
      previewMode: true,
      skippedSideEffect: true,
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
    this.logger.log(`[PREVIEW] Skipping actual WhatsApp send to ${data.to} for template ${data.template.name}`);

    return {
      success: true,
      messageId: `preview-${randomUUID()}`,
      recipient: data.to,
      templateId: data.template.id,
      templateName: data.template.name,
      previewMode: true,
      skippedSideEffect: true,
    };
  }

  async getTemplateById(templateId: string) {
    // In preview, we still need to fetch the actual template for validation
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
