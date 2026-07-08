// Preview engine backed by Redis.
// Stores a fully in-memory simulation of an automation run for 60 seconds.
// Frontend heartbeat should call touchPreview() periodically to keep the preview alive.
//
// This service keeps the traversal flow identical to production:
// - same node order
// - same condition branching rules
// - same pause/resume behavior for WhatsApp buttons
// - no database writes
// - no real WhatsApp sends / no order updates
//
// Integration notes:
// 1) Bind a Redis client to the REDIS_CLIENT token (ioredis or node-redis).
// 2) Call createPreview() when the user clicks "Preview".
// 3) Call touchPreview() from a socket heartbeat every ~30s.
// 4) Call resumeFromWhatsappInteraction() when a mock WhatsApp button is clicked in preview mode.

import { forwardRef, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  ActionType,
  AutomationFlowVersionEntity,
  ConditionType,
  ExecutionState,
  FlowDefinition,
  FlowEdge,
  FlowNode,
  FlowNodeDataType,
  NodeConfig,
  OrderCheckConfig,
  QuickOrderStatusConfig,
  RunStatus,
  SendWhatsappTemplateConfig,
  TriggerEntityType,
  TriggerType,
  UpdateOrderStatusConfig,
  VariableDetails,
} from 'entities/automation.entity';
import { OrderEntity } from 'entities/order.entity';
import { evaluateCondition, findNextNodeId } from './automation-helpers';
import { PreviewAutomationAdapter } from './adapters/preview.adapters';
import {
  ConditionQuickOrderStatusHandler,
  ConditionOrderCheckHandler,
  ActionUpdateOrderStatusHandler,
  ActionSendWhatsappTemplateMessageHandler,
  ActionSendUpsellHandler,
  ActionAssignOrderToEmployeeHandler,
  ActionSendWhatsappMessageHandler,
} from './nodeHandlers.registry';
import { OrdersService } from 'src/orders/services/orders.service';
import { InjectRepository } from '@nestjs/typeorm';
import { WhatsappAccountEntity, WhatsappMessageEntity, WhatsappTemplateEntity } from 'entities/whatsapp.entity';
import { DataSource, Repository } from 'typeorm';
import { AppGateway } from 'common/app.gateway';
import { RedisService } from 'common/redis/RedisService';
import { User } from 'entities/user.entity';
import { Upsell, UpsellHistory } from 'entities/upsells.entity';
import { OrderAssignmentEntity } from 'entities/assignment.entity';
import { OrderAssignmentService } from 'src/order-assignment/order-assignment.service';
import { UpsellsService } from 'src/upsells/upsells.service';

export interface CreatePreviewInput {
  adminId: string;
  automationFlowId: string;
  name: string,
  version: AutomationFlowVersionEntity | { id: string; versionString?: string; flow: FlowDefinition };
  trigger: {
    nodeId: string;
    type: TriggerType;
    output: any;
  };
  initialPayload?: any;
}

export interface PreviewHeartbeatResult {
  previewId: string;
  ttlSeconds: number;
  extended: boolean;
}

export interface PreviewResumeInput {
  previewId: string;
  buttonText: string;
  buttonId?: string;
}

export interface PreviewNodeHandlerResponse {
  success: boolean;
  output?: any;
  error?: string;
  chosenBranch?: string;
  shouldPause?: boolean;
}

export interface PreviewRunStep {
  type: FlowNodeDataType;
  executedAt: string;
  input?: any;
  output: any;
  chosenBranch?: string;
  success: boolean;
  error?: string;
}

export interface PreviewResumeState {
  nodeId: string;
  messageId: string;
  branches: SendWhatsappTemplateConfig['branches'];
  createdAt: string;
}

export interface PreviewRunDocument {
  previewId: string;
  adminId: string;
  automationFlowId: string;
  versionId: string;
  userId: string;
  versionString?: string;
  automationFlow: { id: string; name: string };
  status: RunStatus;
  currentNodeId: string | null;
  completedNodeIds: string[];
  errorMessage: string | null;
  completedAt?: Date;

  trigger: {
    nodeId: string;
    type: TriggerType;
    output: any;
  };
  initialPayload?: any;

