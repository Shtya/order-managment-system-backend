import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { OrdersService } from "src/orders/services/orders.service";
import {
  WhatsappApiService,
  WhatsappInteractiveMessagePayload,
  WhatsappSendInteractiveMessageInput,
} from "src/whatsapp/services/WhatsappApi.service";
import { InjectRepository } from "@nestjs/typeorm";
import {
  WhatsappTemplateEntity,
  WhatsappAccountEntity,
} from "entities/whatsapp.entity";
import { Repository, In } from "typeorm";
import { AutomationAdapter } from "./automation-adapters.interface";
import { Upsell, UpsellHistory } from "entities/upsells.entity";
import { WhatsappService } from "src/whatsapp/whatsapp.service";
import { OrderConfirmationSource, OrderEntity } from "entities/order.entity";
import { AutomationRunEntity } from "entities/automation.entity";
import { UpsellsService } from "src/upsells/upsells.service";
import { OrderAssignmentService } from "src/order-assignment/order-assignment.service";
import { SmsService } from "src/sms/sms.service";
import { isArray } from "class-validator";
import { IssueService } from "src/issue/issue.service";
import { IssuePriority } from "entities/issue.entity";
import { ShippingService } from "src/shipping/shipping.service";
import { CreateShipmentDto } from "dto/shipping.dto";
import { ClientService } from "src/clients/clients.service";

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
    @InjectRepository(WhatsappAccountEntity)
    private readonly accountRepo: Repository<WhatsappAccountEntity>,
    private readonly orderAssignmentService: OrderAssignmentService,
    private readonly smsService: SmsService,
    private readonly issueService: IssueService,
    @Inject(forwardRef(() => ShippingService))
    private readonly shippingService: ShippingService,
    @Inject(forwardRef(() => ClientService))
    private readonly clientService: ClientService,
  ) {}

  async changeStatus(
    user: { adminId: string; id: string | null },
    orderId: string,
    data: {
      statusId: string;
      notes?: string;
      confirmationSource?: OrderConfirmationSource;
      cancelCauseId?: string;
    },
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
        address: any;
        name: any;
      };
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

  async sendSms(
    user: { adminId: string; id: string | null },
    providerCode: string,
    dto: { toNumber: string; message: string; senderId?: string | null },
  ) {
    const result = await this.smsService.sendSms(
      {
        id: user.adminId,
        adminId: user.adminId,
        role: { name: "admin" },
      } as any,
      providerCode,
      dto as any,
    );

    return {
      log: isArray(result) ? result[0] : result,
    };
  }

  async getTemplateById(templateId: string) {
    return this.templateRepo.findOne({
      where: { id: templateId },
      relations: {
        account: true
      },
    });
  }

  async findStatusById(statusId: string, adminId: string, manager?: any) {
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
    orderItemVariantIds?: string[],
  ): Promise<Upsell[]> {
    if (orderItemVariantIds) {
      return await this.upsellsService.getUpsellsByProductIdsExcludingOrderItems(
        productIds,
        adminId,
        orderItemVariantIds,
      );
    }
    return await this.upsellsService.getUpsellsByProductIds(
      productIds,
      adminId,
    );
  }

  async manualAssign(
    employeeId: string,
    order: OrderEntity,
    adminId: string,
  ): Promise<string> {
    return await this.orderAssignmentService.manualAssign(
      employeeId,
      order,
      adminId,
    );
  }

  async processAutoAssignment(
    adminId: string,
    orders: OrderEntity[],
  ): Promise<{
    success?: boolean;
    message?: string;
    noActiveRules?: boolean;
    assignedCount: number;
    results?: Array<{
      orderId: string;
      orderNumber?: string;
      employeeId?: string;
      ruleName?: string;
    }>;
  }> {
    const ids = orders.map((order) => order.id);
    return this.orderAssignmentService.processAutoAssignment(adminId, ids);
  }

  async getWhatsappAccount(
    accountId: string,
  ): Promise<WhatsappAccountEntity | null> {
    return this.accountRepo.findOne({
      where: { id: accountId, isActive: true },
    });
  }

  async createIssue(
    user: { adminId: string; id: string | null },
    dto: {
      title: string;
      description?: string;
      orderId: string;
      causeId?: string | null;
      priority?: IssuePriority;
      statusId?: string | null;
      assignedRoleId: string;
      employeeIds?: string[];
      estimatedMinutes?: number;
    },
  ) {
    try {
      const result = await this.issueService.create(
        { ...user, adminId: user.adminId, role: { name: "admin" } } as any,
        dto as any,
      );

      return {
        success: true,
        issueId: result?.data?.id,
        issue: result?.data,
      };
    } catch (error: any) {
      this.logger.error(
        `Automation: failed to create issue: ${error?.message}`,
        error?.stack,
      );
      return {
        success: false,
      };
    }
  }

  async createShipment(
    user: { adminId: string; id: string | null; role?: any },
    providerCode: string,
    dto: CreateShipmentDto,
    orderId: string,
    options: { emitSocket?: boolean } = { emitSocket: false },
  ) {
    return this.shippingService.createShipment(
      user,
      providerCode as any,
      dto,
      orderId,
      options,
    );
  }

  async attachOrderToClient(
    user: { adminId: string; id: string | null },
    order: {
      id: string;
      adminId: string;
      phoneNumber?: string;
      customerName?: string;
      email?: string;
      clientId?: string | null;
    },
    options: { createIfMissing?: boolean },
  ) {
    const adminId = order.adminId || user.adminId;
    const me = {
      id: adminId,
      adminId,
      role: { name: "admin" },
    };
    const phoneNumber = String(order.phoneNumber || "").trim();
    if (!phoneNumber) {
      return {
        success: true,
        skipped: true,
        reason: "Missing phone number",
        clientId: order.clientId || null,
      };
    }

    let clientId = await this.clientService.findClientIdByPhone(
      adminId,
      phoneNumber,
    );
    let clientCreated = false;

    if (!clientId && options.createIfMissing) {
      const created = await this.clientService.create(me, {
        name: order.customerName?.trim() || phoneNumber,
        email: order.email?.trim() || undefined,
        contacts: [{ phoneNumber, isPrimary: true }],
      } as any);
      clientId = created?.id || null;
      clientCreated = !!clientId;
    }

    if (!clientId) {
      return {
        success: true,
        skipped: true,
        reason: "No client found",
        clientId: null,
        clientCreated: false,
      };
    }

    if (order.clientId === clientId) {
      return {
        success: true,
        skipped: true,
        reason: "Order already linked to a this client",
        clientId,
        clientCreated,
      };
    }
    
    if(order.clientId && order.clientId !== clientId) {
      return {
        success: false,
        error: "Order already linked to a different client",
      };
    }

    await this.ordersService.update(me, order.id, { clientId } as any);

    return {
      success: true,
      clientId,
      clientCreated,
    };
  }
}
