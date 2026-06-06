import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { WhatsappTemplateEntity, WhatsappAccountEntity } from 'entities/whatsapp.entity';
import { Repository, In } from 'typeorm';
import { AutomationAdapter } from './automation-adapters.interface';
import { randomUUID } from 'crypto';
import { OrdersService } from 'src/orders/services/orders.service';
import { WhatsappInteractiveMessagePayload } from 'src/whatsapp/services/WhatsappApi.service';
import { Upsell, UpsellHistory } from 'entities/upsells.entity';
import { UpsellsService } from 'src/upsells/upsells.service';
import { OrderEntity } from 'entities/order.entity';
import { AutomationRunEntity } from 'entities/automation.entity';

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
    @InjectRepository(UpsellHistory)
    public readonly upsellHistoryRepo: Repository<UpsellHistory>,
    @Inject(forwardRef(() => OrdersService))
    public readonly ordersService: OrdersService,
  ) { }


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

  async sendTemplate(
    accountId: string,
    data: {
      to: string;
      templateId: string;
      headerVariables?: Record<string, any>;
      bodyVariables?: Record<string, any>;
      buttonVariables?: Record<string, any>;
      headerUrl?: string;
    },
    adminId?: string,
  ) {
    this.logger.log(`[PREVIEW] Skipping actual WhatsApp send to ${data.to} for template ID ${data.templateId}`);

    return {
      success: true,
      messageId: `preview-${randomUUID()}`,
      recipient: data.to,
      templateId: data.templateId,
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

  async sendUpsell(
    upsell: Upsell,
    order: OrderEntity,
    run?: AutomationRunEntity,
  ): Promise<UpsellHistory | null> {
    this.logger.log(`[PREVIEW] Skipping actual upsell send to ${order.phoneNumber} for upsell ID ${upsell.id}`);
    return null;
  }

  async getUpsellsForProducts(
    productIds: string[],
    adminId: string,
  ): Promise<Upsell[]> {
    const isMocked = productIds?.[0]?.startsWith('mock-');
    if (isMocked) {
      return [{
        id: randomUUID(),
      } as any];
    }

    return await this.upsellRepo.find({
      where: {
        triggerProductId: In(productIds),
        adminId: adminId,
        isActive: true,
      },
      relations: ['triggerProduct', 'upsellProduct', 'upsellSku'],
    });
  }
}
