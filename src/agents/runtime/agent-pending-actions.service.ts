import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, LessThan, MoreThan, Repository } from "typeorm";
import {
  AgentPendingActionEntity,
  AgentPendingActionStatus,
  AgentPendingActionType,
} from "entities/agent-conversation.entity";
import { OrderStatus, PaymentMethod } from "entities/order.entity";
import { PublicCampaignOrdersService } from "src/campaigns/public-campaign-orders.service";
import { OrdersService } from "src/orders/services/orders.service";
import { AgentCampaignOffersService } from "./agent-campaign-offers.service";
import { AgentCatalogError, AgentCatalogService } from "./agent-catalog.service";
import { AgentSessionService } from "./agent-session.service";
import { AGENT_PENDING_ACTION_TTL_MS, AgentToolScope } from "./agent-runtime.constants";

export type AgentActionOutcome = {
  ok: boolean;
  code:
    | "EXECUTED"
    | "CANCELLED"
    | "NOT_FOUND"
    | "EXPIRED"
    | "NOT_SEEN_YET"
    | "ALREADY_DONE"
    | "NO_LONGER_VALID"
    | "EXECUTION_FAILED";
  actionId?: string;
  result?: Record<string, any>;
  error?: string;
};

@Injectable()
export class AgentPendingActionsService {
  private readonly logger = new Logger(AgentPendingActionsService.name);

  constructor(
    @InjectRepository(AgentPendingActionEntity)
    private readonly actionRepo: Repository<AgentPendingActionEntity>,
    private readonly campaignOffers: AgentCampaignOffersService,
    @Inject(forwardRef(() => PublicCampaignOrdersService))
    private readonly publicOrders: PublicCampaignOrdersService,
    @Inject(forwardRef(() => OrdersService))
    private readonly orders: OrdersService,
    private readonly catalog: AgentCatalogService,
    private readonly dataSource: DataSource,
    private readonly sessions: AgentSessionService,
  ) {}

  async listOpen(adminId: string, customerId: string): Promise<AgentPendingActionEntity[]> {
    await this.actionRepo.update(
      {
        adminId,
        customerId,
        status: AgentPendingActionStatus.PENDING,
        expiresAt: LessThan(new Date()),
      },
      { status: AgentPendingActionStatus.EXPIRED },
    );
    return this.actionRepo.find({
      where: {
        adminId,
        customerId,
        status: AgentPendingActionStatus.PENDING,
        expiresAt: MoreThan(new Date()),
      },
      order: { createdAt: "ASC" },
    });
  }

  /** Saves a new pending action; an older pending action for the same target is replaced. */
  async create(
    scope: AgentToolScope,
    input: {
      type: AgentPendingActionType;
      targetKey: string;
      payload: Record<string, any>;
      summary: string;
      orderId?: string | null;
    },
  ): Promise<AgentPendingActionEntity> {
    await this.actionRepo.update(
      {
        adminId: scope.adminId,
        customerId: scope.customerId,
        targetKey: input.targetKey,
        status: AgentPendingActionStatus.PENDING,
      },
      { status: AgentPendingActionStatus.REPLACED },
    );
    return this.actionRepo.save(
      this.actionRepo.create({
        adminId: scope.adminId,
        conversationId: scope.conversationId,
        customerId: scope.customerId,
        type: input.type,
        targetKey: input.targetKey,
        payload: input.payload,
        summary: input.summary,
        orderId: input.orderId ?? null,
        createdInTurnId: scope.turnId,
        status: AgentPendingActionStatus.PENDING,
        expiresAt: new Date(Date.now() + AGENT_PENDING_ACTION_TTL_MS),
      }),
    );
  }

  async attachSummaryMessage(actionId: string, wamid: string | null) {
    if (!wamid) return;
    await this.actionRepo.update(actionId, { summaryWamid: wamid });
  }

  async discard(actionId: string) {
    await this.actionRepo.update(
      { id: actionId, status: AgentPendingActionStatus.PENDING },
      { status: AgentPendingActionStatus.CANCELLED, error: "Summary could not be sent" },
    );
  }

  async cancel(scope: AgentToolScope, actionId: string): Promise<AgentActionOutcome> {
    const action = await this.findOwned(scope, actionId);
    if (!action) return { ok: false, code: "NOT_FOUND", error: "No such pending action for this customer." };
    if (action.status !== AgentPendingActionStatus.PENDING) {
      return { ok: false, code: "ALREADY_DONE", actionId, error: `The action is already ${action.status}.` };
    }
    await this.actionRepo.update(action.id, { status: AgentPendingActionStatus.CANCELLED });
    return { ok: true, code: "CANCELLED", actionId };
  }

