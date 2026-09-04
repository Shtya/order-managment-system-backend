import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import {
  WhatsappTemplateEntity,
  WhatsappAccountEntity,
  WhatsappMessageEntity,
} from "entities/whatsapp.entity";
import { Repository, In, DataSource } from "typeorm";
import { AutomationAdapter } from "./automation-adapters.interface";
import { randomUUID } from "crypto";
import { OrdersService } from "src/orders/services/orders.service";
import { WhatsappInteractiveMessagePayload } from "src/whatsapp/services/WhatsappApi.service";
import { Upsell, UpsellHistory } from "entities/upsells.entity";
import { UpsellsService } from "src/upsells/upsells.service";
import { OrderConfirmationSource, OrderEntity } from "entities/order.entity";
import { AutomationRunEntity } from "entities/automation.entity";
import { User } from "entities/user.entity";
import { OrderAssignmentEntity } from "entities/assignment.entity";
import { OrderAssignmentService } from "src/order-assignment/order-assignment.service";
import { SmsSendLogEntity, SmsSendStatus } from "entities/sms.entity";
import { IssuePriority } from "entities/issue.entity";
import { CreateShipmentDto } from "dto/shipping.dto";

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
    @InjectRepository(User)
    public readonly userRepo: Repository<User>,
    @Inject(forwardRef(() => OrdersService))
    public readonly ordersService: OrdersService,
    @Inject(forwardRef(() => OrderAssignmentService))
    public readonly orderAssignmentService: OrderAssignmentService,
    private readonly dataSource: DataSource,
    @Inject(forwardRef(() => UpsellsService))
    public readonly upsellsService: UpsellsService,
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
    this.logger.log(
      `[PREVIEW] Skipping actual status update for order ${orderId} to status ${data.statusId}`,
    );

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
    this.logger.log(
      `[PREVIEW] Skipping actual WhatsApp send to ${data.to} for template ID ${data.templateId}`,
    );

    return {
      success: true,
      messageId: `preview-${randomUUID()}`,
      recipient: data.to,
      templateId: data.templateId,
      previewMode: true,
      skippedSideEffect: true,
    };
  }

  async sendSms(
    user: { adminId: string; id: string | null },
    providerCode: string,
    dto: { toNumber: string; message: string; senderId?: string | null },
  ) {
    this.logger.log(
      `[PREVIEW] Skipping actual SMS send to ${dto.toNumber} for provider ${providerCode}`,
    );

    const log: SmsSendLogEntity = {
      id: `preview-${randomUUID()}`,
      adminId: user.adminId,
      integrationId: null,
      providerCode: providerCode as any,
      providerId: null,
      toNumber: dto.toNumber,
      senderId: (dto.senderId as any) || null,
      message: dto.message,
      status: SmsSendStatus.SENT,
      providerMessageId: null,
      providerResponse: null,
      error: null,
      sent_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    } as any;

    return {
      log,
    };
  }

  async getTemplateById(templateId: string) {
    // In preview, we still need to fetch the actual template for validation
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
  ): Promise<UpsellHistory | null> {
    this.logger.log(
      `[PREVIEW] Skipping actual upsell send to ${order.phoneNumber} for upsell ID ${upsell.id}`,
    );
    return null;
  }

  async getUpsellsForProducts(
    productIds: string[],
    adminId: string,
    orderItemVariantIds?: string[],
  ): Promise<Upsell[]> {
    const isMocked = productIds?.[0]?.startsWith("mock-");
    if (isMocked) {
      return [
        {
          id: randomUUID(),
        } as any,
      ];
    }

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
    this.logger.log(
      `[PREVIEW] Running validation for manual assignment of order ${order.id} to employee ${employeeId}`,
    );

    return await this.dataSource.transaction(async (manager) => {
      // Verify employee exists and belongs to admin
      const employee = await manager.findOne(User, {
        where: { id: employeeId, adminId } as any,
      });
      if (!employee) {
        throw new NotFoundException("Employee not found");
      }

      // Verify order is free and eligible
      const freeOrder = await manager
        .createQueryBuilder(OrderEntity, "order")
        .innerJoin("order.status", "status")
        .leftJoin(
          "order.assignments",
          "assignment",
          "assignment.isAssignmentActive = :isActive",
          { isActive: true },
        )
        .where("order.id = :orderId", { orderId: order.id })
        .andWhere("assignment.id IS NULL")
        .getOne();

      if (!freeOrder) {
        return "not_eligable";
      }

      if (
        freeOrder.status &&
        !this.ordersService.ALLOWED_STATUS_CODES_FOR_ASSIGNMENT.has(
          freeOrder.status.code as any,
        )
      ) {
        return "not_eligable";
      }

      this.logger.log(
        `[PREVIEW] Validation passed, skipping actual assignment save`,
      );
      return "assigned";
    });
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
    return this.orderAssignmentService.previewAutoAssignment(adminId, orders);
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
    this.logger.log(
      `[PREVIEW] Skipping actual issue creation for "${dto.title}" on order ${dto.orderId}`,
    );

    const mockIssue = {
      id: randomUUID(),
      adminId: user.adminId,
      title: dto.title,
      description: dto.description ?? null,
      orderId: dto.orderId,
      causeId: dto.causeId ?? null,
      priority: dto.priority ?? "medium",
      statusId: dto.statusId ?? null,
      assignedRoleId: dto.assignedRoleId,
      estimatedMinutes: dto.estimatedMinutes ?? null,
      created_at: new Date(),
      updated_at: new Date(),
    } as any;

    return {
      success: true,
      issueId: mockIssue.id,
      issue: mockIssue,
      previewMode: true,
      skippedSideEffect: true,
    };
  }

  async createShipment(
    user: { adminId: string; id: string | null; role?: any },
    providerCode: string,
    dto: CreateShipmentDto,
    orderId: string,
    options: { emitSocket?: boolean } = { emitSocket: false },
  ) {
    this.logger.log(
      `[PREVIEW] Skipping actual shipment creation for order ${orderId} with provider ${providerCode}`,
    );

    return {
      id: `preview-${randomUUID()}`,
      orderId,
      providerCode,
      previewMode: true,
      skippedSideEffect: true,
    };
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
    this.logger.log(
      `[PREVIEW] Skipping attach order ${order.id} to client by phone ${order.phoneNumber || "n/a"} (createIfMissing=${!!options.createIfMissing})`,
    );

    return {
      success: true,
      skipped: !order.phoneNumber,
      reason: order.phoneNumber ? "preview" : "missing_phone",
      clientId: order.clientId || `preview-client-${randomUUID()}`,
      clientCreated: !!options.createIfMissing && !order.clientId,
      previewMode: true,
      skippedSideEffect: true,
    };
  }
}