  flow: FlowDefinition;
  executionState: ExecutionState;

  waitingForInteraction?: PreviewResumeState | null;
  triggerEntityType: TriggerEntityType;
  triggerEntityId: string;
  startedAt: string
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt: string;
}

@Injectable()
export class AutomationPreviewService {
  private readonly logger = new Logger(AutomationPreviewService.name);
  private readonly keyPrefix = 'automation:preview';
  private readonly ttlSeconds = 60;
  
  private readonly TRIGGER_TYPE_TO_ENTITY_MAP: Record<TriggerType, TriggerEntityType> = {
    [TriggerType.ORDER_CREATED]: TriggerEntityType.ORDER,
    [TriggerType.ORDER_UPDATED]: TriggerEntityType.ORDER,
    [TriggerType.SHIPMENT_CREATED]: TriggerEntityType.ORDER,
    [TriggerType.SHIPMENT_UPDATED]: TriggerEntityType.ORDER,
  };

  constructor(
    private readonly redis: RedisService,
    @Inject(forwardRef(() => OrdersService))
    private readonly ordersService: OrdersService,
    @InjectRepository(WhatsappTemplateEntity)
    private readonly templateRepo: Repository<WhatsappTemplateEntity>,
    private readonly gateway: AppGateway,
    @InjectRepository(WhatsappAccountEntity)
    private readonly accountRepo: Repository<WhatsappAccountEntity>,
    @InjectRepository(Upsell)
    private readonly upsellRepo: Repository<Upsell>,
    @InjectRepository(UpsellHistory)
    private readonly upsellHistoryRepo: Repository<UpsellHistory>,
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(OrderAssignmentEntity)
    private readonly orderAssignmentRepo: Repository<OrderAssignmentEntity>,
    @Inject(forwardRef(() => OrderAssignmentService))
    private readonly orderAssignmentService: OrderAssignmentService,
    private readonly dataSource: DataSource,
    @Inject(forwardRef(() => UpsellsService))
    private readonly upsellsService: UpsellsService,
    @InjectRepository(WhatsappMessageEntity)
    private readonly messageRepo: Repository<WhatsappMessageEntity>,
  ) { }

  /**
   * Create a new preview run in Redis and immediately execute it.
   * The whole preview is ephemeral and expires after 60 seconds unless heartbeated.
   */
  async createPreview(user: User, input: CreatePreviewInput): Promise<PreviewRunDocument> {
    const previewId = randomUUID();
    const now = new Date().toISOString();

    const doc: PreviewRunDocument = {
      previewId,
      adminId: input.adminId,
      userId: user.id,
      automationFlowId: input.automationFlowId,
      versionId: input.version.id,
      versionString: input.version.versionString,
      status: RunStatus.RUNNING,
      currentNodeId: null,
      completedNodeIds: [],
      errorMessage: null,
      trigger: input.trigger,
      initialPayload: input.initialPayload,
      flow: input.version.flow,
      automationFlow: {
        id: input.automationFlowId,
        name: input.name,
      },
      executionState: {
        trigger: input.trigger,
        steps: {},
      },
      triggerEntityType: this.TRIGGER_TYPE_TO_ENTITY_MAP[input.trigger.type],
      triggerEntityId: input.trigger.output?.__mock ? null : input.trigger.output?.id,
      waitingForInteraction: null,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
      lastHeartbeatAt: now,
    };

    const newPreview = await this.savePreview(doc);
    await this.emitPreviewUpdate(newPreview);
    await this.runPreview(previewId);

    return (await this.getPreview(previewId)) as PreviewRunDocument;
  }

  async getPreview(previewId: string): Promise<PreviewRunDocument | null> {
    const raw = await this.redis.get(this.key(previewId));
    return raw;
  }

  async deletePreview(previewId: string): Promise<void> {
    await this.redis.del(this.key(previewId));
  }

