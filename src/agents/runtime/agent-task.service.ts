import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import {
  AgentTaskEntity,
  AgentTaskStatus,
  AgentTaskType,
} from "entities/agent-conversation.entity";
import { AgentEntity } from "entities/agent.entity";
import { ConversationAiMode } from "entities/whatsapp.entity";
import { ConversationService } from "src/conversation/conversation.service";
import { AgentTurnQueueService } from "src/queue/queues/agent-turn.queue";
import { AutomationQueueService } from "src/queue/queues/automations.queue";
import { normalizeEgyptianPhoneNumber } from "common/whatsapp";

export type AddressIssue = {
  type: "missing_landmark" | "conflict" | "incomplete" | "unsupported_city";
  description: string;
};

@Injectable()
export class AgentTaskService {
  private readonly logger = new Logger(AgentTaskService.name);

  constructor(
    @InjectRepository(AgentTaskEntity)
    private readonly taskRepo: Repository<AgentTaskEntity>,
    @InjectRepository(AgentEntity)
    private readonly agentRepo: Repository<AgentEntity>,
    @Inject(forwardRef(() => ConversationService))
    private readonly conversations: ConversationService,
    @Inject(forwardRef(() => AgentTurnQueueService))
    private readonly agentTurns: AgentTurnQueueService,
    @Inject(forwardRef(() => AutomationQueueService))
    private readonly automations: AutomationQueueService,
  ) {}

  async getOpenForConversation(adminId: string, conversationId: string) {
    return this.taskRepo.findOne({
      where: {
        adminId,
        conversationId,
        status: In([AgentTaskStatus.OPEN, AgentTaskStatus.SUBMITTED]),
      },
      order: { createdAt: "DESC" },
    });
  }

  async getById(id: string) {
    return this.taskRepo.findOne({ where: { id } });
  }

  async startAddressHandoff(input: {
    adminId: string;
    agentId?: string | null;
    order: {
      id: string;
      orderNumber?: string;
      phoneNumber?: string | null;
      normalizedPhoneNumber?: string | null;
      customerName?: string | null;
      address?: string | null;
      city?: string | null;
      cityId?: string | null;
      area?: string | null;
      landmark?: string | null;
      latitude?: number | null;
      longitude?: number | null;
    };
    runId: string;
    nodeId: string;
    accountId?: string | null;
    issues: AddressIssue[];
    addresses?: any[];
    reason?: string;
    shipping: {
      shippingCompanyId?: string | null;
      shippingCompany?: string | null;
      provider?: string;
    };
    updateWrittenAddress: boolean;
    language: string;
  }): Promise<{ ok: true; task: AgentTaskEntity } | { ok: false; error: string }> {
    let agentId: string | null = null;
    if (input.agentId) {
      const agent = await this.agentRepo.findOne({
        where: { id: input.agentId, adminId: input.adminId, isActive: true },
      });
      if (!agent) {
        return { ok: false, error: "The selected WhatsApp agent is missing or inactive" };
      }
      agentId = agent.id;
    }

    const phone =
      input.order.normalizedPhoneNumber ||
      (input.order.phoneNumber ? normalizeEgyptianPhoneNumber(input.order.phoneNumber) : "");
    if (!phone) {
      return { ok: false, error: "Recipient phone number not found for address handoff" };
    }

    let conversation;
    try {
      conversation = await this.conversations.getOrCreateConversation(
        { id: input.adminId, adminId: input.adminId },
        { phoneNumber: phone, name: input.order.customerName || undefined },
      );
    } catch (error: any) {
      this.logger.warn(`Could not open conversation for address handoff: ${error?.message}`);
      return { ok: false, error: error?.message || "Could not open the WhatsApp conversation" };
    }
    if (!conversation?.id || !conversation.customerId) {
      return { ok: false, error: "Could not open the WhatsApp conversation" };
    }
    if (conversation.aiMode === ConversationAiMode.DISABLED) {
      return { ok: false, error: "AI replies are disabled for this conversation" };
    }

    await this.closeOpenForOrder(input.adminId, input.order.id, "replaced");

    const task = await this.taskRepo.save(
      this.taskRepo.create({
        adminId: input.adminId,
        conversationId: conversation.id,
        customerId: conversation.customerId,
        agentId,
        orderId: input.order.id,
        type: AgentTaskType.ADDRESS_CORRECTION,
        status: AgentTaskStatus.OPEN,
        automationRunId: input.runId,
        automationNodeId: input.nodeId,
        payload: {
          orderNumber: input.order.orderNumber,
          issues: input.issues,
          addresses: input.addresses ?? [],
          reason: input.reason,
          snapshot: {
            address: input.order.address,
            city: input.order.city,
            cityId: input.order.cityId,
            area: input.order.area,
            landmark: input.order.landmark,
            latitude: input.order.latitude,
            longitude: input.order.longitude,
          },
          shippingCompanyId: input.shipping.shippingCompanyId,
          shippingCompany: input.shipping.shippingCompany,
          provider: input.shipping.provider,
          updateWrittenAddress: input.updateWrittenAddress,
          language: input.language,
        },
      }),
    );

    const pauseMs = conversation.agentPausedUntil
      ? conversation.agentPausedUntil.getTime() - Date.now()
      : 0;
    await this.agentTurns.enqueueTaskStart(
      {
        adminId: input.adminId,
        accountId: input.accountId ?? null,
        conversationId: conversation.id,
        taskId: task.id,
      },
      pauseMs > 0 ? pauseMs : 0,
    );

    return { ok: true, task };
  }

  async submit(taskId: string, result: Record<string, any>) {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task || task.status !== AgentTaskStatus.OPEN) return task;
    task.status = AgentTaskStatus.SUBMITTED;
    task.result = result;
    await this.taskRepo.save(task);
    await this.automations.enqueueAgentTaskResume(task.adminId, {
      runId: task.automationRunId,
      nodeId: task.automationNodeId,
      taskId: task.id,
    });
    return task;
  }

  async close(taskId: string, reason: string) {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task || (task.status !== AgentTaskStatus.OPEN && task.status !== AgentTaskStatus.SUBMITTED)) {
      return task;
    }
    task.status = AgentTaskStatus.CLOSED;
    task.closedReason = reason;
    await this.taskRepo.save(task);
    await this.automations.enqueueAgentTaskResume(task.adminId, {
      runId: task.automationRunId,
      nodeId: task.automationNodeId,
      taskId: task.id,
    });
    return task;
  }

  async complete(taskId: string) {
    await this.taskRepo.update(
      { id: taskId, status: AgentTaskStatus.SUBMITTED },
      { status: AgentTaskStatus.COMPLETED },
    );
  }

  async closeOpenForOrder(adminId: string, orderId: string, reason: string) {
    await this.taskRepo.update(
      { adminId, orderId, status: In([AgentTaskStatus.OPEN, AgentTaskStatus.SUBMITTED]) },
      { status: AgentTaskStatus.CLOSED, closedReason: reason },
    );
  }

  async closeOpenForRun(runId: string, reason: string) {
    await this.taskRepo.update(
      { automationRunId: runId, status: In([AgentTaskStatus.OPEN, AgentTaskStatus.SUBMITTED]) },
      { status: AgentTaskStatus.CLOSED, closedReason: reason },
    );
  }
}
