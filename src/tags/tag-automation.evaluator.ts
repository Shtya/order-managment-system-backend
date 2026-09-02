import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { QueryRunner, Repository } from "typeorm";
import { OrderEntity, OrderItemEntity } from "entities/order.entity";
import { OrderAssignmentEntity } from "entities/assignment.entity";
import { ShipmentEntity } from "entities/shipping.entity";
import { UpsellHistory, UpsellStatus } from "entities/upsells.entity";
import {
  TagAssignmentSource,
  TagAutomationEntity,
  TagConditionLogic,
  TagConditionOperator,
  TagConditions,
  TagEntity,
} from "entities/tag.entity";
import {
  ClientSettingsEntity,
  OrderTagMode,
} from "entities/clientSettings.entity";
import { ClientSettingsService } from "src/client-settings/client-settings.service";
import { TagsAssignmentService } from "./tags-assignment.service";
import { TagAutomationQueueService } from "src/queue/queues/tag-automations.queue";
import { normalizeEgyptianPhoneNumber } from "common/whatsapp";

@Injectable()
export class TagAutomationEvaluator {
  private readonly logger = new Logger(TagAutomationEvaluator.name);

  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(TagAutomationEntity)
    private readonly automationRepo: Repository<TagAutomationEntity>,
    private readonly clientSettingsService: ClientSettingsService,
    private readonly assignmentService: TagsAssignmentService,
    @Inject(forwardRef(() => TagAutomationQueueService))
    private readonly tagAutomationQueue: TagAutomationQueueService,
  ) { }

  scheduleEvaluate(
    orderId: string,
    queryRunner?: QueryRunner | null,
  ) {
    const run = async () => {
      try {
        await this.evaluateOrder(orderId);
      } catch (error) {
        this.logger.error(
          `Tag automation evaluate failed for order ${orderId}`,
          error instanceof Error ? error.stack : error,
        );
      }
    };

    if (queryRunner) {
      if (!queryRunner.data.postCommitTasks) {
        queryRunner.data.postCommitTasks = [];
      }
      queryRunner.data.postCommitTasks.push(run);
      return;
    }

    void run();
  }

  async evaluateOrder(orderId: string) {
    if (!orderId) return;
    await this.tagAutomationQueue.enqueueEvaluateOrder(orderId);
  }

  async processEvaluateOrder(orderId: string) {
    const order = await this.orderRepo.findOne({
      where: { id: orderId },
      relations: ["status", "items"],
    });
    if (!order?.adminId) return;
    const adminId = order.adminId;

    const [settings, automations] = await Promise.all([
      this.clientSettingsService.getCachedSettings(adminId),
      this.automationRepo.find({
        where: { adminId, isEnabled: true },
        relations: ["tag"],
      }),
    ]);

    await this.applyAutomations(order, settings, automations);
  }

  async evaluateOrders(orderIds: string[]) {
    const uniqueOrderIds = [...new Set(orderIds.filter(Boolean))];
    if (!uniqueOrderIds.length) return;

    await Promise.all(
      uniqueOrderIds.map((orderId) => this.evaluateOrder(orderId)),
    );
  }

  private async applyAutomations(
    order: OrderEntity,
    settings: ClientSettingsEntity | null,
    automations: TagAutomationEntity[] | null,
    snapshotOverride?: Record<string, any>,
  ) {
    if (!order?.adminId) return;

    const resolvedSettings =
      settings ??
      (await this.clientSettingsService.getCachedSettings(order.adminId));
    if (resolvedSettings && resolvedSettings.tagAutomationsEnabled === false) {
      return;
    }

    const resolvedAutomations =
      automations ??
      (await this.automationRepo.find({
        where: { adminId: order.adminId, isEnabled: true },
        relations: ["tag"],
      }));
    if (!resolvedAutomations.length) return;

    const snapshot =
      snapshotOverride ?? (await this.buildSnapshot(order));
    const matching: TagEntity[] = [];
    const consideredTagIds = new Set<string>();

    for (const automation of resolvedAutomations) {
      if (!automation.tag?.isActive) continue;
      consideredTagIds.add(automation.tag.id);
      if (this.matches(automation.conditions, snapshot)) {
        matching.push(automation.tag);
      }
    }

    const removeUnmatched =
      resolvedSettings?.tagAutomationsRemoveUnmatched !== false;
    const matchingTagIds = new Set(matching.map((tag) => tag.id));
    const unmatchedTagIds = [...consideredTagIds].filter(
      (tagId) => !matchingTagIds.has(tagId),
    );

    if (!matching.length && !(removeUnmatched && unmatchedTagIds.length)) {
      return;
    }

    const mode = resolvedSettings?.orderTagMode || OrderTagMode.MANY;

    if (matching.length) {
      if (mode === OrderTagMode.ONE) {
        matching.sort((a, b) => {
          const byPriority = (b.priority || 0) - (a.priority || 0);
          if (byPriority !== 0) return byPriority;
          const byUpdated =
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
          if (byUpdated !== 0) return byUpdated;
          return String(b.id).localeCompare(String(a.id));
        });
        await this.assignmentService.assignTag({
          orderId: order.id,
          tagId: matching[0].id,
          adminId: order.adminId,
          source: TagAssignmentSource.AUTOMATIC,
        });
      } else {
        const uniqueTagIds = [...matchingTagIds];
        await Promise.all(
          uniqueTagIds.map((tagId) =>
            this.assignmentService.assignTag({
              orderId: order.id,
              tagId,
              adminId: order.adminId,
              source: TagAssignmentSource.AUTOMATIC,
            }),
          ),
        );
      }
    }

    if (removeUnmatched && unmatchedTagIds.length) {
      await this.assignmentService.removeAutomaticTags({
        orderId: order.id,
        adminId: order.adminId,
        tagIds: unmatchedTagIds,
      });
    }
  }

  private async buildSnapshot(order: OrderEntity) {
    const [latestShipment, latestUpsell, assignmentRow] = await Promise.all([
      this.orderRepo.manager.getRepository(ShipmentEntity).findOne({
        where: { orderId: order.id },
        order: { created_at: "DESC" },
      }),
      this.orderRepo.manager.getRepository(UpsellHistory).findOne({
        where: { orderId: order.id, adminId: order.adminId },
        order: { createdAt: "DESC" },
      }),
      this.orderRepo.manager
        .getRepository(OrderAssignmentEntity)
        .createQueryBuilder("assignment")
        .select("COALESCE(SUM(assignment.contactTries), 0)", "contactTries")
        .addSelect(
          "COALESCE(MAX(CASE WHEN assignment.isAssignmentActive = true THEN 1 ELSE 0 END), 0)",
          "hasActive",
        )
        .where("assignment.orderId = :orderId", { orderId: order.id })
        .cache(false)
        .getRawOne(),
    ]);

    return this.composeSnapshot(order, {
      contactTries: Number(assignmentRow?.contactTries || 0),
      hasActive: Number(assignmentRow?.hasActive || 0) === 1,
      shipmentStatus: latestShipment?.status ?? null,
      upsellAccepted: latestUpsell?.status === UpsellStatus.ACCEPTED,
    });
  }

  private composeSnapshot(
    order: OrderEntity,
    related: {
      contactTries: number;
      hasActive: boolean;
      shipmentStatus: any;
      upsellAccepted: boolean;
    },
  ) {
    const itemsQuantity = (order.items || []).reduce(
      (sum, item: OrderItemEntity) => sum + Number(item.quantity || 0),
      0,
    );
    const normalized = normalizeEgyptianPhoneNumber(order.phoneNumber || "");
    const phoneValid = /^201(0|1|2|5)\d{8}$/.test(normalized);

    return {
      "order.statusId": order.statusId,
      "order.storeId": order.storeId ?? null,
      "order.cityId": order.cityId ?? null,
      "order.paymentStatus": order.paymentStatus ?? null,
      "order.productsTotal": Number(order.productsTotal || 0),
      "order.itemsQuantity": itemsQuantity,
      "order.productsCount": (order.items || []).length,
      "order.shippingCompanyId": order.shippingCompanyId ?? null,
      "order.finalTotal": Number(order.finalTotal || 0),
      "order.discount": Number(order.discount || 0),
      "order.paymentMethod": order.paymentMethod ?? null,
      "order.allowOpenPackage": !!order.allowOpenPackage,
      "order.duplicateCount": Number(order.duplicateCount || 0),
      "order.isConfirmed": !!order.isConfirmed,
      "order.confirmationSource": order.confirmationSource ?? null,
      "assignment.contactTries": related.contactTries,
      "assignment.hasActive": related.hasActive,
      "shipment.status": related.shipmentStatus,
      "upsell.accepted": related.upsellAccepted,
      "order.phone.valid": phoneValid,
    };
  }

  private matches(
    conditions: TagConditions | null | undefined,
    snapshot: Record<string, any>,
  ) {
    const rules = (conditions?.rules || []).slice(0, 5);
    if (!rules.length) return false;

    const results = rules.map((rule) =>
      this.matchRule(snapshot[rule.field], rule.operator, rule.value),
    );

    if (conditions.logic === TagConditionLogic.OR) {
      return results.some(Boolean);
    }
    return results.every(Boolean);
  }

  private matchRule(actual: any, operator: string, expected: any) {
    switch (operator) {
      case TagConditionOperator.EQ:
        return this.normalize(actual) === this.normalize(expected);
      case TagConditionOperator.NEQ:
        return this.normalize(actual) !== this.normalize(expected);
      case TagConditionOperator.IN: {
        const list = Array.isArray(expected) ? expected : [expected];
        return list
          .map((v) => this.normalize(v))
          .includes(this.normalize(actual));
      }
      case TagConditionOperator.NOT_IN: {
        const list = Array.isArray(expected) ? expected : [expected];
        return !list
          .map((v) => this.normalize(v))
          .includes(this.normalize(actual));
      }
      case TagConditionOperator.IS_NULL:
        return actual === null || actual === undefined || actual === "";
      case TagConditionOperator.IS_NOT_NULL:
        return actual !== null && actual !== undefined && actual !== "";
      case TagConditionOperator.GTE:
        return Number(actual) >= Number(expected);
      case TagConditionOperator.LTE:
        return Number(actual) <= Number(expected);
      default:
        return false;
    }
  }

  private normalize(value: any) {
    if (value === true || value === "true") return "true";
    if (value === false || value === "false") return "false";
    if (value === null || value === undefined) return "";
    return String(value);
  }
}