  /**
   * Heartbeat from the frontend.
   * Extends the preview TTL by another 60 seconds.
   */
  async touchPreview(previewId: string): Promise<PreviewHeartbeatResult> {
    const preview = await this.getPreview(previewId);
    if (!preview) {
      return { previewId, ttlSeconds: 0, extended: false };
    }

    preview.lastHeartbeatAt = new Date().toISOString();
    preview.updatedAt = preview.lastHeartbeatAt;
    await this.savePreview(preview);

    const ttlRaw = await this.redis.ttl(this.key(previewId));
    const ttlSeconds = typeof ttlRaw === 'number' ? ttlRaw : this.ttlSeconds;

    return {
      previewId,
      ttlSeconds,
      extended: ttlSeconds > 0,
    };
  }

  /**
   * Resume preview execution after a mock interaction (WhatsApp button, etc).
   */
  async resumePreview(input: PreviewResumeInput): Promise<PreviewRunDocument | null> {
    const preview = await this.getPreview(input.previewId);
    if (!preview) return null;

    if (preview.status !== RunStatus.PAUSED || !preview.waitingForInteraction) {
      this.logger.warn(`Preview ${input.previewId} is not paused or is missing a waiting interaction state.`);
      await this.emitPreviewUpdate(preview);
      return preview;
    }

    const waiting = preview.waitingForInteraction;
    if (!waiting.branches?.length) {
      await this.failPreview(preview, 'Preview cannot resume because no branches are configured for the WhatsApp node.');
      return preview;
    }

    const chosenBranch = waiting.branches.find((branch: any) =>
      branch?.id === input.buttonId ||
      branch?.text === input.buttonText ||
      branch?.label === input.buttonText,
    );

    if (!chosenBranch) {
      await this.failPreview(
        preview,
        `The clicked preview button "${input.buttonText}" does not match any configured branch.`,
      );
      return await this.getPreview(input.previewId);
    }

    preview.executionState.steps[waiting.nodeId] = {
      ...(preview.executionState.steps[waiting.nodeId] || {}),
      output: {
        ...(preview.executionState.steps[waiting.nodeId]?.output || {}),
        buttonClicked: input.buttonText,
        chosenBranchId: chosenBranch.id,
      },
      chosenBranch: chosenBranch.id,
      success: true,
      executedAt: new Date().toISOString(),
      type: preview.executionState.steps[waiting.nodeId]?.type ?? ActionType.SEND_WHATSAPP_TEMPLATE,
    } as PreviewRunStep;

    preview.waitingForInteraction = null;
    preview.status = RunStatus.RUNNING;
    preview.updatedAt = new Date().toISOString();
    await this.emitPreviewUpdate(preview);
    await this.savePreview(preview);

    await this.runPreview(preview.previewId, waiting.nodeId, chosenBranch.id);
    return await this.getPreview(preview.previewId);
  }

  /**
   * Continue executing the preview from a given node.
   * This method mirrors the production EngineRunnerService traversal.
   */
  async runPreview(previewId: string, resumedNodeId?: string, chosenBranchId?: string): Promise<void> {
    const preview = await this.getPreview(previewId);
    if (!preview) return;

    if (resumedNodeId) {
      // When resumed, keep the same traversal semantics as production:
      // continue from the node after the paused WhatsApp node.
      const nextNodeId = findNextNodeId(preview.flow.edges, resumedNodeId, chosenBranchId);
      if (!nextNodeId) {
        preview.status = RunStatus.COMPLETED;
        preview.currentNodeId = null;
        preview.updatedAt = new Date().toISOString();
        await this.savePreview(preview);
        await this.emitPreviewUpdate(preview);
        return;
      }
      await this.runLoop(preview, preview.flow, nextNodeId);

      return;
    }


    const firstNodeId = findNextNodeId(preview.flow.edges, preview.trigger.nodeId);
    if (!firstNodeId) {
      preview.status = RunStatus.COMPLETED;
      preview.currentNodeId = null;
      preview.updatedAt = new Date().toISOString();
      await this.savePreview(preview);
      await this.emitPreviewUpdate(preview);
      return;
    }

    await this.runLoop(preview, preview.flow, firstNodeId);
  }