  /**
   * Server checks before executing: the action belongs to this customer, is still pending and not
   * expired, was created in an earlier turn (the customer has seen the summary), and its data is still valid.
   */
  async confirm(scope: AgentToolScope, actionId: string): Promise<AgentActionOutcome> {
    const action = await this.findOwned(scope, actionId);
    if (!action) return { ok: false, code: "NOT_FOUND", error: "No such pending action for this customer." };

    if (action.status === AgentPendingActionStatus.EXECUTED) {
      return { ok: true, code: "EXECUTED", actionId, result: action.result ?? {} };
    }
    if (action.status !== AgentPendingActionStatus.PENDING) {
      return {
        ok: false,
        code: "ALREADY_DONE",
        actionId,
        error: `This action is ${action.status}; it can't be confirmed. Ask the customer again if needed.`,
      };
    }
    if (action.expiresAt.getTime() <= Date.now()) {
      await this.actionRepo.update(action.id, { status: AgentPendingActionStatus.EXPIRED });
      return { ok: false, code: "EXPIRED", actionId, error: "The confirmation expired. Collect the data and request it again." };
    }
    if (action.createdInTurnId === scope.turnId) {
      return {
        ok: false,
        code: "NOT_SEEN_YET",
        actionId,
        error: "The customer has not seen the summary yet. Wait for their confirmation in their next message.",
      };
    }

    await this.actionRepo.update(action.id, { confirmedAt: new Date() });
    try {
      const result = await this.execute(scope, action);
      await this.actionRepo.update(action.id, {
        status: AgentPendingActionStatus.EXECUTED,
        executedAt: new Date(),
        result,
        error: null,
      });
      return { ok: true, code: "EXECUTED", actionId, result };
    } catch (error) {
      const message = (error as any)?.response?.message ?? (error as Error)?.message ?? String(error);
      const text = Array.isArray(message) ? message.join("; ") : String(message);
      const invalid = [400, 404, 409].includes((error as any)?.status);
      await this.actionRepo.update(action.id, {
        status: invalid ? AgentPendingActionStatus.FAILED : AgentPendingActionStatus.PENDING,
        error: text,
      });
      this.logger.warn(`Pending action ${action.id} failed: ${text}`);
      return {
        ok: false,
        code: invalid ? "NO_LONGER_VALID" : "EXECUTION_FAILED",
        actionId,
        error: text,
      };
    }
  }

  private async execute(
    scope: AgentToolScope,
    action: AgentPendingActionEntity,
  ): Promise<Record<string, any>> {
    switch (action.type) {
      case AgentPendingActionType.CAMPAIGN_ORDER: {
        const p = action.payload;
        const recipient = await this.campaignOffers.getOwnedRecipient(scope, p.offerId);
        if (!recipient) {
          throw Object.assign(new Error("This offer is not available for this customer."), { status: 404 });
        }
        const placed = await this.publicOrders.submitForRecipient(scope.adminId, recipient.id, {
          customerName: p.customerName,
          address: p.address,
          city: p.city,
          cityId: p.cityId,
          area: p.area,
          areaId: p.areaId,
          landmark: p.landmark,
          customerNotes: p.customerNotes,
        });
        const result = {
          orderNumber: placed.orderNumber,
          total: placed.total,
          currency: placed.currency,
        };
        await this.sessions.addMemoryFact(
          scope.adminId,
          scope.customerId,
          `Order ${placed.orderNumber} created from campaign offer "${recipient.campaign?.name ?? ""}" (total ${placed.total} ${placed.currency}) on ${new Date().toISOString().slice(0, 10)}.`,
          scope.turnId,
        );
        return result;
      }
      case AgentPendingActionType.ORDER: {
        const p = action.payload;
        let draft;
        try {
          draft = await this.catalog.buildOrderDraft(scope.adminId, p.requested ?? [], p.priceFingerprint);
        } catch (error) {
          if (error instanceof AgentCatalogError) {
            throw Object.assign(new Error(error.message), { status: 409 });
          }
          throw error;
        }
        const me = { id: scope.adminId, adminId: scope.adminId };
        const saved = await this.dataSource.transaction(async (manager) => {
          return this.orders.createWithManager(
            manager,
            scope.adminId,
            me,
            {
              customerName: p.customerName,
              phoneNumber: scope.phoneNumber,
              clientId: p.clientId || undefined,
              address: p.address,
              city: p.city || "",
              cityId: p.cityId,
              area: p.area,
              areaId: p.areaId,
              landmark: p.landmark,
              customerNotes: p.customerNotes,
              paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
              shippingCost: Math.max(0, Number(p.shippingCost ?? 0) || 0),
              discount: Math.max(0, Number(p.discount ?? 0) || 0),
              items: draft.lines.map((l) => ({
                variantId: l.variantId,
                bundleId: l.bundleId,
                quantity: l.quantity,
                unitPrice: l.unitPrice,
              })),
            } as any,
            undefined,
            {
              statusCode: OrderStatus.CONFIRMED,
              skipDuplicateAutoCancel: true,
              markConfirmed: true,
            },
          );
        });
        const result = { orderNumber: saved.orderNumber, total: Number(saved.finalTotal ?? 0), currency: "" };
        await this.sessions.addMemoryFact(
          scope.adminId,
          scope.customerId,
          `Order ${saved.orderNumber} created via WhatsApp agent (total ${result.total}) on ${new Date().toISOString().slice(0, 10)}.`,
          scope.turnId,
        );
        return result;
      }
    }
    throw new Error(`Unknown action type ${action.type}`);
  }

  private findOwned(scope: AgentToolScope, actionId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(String(actionId ?? ""))) return Promise.resolve(null);
    return this.actionRepo.findOne({
      where: { id: actionId, adminId: scope.adminId, customerId: scope.customerId },
    });
  }
}