  /**
   * حلقة التحكم بالتنفيذ (The Traversal Loop)
   */
  private async runLoop(preview: PreviewRunDocument, flow: FlowDefinition, startNodeId: string): Promise<void> {
    let currentNodeId = startNodeId;
    const completedNodeIds = [];
    if (preview.status === RunStatus.COMPLETED) return;

    while (currentNodeId) {
      const node = flow.nodes.find(n => n.id === currentNodeId);
      if (!node) {
        await this.failPreview(
          preview,
          `The automation could not continue because the one of the steps is missing or was removed from the workflow configuration.`,
        );
        return;
      }
      // infinite loop detection
      if (completedNodeIds.includes(currentNodeId)) {
        await this.failPreview(
          preview,
          `The automation detected an infinite loop at node ${node.data.label}.`,
        );
        return;
      }

      // 1. معالجة وحقن البيانات الخاصة بالإعدادات عبر الـ Hydrator
      // const hydratedConfig = this.hydrator.hydrate(node.data.config, run.executionState);

      try {
        // 3. Skip if already finished successfully
        const savedStep = preview.executionState.steps[currentNodeId];
        if (savedStep && savedStep.success) {
          this.logger.log(`Node ${currentNodeId} already completed successfully. Skipping to next.`);
          currentNodeId = findNextNodeId(flow.edges, currentNodeId, savedStep.chosenBranch);
          continue;
        }
        //add delay 1000ms to simulate real-time execution
        await new Promise(resolve => setTimeout(resolve, 1000));
        // 2. Track current node
        preview.currentNodeId = currentNodeId;
        await this.savePreview(preview);

        // 4. جلب الـ Handler المسؤول وتنفيذه
        const handler = this.registry.getHandler(node.data.type);
        const nodeConfig = node.data.config;
        // const result = await handler.execute(hydratedConfig, run);
        const result = await handler.execute(nodeConfig, preview);

        // 5. توثيق السجل والـ Step في قاعدة البيانات بـ Transaction واحد لضمان التزامن
        await this.saveStepResult(preview, node, result, nodeConfig);
        completedNodeIds.push(currentNodeId);
        await this.emitPreviewUpdate(preview);

        // 6. فحص ما إذا كانت الخطوة تطلب إيقاف مؤقت (مثل الانتظار لرد الواتساب)
        if (result.shouldPause) {
          preview.status = RunStatus.PAUSED;
          preview.waitingForInteraction = {
            nodeId: currentNodeId,
            messageId: result.output?.messageId || `preview-${randomUUID()}`,
            branches: (node.data.config as any)?.branches || [],
            createdAt: new Date().toISOString(),
          };
          await this.savePreview(preview);
          await this.emitPreviewUpdate(preview);
          this.logger.log(`Preview ${preview.previewId} is now PAUSED at node ${currentNodeId}`);
          return; // كسر الحلقة تماماً وفك الـ Thread
        }

        if (!result.success) {
          await this.failPreview(
            preview,
            result.error ||
            `The automation stopped because the step "${node.data.label}" could not be completed successfully.`,
          );
          return;
        }

        // 7. الانتقال للعقدة التالية بناءً على الـ edges والـ chosenBranch (إن وجد في حالات الشروط)
        currentNodeId = findNextNodeId(flow.edges, currentNodeId, result.chosenBranch);

      } catch (error) {
        await this.failPreview(
          preview,
          `An unexpected error occurred while executing the step "${node.data.label}". Please try again or review the automation configuration.`,
        );
        return;
      }
    }

    // إذا انتهت الحلقة ولم يعد هناك عقد تالية، تكتمل الأتمتة بنجاح
    preview.status = RunStatus.COMPLETED;
    preview.completedAt = new Date();
    preview.currentNodeId = null;
    await this.savePreview(preview);
    await this.emitPreviewUpdate(preview);
    this.logger.log(`Preview ${preview.previewId} completed successfully`);

    // Do not send notifications in preview mode
  }

  private async saveStepResult(preview: PreviewRunDocument, node: FlowNode, result: PreviewNodeHandlerResponse, input?: any) {
    preview.executionState.steps[node.id] = {
      type: node.data.type,
      executedAt: new Date().toISOString(),
      success: result.success,
      chosenBranch: result.chosenBranch,
      input: input || {},
      output: result.output || {},
      error: result.error,
    };

    if (result.success && !preview.completedNodeIds.includes(node.id)) {
      preview.completedNodeIds.push(node.id);
    }

    preview.updatedAt = new Date().toISOString();
    await this.savePreview(preview);
  }

  private async emitPreviewUpdate(preview: PreviewRunDocument): Promise<void> {
    try {
      this.gateway.server.to(`user_${preview.adminId || preview.userId}`).emit('automation:preview:update', {
        previewId: preview.previewId,
        status: preview.status,
        automationFlowId: preview.automationFlowId,
        currentNodeId: preview.currentNodeId,
        completedNodeIds: preview.completedNodeIds,
        executionState: preview.executionState,
        waitingForInteraction: preview.waitingForInteraction,
        updatedAt: preview.updatedAt,
      });
    } catch (error) {
      this.logger.error(`Failed to emit preview update: ${error.message}`);
    }
  }

  private async failPreview(preview: PreviewRunDocument, errorMessage: string): Promise<void> {
    preview.status = RunStatus.FAILED;
    preview.errorMessage = errorMessage;
    preview.updatedAt = new Date().toISOString();
    await this.savePreview(preview);
    await this.emitPreviewUpdate(preview);
    this.logger.error(`Preview ${preview.previewId} failed: ${errorMessage}`);
  }


  private key(previewId: string): string {
    return `${this.keyPrefix}:${previewId}`;
  }

  private async savePreview(preview: PreviewRunDocument): Promise<PreviewRunDocument> {
    preview.updatedAt = new Date().toISOString();
    const key = this.key(preview.previewId);
    const value = JSON.stringify(preview);

    await this.redis.set(key, value, this.ttlSeconds);
    return preview;
  }

  private registry = new PreviewNodeHandlersRegistry(
    new PreviewAutomationAdapter(this.templateRepo, this.accountRepo, this.upsellRepo, this.upsellHistoryRepo,this.userRepo, this.ordersService, this.orderAssignmentService, this.dataSource, this.upsellsService),
    this.orderRepo, 
    this.messageRepo,
    this.orderAssignmentRepo,
    this.ordersService,
  );
}

class PreviewNodeHandlersRegistry {
  private readonly handlers = new Map<FlowNodeDataType, any>();

  constructor(
    private readonly adapter: PreviewAutomationAdapter,
    @InjectRepository(OrderEntity)
    protected readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(WhatsappMessageEntity)
    private readonly messageRepo: Repository<WhatsappMessageEntity>,

    @InjectRepository(OrderAssignmentEntity)
    private readonly orderAssignmentRepo: Repository<OrderAssignmentEntity>,
    private readonly ordersService: OrdersService,
  ) {
    // Use production handlers with preview adapter injected
    this.handlers.set(ConditionType.QUICK_ORDER_STATUS, new ConditionQuickOrderStatusHandler(orderRepo));
    this.handlers.set(ConditionType.ORDER_CHECK, new ConditionOrderCheckHandler(orderRepo));
    this.handlers.set(
      ActionType.UPDATE_ORDER_STATUS,
      new ActionUpdateOrderStatusHandler(this.adapter,orderRepo),
    );
    this.handlers.set(
      ActionType.SEND_WHATSAPP_TEMPLATE,
      new ActionSendWhatsappTemplateMessageHandler(this.adapter,orderRepo, this.messageRepo),
    );

    this.handlers.set(
      ActionType.SEND_WHATSAPP_MESSAGE,
      new ActionSendWhatsappMessageHandler(this.adapter,orderRepo, this.messageRepo),
    );

    this.handlers.set(
      ActionType.SEND_UPSELL,
      new ActionSendUpsellHandler(this.adapter, this.orderRepo, this.messageRepo),
    );
    this.handlers.set(
      ActionType.ASSIGN_ORDER_TO_EMPLOYEE,
      new ActionAssignOrderToEmployeeHandler(this.adapter, this.orderRepo, this.orderAssignmentRepo, this.ordersService),
    );
  }

  getHandler(nodeType: FlowNodeDataType): any {
    const handler = this.handlers.get(nodeType);
    if (!handler) {
      throw new NotFoundException(`No preview handler registered for node type: ${nodeType}`);
    }
    return handler;
  }
}
