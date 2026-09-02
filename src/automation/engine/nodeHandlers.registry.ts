// factory pattern. A registry that holds the actual execution logic for each FlowNodeType (e.g., WhatsappHandler, UpdateOrderStatusHandler, ConditionHandler).
// The engine just says registry.execute(nodeType, hydratedConfig).

import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from "@nestjs/common";
import {
  ActionType,
  AiAddressCorrectionConfig,
  AssignOrderToEmployeeConfig,
  AssignShippingProviderConfig,
  AutomationRunEntity,
  ConditionType,
  CreateIssueConfig,
  AssignOrderToClientConfig,
  FlowNodeDataType,
  OrderCheckConfig,
  QuickOrderStatusConfig,
  SendSmsConfig,
  SendUpsellConfig,
  SendWhatsappMessageConfig,
  SendWhatsappTemplateConfig,
  TriggerType,
  UpdateOrderStatusConfig,
  WaitConfig,
} from "entities/automation.entity";
import { OrderConfirmationSource, OrderEntity, OrderStatus } from "entities/order.entity";
import {
  MessageActionIntent,
  MessageActionStatus,
  MessageStatus,
  TemplateStatus,
  WhatsappMessageEntity,
} from "entities/whatsapp.entity";

import {
  evaluateCondition,
  getActualFieldValue,
  getClientStatValue,
  isClientCheckField,
} from "./automation-helpers";
import { ClientService } from "src/clients/clients.service";
import { AutomationAdapter } from "./adapters/automation-adapters.interface";
import { ProductionAutomationAdapter } from "./adapters/production.adapters";
import { Repository } from "typeorm";
import { InjectRepository } from "@nestjs/typeorm";
import { normalizeEgyptianPhoneNumber } from "common/whatsapp";

import { OrderAssignmentEntity } from "entities/assignment.entity";
import { OrdersService } from "src/orders/services/orders.service";
import { getValueByPath } from "common/whatsapp.helper";
import { WhatsappService } from "src/whatsapp/whatsapp.service";
import { SmsSendStatus } from "entities/sms.entity";
import { Company, User } from "entities/user.entity";
import { Language } from "entities/clientSettings.entity";
import { ClientSettingsService } from "src/client-settings/client-settings.service";
import { AutomationQueueService } from "src/queue/queues/automations.queue";
import { AiOrchestratorService } from "src/ai/orchestrator/ai-orchestrator.service";
import { AiOrchestrationResult } from "src/ai/interfaces/ai-types";
import { AiModelAvailabilityEntity, AiModelEntity, AiProviderEntity } from "entities/ai.entity";

// Re-export for callers that previously imported from this module
export { ADDRESS_CHOICE_DELETED_BUTTON_ID } from "./automation-helpers";

const ADDRESS_CORRECTION_READ_TOOLS = [
  "get_city",
  "get_cities",
  "get_areas_by_city",
  "get_shipping_zones",
  "get_shipping_districts",
  "get_location_by_coordinates",
] as const;

const ADDRESS_CORRECTION_WRITE_TOOLS = [
  ...ADDRESS_CORRECTION_READ_TOOLS,
  "bulk_update_orders_shipping",
] as const;

const ADDRESS_CORRECTION_FIRST_PASS_TOOLS = [
  ...ADDRESS_CORRECTION_WRITE_TOOLS,
  "report_address_conflict",
] as const;

export type ConflictingAddressCandidate = {
  rowId: string;
  label: string;
  fullAddress: string;
  city?: string;
  area?: string;
  source?: string;
  latitude?: number;
  longitude?: number;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const pad2 = (n: number) => String(n).padStart(2, "0");

const MONTH_NAMES: Record<string, string[]> = {
  en: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
  ar: [
    "يناير",
    "فبراير",
    "مارس",
    "أبريل",
    "مايو",
    "يونيو",
    "يوليو",
    "أغسطس",
    "سبتمبر",
    "أكتوبر",
    "نوفمبر",
    "ديسمبر",
  ],
};
const MONTH_SHORT_NAMES: Record<string, string[]> = {
  en: [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ],
  ar: [
    "يناير",
    "فبراير",
    "مارس",
    "أبريل",
    "مايو",
    "يونيو",
    "يولي",
    "أغسطس",
    "سبتمبر",
    "أكتوبر",
    "نوفمبر",
    "ديسمبر",
  ],
};
const WEEKDAY_NAMES: Record<string, string[]> = {
  en: [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ],
  ar: ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"],
};
const WEEKDAY_SHORT_NAMES: Record<string, string[]> = {
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  ar: ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"],
};

/**
 * Formats a Date using a token format chosen by the user.
 * Numeric tokens: YYYY, YY, MM, M, DD, D.
 * Named tokens (localized by the admin's defaultLang): Weekday, WeekdayShort,
 * Month, MonthShort — e.g. "Weekday D Month YYYY" -> "الأربعاء 22 يوليو 2026"
 * or "Wednesday 22 July 2026". Unknown characters pass through as-is.
 */
const formatDateWithFormat = (
  date: Date,
  format: string,
  lang: Language = Language.EN,
): string => {
  const l = lang === Language.AR ? Language.AR : Language.EN;
  const tokens: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    YY: String(date.getFullYear()).slice(-2),
    MM: pad2(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    DD: pad2(date.getDate()),
    D: String(date.getDate()),
    Weekday: WEEKDAY_NAMES[l][date.getDay()],
    WeekdayShort: WEEKDAY_SHORT_NAMES[l][date.getDay()],
    Month: MONTH_NAMES[l][date.getMonth()],
    MonthShort: MONTH_SHORT_NAMES[l][date.getMonth()],
  };
  return format.replace(
    /WeekdayShort|Weekday|MonthShort|Month|YYYY|YY|MM|M|DD|D/g,
    (m) => tokens[m] ?? m,
  );
};

const isWeekend = (date: Date): boolean => {
  const day = date.getDay();
  return day === 5 || day === 6; // Friday, Saturday
};

/**
 * Computes a date offset by a number of days relative to today.
 * 0 = today, positive = future, negative = past.
 * When excludeWeekends is true, weekends (Friday/Saturday) do NOT count
 * toward the offset: offset N lands on the N-th working day after today.
 * Because the weekend skip carries over, consecutive offsets always map to
 * distinct dates (e.g. from Monday: 4 -> Sun, 5 -> Mon, 6 -> Tue) instead
 * of several offsets collapsing onto the same weekend-adjusted date.
 */
const computeOffsetDate = (offset: number, excludeWeekends = false): Date => {
  const date = new Date();
  if (!Number.isFinite(offset)) return date;

  if (offset > 0) {
    let count = 0;
    while (count < offset) {
      date.setDate(date.getDate() + 1);
      if (!excludeWeekends || !isWeekend(date)) {
        count += 1;
      }
    }
  } else {
    // Past dates use plain calendar arithmetic.
    date.setDate(date.getDate() + offset);
  }
  return date;
};

interface GlobalContext {
  /** Pre-formatted "global.*" values (brand/company info + computed date). */
  values: Record<string, string>;
  /** Admin's default language, used to localize named date formats. */
  lang: Language;
  /** Whether computed dates should skip weekends (Friday/Saturday). */
  excludeWeekends?: boolean;
}

/**
 * Resolves a "global.*" variable path.
 * - global.date.<offset>.<format> -> computed date in the admin's language
 * - otherwise reads from the pre-loaded company context map.
 */
const resolveGlobalVariablePath = (
  variablePath: string,
  globalData?: GlobalContext,
): string => {
  const dateMatch = variablePath.match(/^global\.date\.(-?\d+)\.(.+)$/);
  if (dateMatch) {
    const offset = parseInt(dateMatch[1], 10);
    const format = dateMatch[2] || "DD-MM-YYYY";
    return formatDateWithFormat(
      computeOffsetDate(offset, globalData?.excludeWeekends),
      format,
      globalData?.lang,
    );
  }
  return globalData?.values?.[variablePath] ?? "";
};

/**
 * Loads the admin's company (brand) context so "global.*" variables can be
 * resolved at send time. Also reads the admin's default language via the
 * cached client settings to localize named date formats. Returns undefined
 * when unavailable (e.g. preview).
 */
const loadGlobalData = async (
  userRepo?: Repository<User>,
  adminId?: string,
  clientSettingsService?: ClientSettingsService,
): Promise<GlobalContext | undefined> => {
  let lang = Language.EN;
  if (adminId && clientSettingsService) {
    try {
      const settings = await clientSettingsService.getCachedSettings(adminId);
      lang = settings?.defaultLang ?? Language.EN;
    } catch {
      // Fall back to English if settings cannot be resolved.
    }
  }

  if (!userRepo || !adminId) return undefined;
  try {
    const user = await userRepo.findOne({
      where: { id: adminId },
      relations: ["company"],
    });
    if (!user) return undefined;
    const company = user.company as Company | undefined;
    return {
      values: {
        "global.brandName": company?.name || user.name || "",
        "global.companyEmail": user.email || "",
        "global.companyWebsite": company?.website || "",
        "global.companyPhone": company?.phone || "",
        "global.companyAddress": company?.address || "",
        "global.companyCurrency": company?.currency || "",
      },
      lang,
    };
  } catch {
    return undefined;
  }
};

const checkMessageStatus = async (
  messageId: string,
  messageRepo: Repository<WhatsappMessageEntity>,
  logger: Logger,
) => {
  if (!messageId) {
    logger.warn("No message ID provided to check status");
    return;
  }

  const message = await messageRepo.findOne({ where: { messageId } });
  if (!message) {
    logger.warn(`Message with ID ${messageId} not found after 5 seconds`);
    return;
  }

  if (message.status === MessageStatus.FAILED) {
    const errorMsg = message.error || "Message sending failed";
    logger.error(`Message ${messageId} failed: ${errorMsg}`);
    throw new Error(`Failed to send WhatsApp message: ${errorMsg}`);
  }
};

export interface NodeHandlerResponse {
  success: boolean;
  output?: any;
  error?: string;
  resumeAfter?: number;
  // لتحديد المسار القادم في حال كانت العقدة عبارة عن شرط (Condition)
  chosenBranch?: string;
  // هل يجب إيقاف الأتمتة مؤقتاً بعد هذه الخطوة بانتظار حدث خارجي (مثل الواتساب)؟
  shouldPause?: boolean;
}

export abstract class FlowNodeHandler {
  constructor(
    @InjectRepository(OrderEntity)
    protected readonly orderRepo: Repository<OrderEntity>,
  ) { }
  abstract execute(
    config: any,
    run: AutomationRunEntity,
  ): Promise<NodeHandlerResponse>;

  protected deepReplaceVariables(
    data: any,
    orderData: any,
    globalData?: GlobalContext,
  ): any {
    if (typeof data === "string") {
      return data.replace(/\{\{([^}]+)\}\}/g, (_, variablePath) => {
        const path = variablePath.trim();

        // Global variables (brand/company info + computed date) are
        // resolved outside the order object.
        if (path.startsWith("global.")) {
          return resolveGlobalVariablePath(path, globalData);
        }

        const value = getValueByPath(orderData, path);

        if (value == null || value === undefined) {
          return "";
        }

        if (value instanceof Date) {
          return value.toLocaleString("en-GB", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
          });
        }

        if (typeof value === "string") {
          const date = new Date(value);
          if (!isNaN(date.getTime())) {
            return date.toLocaleString("en-GB", {
              day: "2-digit",
              month: "2-digit",
              year: "numeric",
            });
          }
        }

        return String(value);
      });
    } else if (Array.isArray(data)) {
      return data.map((item) =>
        this.deepReplaceVariables(item, orderData, globalData),
      );
    } else if (data && typeof data === "object") {
      const result: any = {};
      for (const key in data) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
          result[key] = this.deepReplaceVariables(
            data[key],
            orderData,
            globalData,
          );
        }
      }
      return result;
    }
    return data;
  }

  async getOrder(orderData: any): Promise<OrderEntity> {
    const id = orderData?.id;
    const isMocked = orderData?.__mock;
    if (isMocked) {
      return orderData;
    }

    if (!id) {
      throw new Error("Order ID is required");
    }
    if (!this.orderRepo) {
      throw new Error("Order repository is not available");
    }
    const order = await this.orderRepo.findOne({
      where: { id },
      relations: [
        "status",
        "items",
        "items.variant",
        "items.variant.product",
        "store",
        "shippingCompany",
        "replacementResult",
      ],
    });
    if (!order) {
      throw new NotFoundException(`Order with ID ${id} not found`);
    }
    return order;
  }
}

@Injectable()
export class ConditionQuickOrderStatusHandler extends FlowNodeHandler {
  private readonly logger = new Logger(ConditionQuickOrderStatusHandler.name);

  constructor(
    @InjectRepository(OrderEntity)
    protected readonly orderRepo: Repository<OrderEntity>,
  ) {
    super(orderRepo);
  }

  async execute(
    hydratedConfig: QuickOrderStatusConfig,
    run: AutomationRunEntity,
  ): Promise<NodeHandlerResponse> {
    try {
      // 1. Get latest order data from database, or use old data for preview
      const orderData = await this.getOrder(run.executionState.trigger.output);

      if (!orderData) {
        return {
          success: false,
          shouldPause: false,
          error: "The order data required for this condition is unavailable.",
        };
      }

      // 2. Compare current order status
      const currentStatusId = orderData.statusId;
      const targetStatusId = hydratedConfig.statusId;

      const isMatched =
        currentStatusId && targetStatusId && currentStatusId === targetStatusId;

      // 3. Choose next branch
      const chosenBranch = isMatched ? "true" : "false";

      return {
        success: true,
        shouldPause: false,
        chosenBranch,

        output: {
          orderId: orderData.id,
          orderNumber: orderData.orderNumber,

          currentStatusId,
          targetStatusId,

          matched: isMatched,
        },
      };
    } catch (error) {
      this.logger.error(
        `Error executing quick order status condition: ${error?.message}`,
        error?.stack,
      );

      return {
        success: false,
        shouldPause: false,
        error:
          "The order status condition could not be evaluated successfully.",
      };
    }
  }
}

@Injectable()
export class ConditionOrderCheckHandler extends FlowNodeHandler {
  private readonly logger = new Logger(ConditionOrderCheckHandler.name);

  constructor(
    @InjectRepository(OrderEntity)
    protected readonly orderRepo: Repository<OrderEntity>,
    private readonly ordersService: OrdersService,
    private readonly clientsService: ClientService,
  ) {
    super(orderRepo);
  }

  private async resolveCheckValue(
    check: { field: string },
    orderData: OrderEntity | any,
    clientStats: Record<string, number> | null,
  ): Promise<any> {
    if (isClientCheckField(check.field)) {
      if (orderData?.__mock) {
        return 0;
      }
      return getClientStatValue(check.field, clientStats);
    }

    if (check.field === "hasEnoughStock") {
      if (orderData?.__mock) {
        return true;
      }

      return this.ordersService.isStockSufficientForOrder(orderData, {
        // Replacement orders are already reserved; check physical stock like manifest/shipping.
        // Non-replacement orders use available stock (same as create/update validation).
      });
    }

    return getActualFieldValue(check.field, orderData);
  }

  async execute(
    hydratedConfig: OrderCheckConfig,
    run: AutomationRunEntity,
  ): Promise<NodeHandlerResponse> {
    try {
      // 1. جلب بيانات الطلب من قاعدة البيانات (أحدث نسخة), أو استخدم البيانات القديمة للمعاينة
      const orderData = await this.getOrder(run.executionState.trigger.output);
      if (!orderData) {
        return {
          success: false,
          shouldPause: false,
          error:
            "The order data required for order check condition is unavailable.",
        };
      }

      const checks = hydratedConfig.checks || [];
      const needsClientStats = checks.some((check) =>
        isClientCheckField(check.field),
      );
      let clientStats: Record<string, number> | null = null;
      if (
        needsClientStats &&
        orderData?.clientId &&
        orderData?.adminId &&
        !(orderData as any)?.__mock
      ) {
        clientStats = await this.clientsService.getOrderStatsSnapshot(
          orderData.adminId,
          orderData.clientId,
        );
      }

      const actualValues = await Promise.all(
        checks.map((check) =>
          this.resolveCheckValue(check, orderData, clientStats),
        ),
      );

      let allChecksPassed = true;

      // 2. المرور على جميع الشروط (المنطق هنا هو AND: يجب أن تتطابق جميع الشروط)
      for (let i = 0; i < checks.length; i++) {
        const check = checks[i];
        const actualValue = actualValues[i];
        const targetValue = check.targetValue; // القيمة المدخلة من المستخدم
        const operator = check.operator;

        const isMatch = evaluateCondition(
          actualValue,
          operator,
          targetValue,
          this.logger,
        );

        if (!isMatch) {
          allChecksPassed = false;
          break; // توفير للذاكرة: إذا فشل شرط واحد، لا داعي لفحص الباقي
        }
      }

      // 3. تحديد المسار القادم بناءً على نتيجة الفحص
      const chosenBranch = allChecksPassed ? "true" : "false";

      return {
        success: true,
        shouldPause: false,
        chosenBranch, // 🌟 هذا هو المفتاح الذي يقرأه الـ EngineRunner ليعرف أي سهم سيتبع
        output: {
          evaluatedChecksCount: checks.length,
          passed: allChecksPassed,
          orderId: orderData.id, // للتوثيق في الـ Logs
          orderNumber: orderData.orderNumber,
        },
      };
    } catch (error) {
      this.logger.error(
        `Error executing Order Check condition: ${error.message}`,
      );
      return {
        success: false,
        shouldPause: false,
        error: `Condition evaluation failed: ${error.message}`,
      };
    }
  }
}

@Injectable()
export class ActionUpdateOrderStatusHandler extends FlowNodeHandler {
  private readonly logger = new Logger(ActionUpdateOrderStatusHandler.name);

  constructor(
    private readonly adapter: AutomationAdapter,
    @InjectRepository(OrderEntity)
    protected readonly orderRepo: Repository<OrderEntity>,
  ) {
    super(orderRepo);
  }

  async execute(
    hydratedConfig: UpdateOrderStatusConfig,
    run: AutomationRunEntity,
  ): Promise<NodeHandlerResponse> {
    try {
      // 1. Get latest order data from database, or use old data for preview
      const orderData = await this.getOrder(run.executionState.trigger.output);

      if (!orderData?.id) {
        return {
          success: false,
          shouldPause: false,
          error:
            "The order information required to update the status is missing.",
        };
      }

      // 2. Validate target status
      const statusEntity = await this.adapter.findStatusById(
        hydratedConfig.newStatusId,
        orderData.adminId,
      );

      if (!statusEntity) {
        return {
          success: false,
          shouldPause: false,
          error:
            "The selected order status no longer exists or is unavailable.",
        };
      }

      // 3. Skip if already same status
      if (orderData.statusId === statusEntity.id) {
        return {
          success: true,
          shouldPause: false,
          output: {
            skipped: true,
            reason: "Order already has the target status.",
            orderId: orderData.id,
            statusId: statusEntity.id,
          },
        };
      }

      // 4. Execute status update using adapter
      await this.adapter.changeStatus(
        {
          adminId: run.initialPayload?.adminId,
          id: run.initialPayload?.userId || null,
        },
        orderData.id,
        {
          statusId: statusEntity.id,
          notes: `Updated automatically via automation`,
          confirmationSource: OrderConfirmationSource.WHATSAPP,
          ...(statusEntity.code === OrderStatus.CANCELLED &&
          hydratedConfig.cancelCauseId
            ? { cancelCauseId: hydratedConfig.cancelCauseId }
            : {}),
        },
      );

      // 5. Success response
      return {
        success: true,
        shouldPause: false,

        output: {
          orderId: orderData.id,
          orderNumber: orderData.orderNumber,

          previousStatusId: orderData.statusId,
          newStatusId: statusEntity.id,
          newStatusName: statusEntity.name,
        },
      };
    } catch (error) {
      this.logger.error(
        `Failed to update order status: ${error?.message}`,
        error?.stack,
      );

      return {
        success: false,
        shouldPause: false,
        error: "The order status could not be updated successfully.",
      };
    }
  }
}

@Injectable()
export class ActionAiAddressCorrectionHandler extends FlowNodeHandler {
  private readonly logger = new Logger(ActionAiAddressCorrectionHandler.name);

  constructor(
    @InjectRepository(OrderEntity)
    protected readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly aiOrchestrator: AiOrchestratorService,
    private readonly clientSettingsService: ClientSettingsService,
    @InjectRepository(AiProviderEntity)
    private readonly providerRepo: Repository<AiProviderEntity>,
    @InjectRepository(AiModelEntity)
    private readonly modelRepo: Repository<AiModelEntity>,
    @InjectRepository(AiModelAvailabilityEntity)
    private readonly availabilityRepo: Repository<AiModelAvailabilityEntity>,
    private readonly whatsappService?: WhatsappService,
    private readonly messageRepo?: Repository<WhatsappMessageEntity>,
  ) {
    super(orderRepo);
  }

  async execute(
    config: AiAddressCorrectionConfig,
    run: AutomationRunEntity,
  ): Promise<NodeHandlerResponse> {
    try {
      const priorOutput =
        run.executionState.steps?.[run.currentNodeId]?.output || {};

      // Second entry: customer already replied (or list deleted)
      if (
        priorOutput?.pendingAddressConflict &&
        priorOutput?.addressConflictResume
      ) {
        return this.completeAfterCustomerChoice(config, run, priorOutput, {
          buttonId: priorOutput.buttonId,
          buttonText: priorOutput.buttonText,
          deleted: !!priorOutput.addressChoiceDeleted,
        });
      }

      const orderData = await this.getOrder(run.executionState.trigger.output);
      if (!orderData?.id) {
        return {
          success: false,
          chosenBranch: "address_not_corrected",
          error: "Order information not available for address correction",
        };
      }

      const admin = await this.userRepo.findOne({
        where: { id: run.adminId },
        relations: ["role"],
      });

      if (!admin) {
        return {
          success: false,
          chosenBranch: "address_not_corrected",
          error: "Admin user not found",
        };
      }

      const providerError = await this.validateProviderAvailability(config, run);
      if (providerError) return providerError;

      const settings = await this.clientSettingsService.getSettings(admin);
      const defaultLang = settings?.defaultLang || "en";
      const prompt = this.buildPrompt(orderData, config);

      const chatResult = await this.aiOrchestrator.chat(admin, prompt, {
        acceptWriteOperations: true,
        allowedToolNames: [...ADDRESS_CORRECTION_FIRST_PASS_TOOLS],
        metadata: {
          orderId: orderData.id,
          orderNumber: orderData.orderNumber,
          shippingCompanyId: config.shippingCompanyId,
          shippingCompany: config.shippingCompany,
          provider: config.provider,
          updateWrittenAddress: shouldUpdateWrittenAddress(config),
        },
        model: config.modelCode,
        provider: config.providerCode,
        includeDevInfo: true,
        tenantLang: defaultLang,
      });

      const conflict = extractAddressConflict(chatResult);
      if (conflict) {
        return this.handleAddressConflict(
          orderData,
          config,
          chatResult,
          conflict.addresses,
          conflict.reason,
        );
      }

      return decideAddressCorrectionBranch(chatResult);
    } catch (error) {
      this.logger.error(
        `Failed to correct order address: ${error?.message}`,
        error?.stack,
      );

      return {
        success: false,
        chosenBranch: "address_not_corrected",
        error: error?.message || "Address correction failed",
      };
    }
  }

  /**
   * Completes a paused address-conflict wait after the customer picks a list row
   * (or after the outbound list message is deleted). Called only from execute().
   */
  private async completeAfterCustomerChoice(
    config: AiAddressCorrectionConfig,
    run: AutomationRunEntity,
    priorOutput: Record<string, any>,
    selection: { buttonId?: string; buttonText?: string; deleted?: boolean },
  ): Promise<NodeHandlerResponse> {
    const sanitizePrior = (out: Record<string, any>) => {
      const {
        aiHistory: _omitHistory,
        addressConflictResume: _omitResume,
        ...rest
      } = out || {};
      return rest;
    };

    try {
      if (!priorOutput?.pendingAddressConflict) {
        return {
          success: true,
          chosenBranch: "address_not_corrected",
          error: "No pending address conflict to resume",
          output: {
            ...sanitizePrior(priorOutput),
            pendingAddressConflict: false,
            addressConflictResume: false,
          },
        };
      }

      if (selection.deleted) {
        return {
          success: true,
          chosenBranch: "address_not_corrected",
          error: "Address choice message was deleted",
          output: {
            ...sanitizePrior(priorOutput),
            pendingAddressConflict: false,
            addressConflictResume: false,
            addressChoiceDeleted: true,
          },
        };
      }

      const orderData = await this.getOrder(run.executionState.trigger.output);
      if (!orderData?.id) {
        return {
          success: false,
          chosenBranch: "address_not_corrected",
          error: "Order information not available for address correction",
          output: {
            ...sanitizePrior(priorOutput),
            pendingAddressConflict: false,
            addressConflictResume: false,
          },
        };
      }

      const admin = await this.userRepo.findOne({
        where: { id: run.adminId },
        relations: ["role"],
      });
      if (!admin) {
        return {
          success: false,
          chosenBranch: "address_not_corrected",
          error: "Admin user not found",
          output: {
            ...sanitizePrior(priorOutput),
            pendingAddressConflict: false,
            addressConflictResume: false,
          },
        };
      }

      const conflictingAddresses = (priorOutput.conflictingAddresses ||
        []) as ConflictingAddressCandidate[];
      const selected =
        conflictingAddresses.find((a) => a.rowId === selection.buttonId) ||
        conflictingAddresses.find(
          (a) =>
            a.label === selection.buttonText ||
            a.fullAddress === selection.buttonText,
        );

      if (!selected) {
        return {
          success: true,
          chosenBranch: "address_not_corrected",
          error: "Customer selection did not match any conflicting address",
          output: {
            ...sanitizePrior(priorOutput),
            pendingAddressConflict: false,
            addressConflictResume: false,
            buttonClicked: selection.buttonText,
            buttonId: selection.buttonId,
          },
        };
      }

      const settings = await this.clientSettingsService.getSettings(admin);
      const defaultLang = settings?.defaultLang || "en";
      const resumePrompt = this.buildResumePrompt(
        orderData,
        config,
        conflictingAddresses,
        selected,
        selection,
      );

      const history = priorOutput.aiSessionId
        ? await this.aiOrchestrator.getSessionHistory(priorOutput.aiSessionId)
        : [];

      const chatResult = await this.aiOrchestrator.chat(admin, resumePrompt, {
        acceptWriteOperations: true,
        allowedToolNames: [...ADDRESS_CORRECTION_WRITE_TOOLS],
        history,
        metadata: {
          orderId: orderData.id,
          orderNumber: orderData.orderNumber,
          shippingCompanyId: config.shippingCompanyId,
          shippingCompany: config.shippingCompany,
          provider: config.provider,
          customerSelectedRowId: selected.rowId,
          updateWrittenAddress: shouldUpdateWrittenAddress(config),
        },
        model: config.modelCode,
        provider: config.providerCode,
        includeDevInfo: true,
        tenantLang: defaultLang,
      });

      const result = decideAddressCorrectionBranch(chatResult);
      result.output = {
        ...sanitizePrior(priorOutput),
        ...(result.output || {}),
        pendingAddressConflict: false,
        addressConflictResume: false,
        buttonClicked: selection.buttonText,
        buttonId: selection.buttonId,
        customerSelectedAddress: selected,
      };

      await this.markAddressChoiceMessageCompleted(priorOutput.messageId);

      return result;
    } catch (error) {
      this.logger.error(
        `Failed to resume address correction after customer choice: ${error?.message}`,
        error?.stack,
      );
      return {
        success: false,
        chosenBranch: "address_not_corrected",
        error: error?.message || "Address correction resume failed",
        output: {
          ...sanitizePrior(priorOutput),
          pendingAddressConflict: false,
          addressConflictResume: false,
        },
      };
    }
  }
  private async handleAddressConflict(
    orderData: any,
    config: AiAddressCorrectionConfig,
    chatResult: AiOrchestrationResult,
    rawAddresses: any[],
    reason: string | undefined,
  ): Promise<NodeHandlerResponse> {
    const candidates = normalizeConflictAddresses(rawAddresses);
    if (candidates.length < 2) {
      return {
        success: true,
        chosenBranch: "address_not_corrected",
        error: "Address conflict reported but fewer than 2 usable addresses",
        output: { aiComment: chatResult.content, reason },
      };
    }

    const to = orderData.normalizedPhoneNumber
      ? orderData.normalizedPhoneNumber
      : orderData.phoneNumber
        ? normalizeEgyptianPhoneNumber(orderData.phoneNumber)
        : null;

    if (!to) {
      return {
        success: true,
        chosenBranch: "address_not_corrected",
        error: "Recipient phone number not found for address conflict list",
        output: { aiComment: chatResult.content, conflictingAddresses: candidates },
      };
    }

    if (!this.whatsappService) {
      return {
        success: true,
        chosenBranch: "address_not_corrected",
        error: "WhatsApp service unavailable for address conflict list",
        output: { aiComment: chatResult.content, conflictingAddresses: candidates },
      };
    }

    const payload: any = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: {
          text: "لقينا أكتر من عنوان للطلب. اختار العنوان الصحيح من القائمة.",
        },
        action: {
          button: "عرض العناوين",
          sections: [
            {
              title: "العناوين",
              rows: candidates.map((a) => ({
                id: a.rowId,
                title: truncateWhatsappText(a.label, 24),
                description: truncateWhatsappText(a.fullAddress, 72),
              })),
            },
          ],
        },
      },
      metadata: {
        addressConflictChoice: true,
      },
    };

    try {
      const response = await this.whatsappService.sendMessage(
        { adminId: orderData.adminId },
        payload,
        undefined,
        undefined,
        MessageActionIntent.BRANCHES,
        orderData.id,
      );
      const messageId = response?.messages?.[0]?.id;
      if (!messageId) {
        return {
          success: true,
          chosenBranch: "address_not_corrected",
          error: "Failed to send address conflict list (no message id)",
          output: {
            aiComment: chatResult.content,
            conflictingAddresses: candidates,
          },
        };
      }

      await wait(4000);
      if (this.messageRepo) {
        await checkMessageStatus(messageId, this.messageRepo, this.logger);
      }

      return {
        success: true,
        shouldPause: true,
        output: {
          messageId,
          pendingAddressConflict: true,
          conflictingAddresses: candidates,
          conflictReason: reason,
          // Resume loads prompt/comment from ai_request_summaries via sessionId
          aiSessionId: chatResult.sessionId,
          orderId: orderData.id,
          aiComment: chatResult.content,
          shippingCompany: config.shippingCompany,
          provider: config.provider,
        },
      };
    } catch (error) {
      this.logger.error(
        `Failed to send address conflict list: ${error?.message}`,
        error?.stack,
      );
      return {
        success: true,
        chosenBranch: "address_not_corrected",
        error: error?.message || "Failed to send address conflict list",
        output: {
          aiComment: chatResult.content,
          conflictingAddresses: candidates,
        },
      };
    }
  }

  private async validateProviderAvailability(
    config: AiAddressCorrectionConfig,
    run: AutomationRunEntity,
  ): Promise<NodeHandlerResponse | null> {
    if (!(config.providerCode || config.providerId || config.modelCode)) {
      return null;
    }

    const qb = this.providerRepo
      .createQueryBuilder("provider")
      .leftJoin(
        "provider.models",
        "model",
        config.modelCode ? "model.modelCode = :modelCode" : "1 = 0",
        { modelCode: config.modelCode },
      )
      .leftJoin(
        "model.availabilities",
        "availability",
        run.adminId ? "availability.adminId = :adminId" : "1 = 0",
        { adminId: run.adminId },
      )
      .where("provider.isActive = true");

    if (config.providerCode || config.providerId) {
      qb.andWhere(
        "(LOWER(provider.code) = LOWER(:providerCode) OR provider.id = :providerId)",
        {
          providerCode: config.providerCode ?? null,
          providerId: config.providerId ?? null,
        },
      );
    }

    const provider = await qb
      .select([
        "provider.id",
        "provider.code",
        "model.id",
        "model.modelCode",
        "availability.id",
        "availability.isAvailable",
      ])
      .getOne();

    if (!provider) {
      return {
        success: false,
        chosenBranch: "address_not_corrected",
        error: `AI provider '${config.providerCode || config.providerId}' not found or inactive`,
      };
    }

    if (config.modelCode) {
      const model = provider.models?.[0];
      const availability = model?.availabilities?.[0];
      if (model && availability?.isAvailable === false) {
        return {
          success: false,
          chosenBranch: "address_not_corrected",
          error: `AI model '${config.modelCode}' is not available for this tenant`,
        };
      }
    }

    return null;
  }

  private async markAddressChoiceMessageCompleted(messageId?: string) {
    if (!messageId || !this.messageRepo) return;
    try {
      const message = await this.messageRepo.findOne({ where: { messageId } });
      if (!message) return;
      message.actionStatus = MessageActionStatus.COMPLETED;
      message.actionCompletedAt = new Date();
      await this.messageRepo.save(message);
    } catch (error) {
      this.logger.warn(
        `Failed to mark address choice message completed: ${error?.message}`,
      );
    }
  }

  private buildPrompt(orderData: any, config: AiAddressCorrectionConfig): string {
    const shippingCompanyInfo = config.shippingCompany
      ? `\n- Selected Shipping Company: ${config.shippingCompany} (${config.provider})`
      : "";
    const updateWritten = shouldUpdateWrittenAddress(config);

    const locationAddress = orderData.locationAddress || "";
    const locationName = orderData.locationName || "";
    const latitude = orderData.latitude;
    const longitude = orderData.longitude;
    const address = orderData.address || "";
    const city = orderData.city || "";
    const area = orderData.area || "";
    const landmark = orderData.landmark || "";

    const writtenAddressRules = updateWritten
      ? `## Writing the \`address\` field (CRITICAL)
When calling \`bulk_update_orders_shipping\`, \`address\` must be a **normal full written shipping address** a courier can read — never append coordinates.
- **Never** put latitude/longitude inside \`address\` (bad: "العريش، شمال سيناء، مصر (موقع على الخريطة: 31.135, 33.814)")
- Coordinates stay in tools/metadata only; \`address\` is plain text only
- **Bad (too short):** "العريش، شمال سيناء، مصر" or only city + governorate + country — unless that is all that exists for a chosen map pin and you have no richer \`locationAddress\`/\`locationName\`
- **Good:** street/road, neighborhood/area, landmark if available, building/details, then city/governorate — e.g. from \`locationAddress\` / \`locationName\` / reverse-geocode result
- If \`latitude\` and \`longitude\` exist, call \`get_location_by_coordinates\`
- If the tool returns \`isSparse: true\`, prefer \`locationAddress\` / \`locationName\` for the written \`address\` when updating after the customer chooses that pin; still use sparse reverse-geocode for \`cityId\` / zone / district
- Prefer the richest available text in this order:
  1. \`locationAddress\` / \`locationName\` on the order (if detailed)
  2. reverse-geocode \`composedAddress\` / \`displayName\` when \`hasStreetLevelDetail\` is true
  3. combine useful parts (road + district + city) when available
- Never replace a more detailed existing \`locationAddress\` with a shorter reverse-geocode city string unless the customer explicitly chose the map location`
      : `## Written \`address\` field (DISABLED for this run)
The client setting **updateWrittenAddress is false**.
- You **must NOT** set or change the written \`address\` field
- When calling \`bulk_update_orders_shipping\`, omit \`address\` entirely — update only \`cityId\` and \`shippingMetadata\` (zoneId, districtId)
- Still use location/address sources to decide city / zone / district`;

    const updateTaskStep = updateWritten
      ? `8. Update using \`bulk_update_orders_shipping\` with:
   - \`code\`: The provider code (e.g. "bosta", "turbo")
   - \`items\`: [{ \`id\`: orderUuid, \`address\`: fullDetailedWrittenAddress, \`cityId\`: unifiedCityId, \`shippingMetadata\`: { zoneId, districtId } }]
   - Always set \`address\` to normal full address text only. **Never append latitude/longitude** to \`address\``
      : `8. Update using \`bulk_update_orders_shipping\` with:
   - \`code\`: The provider code (e.g. "bosta", "turbo")
   - \`items\`: [{ \`id\`: orderUuid, \`cityId\`: unifiedCityId, \`shippingMetadata\`: { zoneId, districtId } }]
   - **Do NOT include \`address\`** — written address must stay unchanged`;

    return `You are an AI assistant that prepares order shipping information for distribution by a shipping company. Your task is to ensure the order has the correct city, and the required shipping details (zone, district) for the selected shipping company.

## Order Data
- Order ID: ${orderData.id}
- Order Number: ${orderData.orderNumber}
- Current City: ${city || "not set"}
- Current Area: ${area || "not set"}
- Current Address: ${address || "not set"}
- Landmark: ${landmark || "not set"}
- Location Address: ${locationAddress || "not set"}
- Location Name: ${locationName || "not set"}
- Latitude: ${latitude ?? "not set"}
- Longitude: ${longitude ?? "not set"}
- City ID: ${orderData.cityId || "not set"}
- Update written address: ${updateWritten ? "yes" : "no"}
${shippingCompanyInfo}

## Available Tools
- \`get_cities\` - List all unified cities with their provider locations (includes dropOff/pickup availability)
- \`get_city\` - Get a single city by ID with provider locations
- \`get_areas_by_city\` - List areas for a unified city
- \`get_shipping_zones\` - List zones for a shipping provider city
- \`get_shipping_districts\` - List districts for a shipping provider city
- \`get_location_by_coordinates\` - Get location details from latitude/longitude
- \`bulk_update_orders_shipping\` - Update order shipping fields${updateWritten ? " including written `address`," : " (city, zone, district only — do not send `address`),"} city, zone, and district
- \`report_address_conflict\` - Send the customer a WhatsApp list to choose between 2+ **complete and accurate** conflicting addresses

## Address Sources (priority order)
1. Primary: \`locationAddress\`, \`locationName\`, \`latitude\`, \`longitude\`
2. Fallback: \`address\`, \`city\`, \`area\`, \`landmark\`

## What counts as a complete / accurate shipping address
A candidate is usable for shipping if the courier can deliver to it, for example:
- A clear written address with city + street/building detail, OR
- A **map pin with valid latitude/longitude** (the pin itself is precise enough even if reverse-geocode text is sparse / city-only)
It is **incomplete / inaccurate** only if it is vague text with no city and no coordinates (e.g. empty, "near the mosque" alone, garbage text).

Important: \`isSparse: true\` on reverse geocode does **NOT** mean the map pin is invalid. Sparse only means OSM text is short. The pin is still a complete accurate option for customer choice.

${writtenAddressRules}

## Conflict / choice rules (IMPORTANT)
**Ask the customer when there are 2+ different places that are each usable for shipping (written complete address AND/OR map pin with coordinates).**

1. **Two or more different places, each usable** (example: written address in Cairo vs map pin in Arish/North Sinai) → call \`report_address_conflict\` with those candidates. Do **NOT** call \`bulk_update_orders_shipping\` in that turn.
   - For labels use exactly:
     - Written order address → label \`"العنوان المسجل"\`, source \`"address"\`
     - WhatsApp/map pin → label \`"عنوان الواتساب"\`, source \`"coordinates"\` or \`"locationAddress"\`, include latitude/longitude
   - \`fullAddress\` must be normal address text only (no lat/lng in the string)
2. **One complete/accurate address and one incomplete/inaccurate text (no coordinates):**
   - If they clearly refer to the **same place** (weaker/vaguer detail of the accurate one) → do **NOT** ask. Use the accurate one + \`bulk_update_orders_shipping\`.
   - If they are unrelated vague text only → do **NOT** ask with invalid options; do not update.
3. **All candidates incomplete/inaccurate** (no usable written address and no coordinates) → do **NOT** call \`report_address_conflict\`. Do not update shipping.
4. **Single clear complete address / single map pin** → resolve city/zone/district and update with \`bulk_update_orders_shipping\`.

Never refuse to ask the customer just because reverse-geocode text for a map pin is city-only — the pin itself is still a valid choice when it conflicts with a different written address.

## Your Task (when updating shipping)
1. Judge each address source for completeness/accuracy using the rules above
2. If latitude/longitude are set, call \`get_location_by_coordinates\` to get the exact map location details before updating
3. Determine the correct city using \`get_cities\`
4. Find the provider location mapping for the shipping company
5. Check if the city supports dropOff for this provider (if not, the order may need special handling)
6. Fetch zones/districts using the provider's external city ID
7. Select the correct zone/district based on the address
${updateTaskStep}
9. **Do NOT update if unsure about the location**
10. **Never invent an address**

## Response
Explain briefly what you found and what you did (or why you couldn't update). Use simple, everyday language that any user can understand. Avoid technical terms.`;
  }

  private buildResumePrompt(
    orderData: any,
    config: AiAddressCorrectionConfig,
    conflictingAddresses: ConflictingAddressCandidate[],
    selected: ConflictingAddressCandidate,
    selection: { buttonId?: string; buttonText?: string },
  ): string {
    const shippingCompanyInfo = config.shippingCompany
      ? `\n- Selected Shipping Company: ${config.shippingCompany} (${config.provider})`
      : "";
    const updateWritten = shouldUpdateWrittenAddress(config);

    const listText = conflictingAddresses
      .map(
        (a) =>
          `- id: ${a.rowId} | label: ${a.label} | fullAddress: ${a.fullAddress}` +
          `${a.city ? ` | city: ${a.city}` : ""}${a.area ? ` | area: ${a.area}` : ""}` +
          `${a.source ? ` | source: ${a.source}` : ""}`,
      )
      .join("\n");

    const updateStep = updateWritten
      ? `4. Update using \`bulk_update_orders_shipping\` with:
   - \`address\`: normal full written address from selection fullAddress / order locationAddress / detailed reverse-geocode. **Do not append lat/lng** (bad: "... (موقع على الخريطة: 31.13, 33.81)"). Never shorten to only city + governorate + country when richer text exists
   - \`cityId\` and \`shippingMetadata\` (zoneId, districtId) as needed`
      : `4. Update using \`bulk_update_orders_shipping\` with:
   - \`cityId\` and \`shippingMetadata\` (zoneId, districtId) as needed
   - **Do NOT include \`address\`** — client disabled updating the written address`;

    return `Continue the previous address-correction task. The customer already chose one address from the conflict list. Use that selection only — do not ask again and do not call report_address_conflict.

## Order Data
- Order ID: ${orderData.id}
- Order Number: ${orderData.orderNumber}
- City ID: ${orderData.cityId || "not set"}
- Update written address: ${updateWritten ? "yes" : "no"}
${shippingCompanyInfo}

## Addresses that were sent to the customer
${listText}

## Customer selection
- Selected row id: ${selection.buttonId || selected.rowId}
- Selected title: ${selection.buttonText || selected.label}
- Full address to use: ${selected.fullAddress}
- City hint: ${selected.city || "not set"}
- Area hint: ${selected.area || "not set"}
- Source: ${selected.source || "not set"}
- Latitude: ${selected.latitude ?? "not set"}
- Longitude: ${selected.longitude ?? "not set"}

## Your Task
1. Treat the selected address above as the correct shipping address
2. If latitude/longitude are set on the selection (or on the order), call \`get_location_by_coordinates\` to enrich city/zone selection. If the result is \`isSparse\`, do not use that short city string as \`address\`
3. Resolve city / zone / district for the shipping company using the available tools
${updateStep}
5. Do NOT invent a different address

## Response
Explain briefly what you updated (or why you could not). Use simple everyday language.`;
  }
}

function shouldUpdateWrittenAddress(config: AiAddressCorrectionConfig): boolean {
  return config?.updateWrittenAddress !== false;
}

function truncateWhatsappText(value: string, max: number): string {
  const text = (value || "").trim();
  if (text.length <= max) return text || "-";
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

const CONFLICT_TITLE_REGISTERED = "العنوان المسجل";
const CONFLICT_TITLE_WHATSAPP = "عنوان الواتساب";

function isWhatsappMapSource(source?: string, hasCoords?: boolean): boolean {
  if (hasCoords) return true;
  const s = (source || "").toLowerCase();
  return (
    s.includes("location") ||
    s.includes("coordinate") ||
    s.includes("map") ||
    s.includes("lat") ||
    s.includes("whatsapp")
  );
}

function resolveConflictListTitle(
  source?: string,
  latitude?: number,
  longitude?: number,
): string {
  const hasCoords =
    Number.isFinite(latitude) && Number.isFinite(longitude);
  return isWhatsappMapSource(source, hasCoords)
    ? CONFLICT_TITLE_WHATSAPP
    : CONFLICT_TITLE_REGISTERED;
}

/** Strip lat/lng / map-pin suffixes the model sometimes appends to address text. */
function sanitizeConflictAddressText(value: string): string {
  let text = (value || "").trim();
  text = text.replace(/^موقع\s*الخريطة\s*[:：\-–]?\s*/i, "");
  text = text.replace(
    /\s*[\(（]?\s*موقع\s*(?:على\s*)?الخريطة\s*[:：]?\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*[\)）]?\s*$/i,
    "",
  );
  text = text.replace(
    /\s*[\(（]?\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*[\)）]?\s*$/g,
    "",
  );
  return text.trim();
}

function normalizeConflictAddresses(raw: any[]): ConflictingAddressCandidate[] {
  const out: ConflictingAddressCandidate[] = [];
  const seen = new Set<string>();

  for (const item of raw || []) {
    if (!item || typeof item !== "object") continue;
    const fullAddress = sanitizeConflictAddressText(
      String(item.fullAddress || item.address || ""),
    );
    const source = item.source ? String(item.source) : undefined;
    const latitude =
      item.latitude !== undefined && item.latitude !== null
        ? Number(item.latitude)
        : undefined;
    const longitude =
      item.longitude !== undefined && item.longitude !== null
        ? Number(item.longitude)
        : undefined;
    const label = resolveConflictListTitle(source, latitude, longitude);
    if (!fullAddress && !label) continue;

    const key = `${label}|${fullAddress.toLowerCase()}|${latitude ?? ""}|${longitude ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      rowId: `addr_${out.length}`,
      label,
      fullAddress: fullAddress || label,
      city: item.city ? String(item.city) : undefined,
      area: item.area ? String(item.area) : undefined,
      source,
      latitude: Number.isFinite(latitude) ? latitude : undefined,
      longitude: Number.isFinite(longitude) ? longitude : undefined,
    });

    if (out.length >= 10) break;
  }

  return out;
}

function extractAddressConflict(chatResult: AiOrchestrationResult): {
  addresses: any[];
  reason?: string;
} | null {
  const progress = !chatResult.progress?.length
    ? chatResult?._dev?.progress
    : chatResult.progress;
  const toolResults =
    progress?.filter((event) => event.type === "tool_result") ?? [];

  const conflictResult = [...toolResults]
    .reverse()
    .find((event) => event.toolName === "report_address_conflict");

  if (!conflictResult?.result?.ok) return null;

  const data = (conflictResult.result.data || {}) as Record<string, any>;
  const addresses = Array.isArray(data.addresses) ? data.addresses : [];
  if (addresses.length < 2) return null;

  return {
    addresses,
    reason: data.reason ? String(data.reason) : undefined,
  };
}

function decideAddressCorrectionBranch(chatResult: AiOrchestrationResult): NodeHandlerResponse {
  const progress = !chatResult.progress?.length ? chatResult?._dev?.progress : chatResult.progress;
  const toolResults = progress?.filter(
    (event) => event.type === "tool_result",
  ) ?? [];

  const updateResult = toolResults.find(
    (event) => event.toolName === "bulk_update_orders_shipping",
  );

  if (updateResult?.result?.ok) {
    return {
      success: true,
      chosenBranch: "address_corrected",
      output: { ...(updateResult.result.data as Record<string, unknown>), aiComment: chatResult.content },
    };
  }

  if (updateResult && !updateResult.result?.ok) {
    return {
      success: true,
      chosenBranch: "address_not_corrected",
      error: updateResult.result?.error,
      output: { aiComment: chatResult.content },
    };
  }

  return {
    success: true,
    chosenBranch: "address_not_corrected",
    output: {
      aiComment: chatResult.content,
    },
  };
}

@Injectable()
export class ActionAssignShippingProviderHandler extends FlowNodeHandler {
  private readonly logger = new Logger(ActionAssignShippingProviderHandler.name);

  constructor(
    @InjectRepository(OrderEntity)
    protected readonly orderRepo: Repository<OrderEntity>,
    private readonly adapter: AutomationAdapter,
  ) {
    super(orderRepo);
  }

  async execute(
    config: AssignShippingProviderConfig,
    run: AutomationRunEntity,
  ): Promise<NodeHandlerResponse> {
    try {
      const orderData = await this.getOrder(run.executionState.trigger.output);
      if (!orderData?.id) {
        return {
          success: false,
          error: "Order information not available for shipping assignment",
        };
      }

      const me = {
        adminId: orderData.adminId || run.initialPayload?.adminId,
        id: run.initialPayload?.userId || null,
        role: run.initialPayload?.role,
      };

      let selectedProvider = config.provider;
      let selectedCompanyId = config.shippingCompanyId;
      let selectedCompanyName = config.shippingCompany;

      if (!selectedProvider) {
        return {
          success: false,
          error: "Selected shipping provider is unavailable",
        };
      }

      const shipment = await this.adapter.createShipment(
        me,
        selectedProvider as any,
        {},
        orderData.id,
        { emitSocket: false },
      );

      return {
        success: true,
        shouldPause: false,
        chosenBranch: "distributed",
        output: {
          orderId: orderData.id,
          shippingCompanyId: selectedCompanyId,
          shippingCompany: selectedCompanyName,
          provider: selectedProvider,
          shipment,
        },
      };
    } catch (error) {
      this.logger.error(
        `Failed to assign shipping provider: ${error?.message}`,
        error?.stack,
      );

      return {
        success: false,
        chosenBranch: "failed_to_distribute",
        error: error?.message || "Shipping provider assignment failed",

      };
    }
  }
}

@Injectable()
export class ActionSendWhatsappTemplateMessageHandler extends FlowNodeHandler {
  private readonly logger = new Logger(
    ActionSendWhatsappTemplateMessageHandler.name,
  );

  // Preprocess aliases to store in a map grouped by root key (e.g., "items[]")
  private readonly pathAliasesByRoot: Map<
    string,
    { aliasPath: string; actualPath: string }
  > = new Map();

  constructor(
    private readonly adapter: AutomationAdapter,
    @InjectRepository(OrderEntity)
    protected readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(WhatsappMessageEntity)
    private readonly messageRepo: Repository<WhatsappMessageEntity>,
    @InjectRepository(User)
    private readonly userRepo?: Repository<User>,
    private readonly clientSettingsService?: ClientSettingsService,
    private readonly automationQueueService?: AutomationQueueService,
  ) {
    super(orderRepo);
  }
  
  async execute(
    hydratedConfig: SendWhatsappTemplateConfig,
    run: AutomationRunEntity,
  ): Promise<NodeHandlerResponse> {
    try {
      // Get latest order data from database, or use old data for preview
      const orderData = await this.getOrder(run.executionState.trigger.output);
      if (!orderData) {
        return {
          success: false,
          error: "Order data not found in trigger output",
        };
      }

      // Global context (brand/company info + admin language) for global.* variables
      const globalData = await loadGlobalData(
        this.userRepo,
        orderData?.adminId,
        this.clientSettingsService,
      );

      // 1. Get Template and Account using adapter
      const template = await this.adapter.getTemplateById(
        hydratedConfig.templateId,
      );

      if (!template) {
        return { success: false, error: "WhatsApp template not found" };
      }

      if (template.adminId && !template.account) {
        return { success: false, error: "WhatsApp account not found" };
      }

      if (template.adminId && template.status !== TemplateStatus.APPROVED) {
        return { success: false, error: "WhatsApp template is not approved" };
      }

      const buttons = template.templateConfig.buttons || [];
      const customButtons =
        template.templateConfig.buttons?.filter(
          (btn) => btn.type === "CUSTOM",
        ) || [];
      // The "no response" (timeout) branch is not a real template button,
      // so it must not be counted when validating button/branch counts.
      const configBranches = (hydratedConfig.branches || []).filter(
        (b) => !b.isNoResponse,
      );
      if ((customButtons.length || 0) != configBranches.length) {
        return {
          success: false,
          error:
            "WhatsApp template buttons and configuration buttons count do not match",
        };
      }
      const bodyVarsLength =
        (Array.isArray(template.templateConfig.examples)
          ? template.templateConfig.examples?.length
          : Object.keys(template.templateConfig.examples || {}).length) || 0;

      const headerVarsLength = template.templateConfig.headerExample ? 1 : 0;

      if (
        bodyVarsLength !==
        Object.keys(hydratedConfig.bodyVariables || {}).length
      ) {
        return {
          success: false,
          error: "WhatsApp template body variables count does not match",
        };
      }

      const dynamicButtons = buttons.filter(
        (btn) =>
          (btn.type === "VISIT_WEBSITE" && btn.urlType === "Dynamic") ||
          btn.type === "COPY_CODE",
      );
      const configButtonVarsCount = Object.keys(
        hydratedConfig.buttonVariables || {},
      ).length;

      if (dynamicButtons.length !== configButtonVarsCount) {
        return {
          success: false,
          error:
            "WhatsApp template dynamic buttons variables count does not match",
        };
      }

      if (
        headerVarsLength !==
        Object.keys(hydratedConfig.headerVariables || {}).length
      ) {
        return {
          success: false,
          error: "WhatsApp template header variables count does not match",
        };
      }

      // 2. Prepare Hydrated Variables (Map dynamic paths to real values)
      const headerVariables = hydratedConfig.headerVariables
        ? this.mapVariablesToValues(
          hydratedConfig.headerVariables,
          orderData,
          globalData,
        )
        : undefined;
      const bodyVariables = hydratedConfig.bodyVariables
        ? this.mapVariablesToValues(
          hydratedConfig.bodyVariables,
          orderData,
          globalData,
        )
        : undefined;
      const buttonVariables = hydratedConfig.buttonVariables
        ? this.mapVariablesToValues(
          hydratedConfig.buttonVariables,
          orderData,
          globalData,
        )
        : undefined;

      // Handle Location Header if present
      let locationData = undefined;
      if (
        template.templateConfig?.headerType?.toUpperCase() === "LOCATION" &&
        hydratedConfig.locationData
      ) {
        const locValues = this.mapVariablesToValues(
          {
            name: hydratedConfig.locationData.name,
            address: hydratedConfig.locationData.address,
          },
          orderData,
          globalData,
        );

        locationData = {
          latitude: hydratedConfig.locationData.latitude?.toString(),
          longitude: hydratedConfig.locationData.longitude?.toString(),
          name: locValues.name,
          address: locValues.address,
        };
      }

      // 3. Determine Recipient
      const to = hydratedConfig.recipientNumber
        ? normalizeEgyptianPhoneNumber(hydratedConfig.recipientNumber)
        : orderData.normalizedPhoneNumber
          ? orderData.normalizedPhoneNumber
          : normalizeEgyptianPhoneNumber(orderData.phoneNumber);
      if (!to) {
        return { success: false, error: "Recipient phone number not found" };
      }

      // 4. Send Message using adapter
      const adapterResponse = await this.adapter.sendTemplate(
        template.accountId,
        {
          to,
          templateId: template.id,
          headerVariables,
          bodyVariables,
          buttonVariables,
          locationData,
          headerUrl:
            hydratedConfig.useOrderFirstItemImage &&
              template.templateConfig?.headerType?.toUpperCase() === "IMAGE"
              ? orderData.items?.[0]?.variant?.product?.mainImage ||
              hydratedConfig.headerUrl
              : hydratedConfig.headerUrl,
        },
        orderData.adminId,
      );

      // "No response" (timeout) branch: pause the run and schedule a
      // wait-resume job that continues down the no-response branch when
      // the client doesn't respond within the configured time.
      const noResponseBranch = (hydratedConfig.branches || []).find(
        (b) => b.isNoResponse === true,
      );
      const noResponseMinutes = Number(noResponseBranch?.timeoutMinutes);
      const noResponseMs =
        noResponseMinutes > 0 ? noResponseMinutes * 60 * 1000 : null;

      // Preview runs pass a PreviewRunDocument (has previewId) — never enqueue/pause there.
      if (noResponseMs && !(run as any).previewId) {
        await this.automationQueueService?.enqueueWaitResume(
          run.id,
          run.automationFlowId,
          run.versionId,
          run.adminId,
          run.currentNodeId,
          noResponseMs,
        );
      }

      return {
        success: true,
        shouldPause: hydratedConfig.branches?.length > 0,
        resumeAfter: 4000,
        output: {
          messageId: adapterResponse.messageId,
          recipient: to,
          templateId: template.id,
          templateName: template.name,
          variables: {
            header: headerVariables,
            body: bodyVariables,
            button: buttonVariables,
          },
          ...(noResponseMs
            ? {
              waitMinutes: noResponseMinutes,
              waitMs: noResponseMs,
              resumeAt: new Date(Date.now() + noResponseMs).toISOString(),
            }
            : {}),
        },
      };
    } catch (error) {
      this.logger.error(
        `Failed to send WhatsApp template: ${error.message}`,
        error.stack,
      );
      return {
        success: false,
        error: `WhatsApp send failed: ${error.message}`,
      };
    }
  }

  private mapVariablesToValues(
    variables: Record<string, any>,
    orderData: OrderEntity,
    globalData?: GlobalContext,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    Object.entries(variables).forEach(([key, varDetails]) => {
      let textValue = "";

      if (varDetails.type === "direct") {
        textValue = varDetails.value || "";
        if (!textValue) {
          throw new Error(`Variable "${key}" is direct type but has no value`);
        }
      } else if (varDetails.type === "variable") {
        const variablePath = varDetails.variablePath;
        const isGlobal =
          typeof variablePath === "string" &&
          variablePath.startsWith("global.");

        if (isGlobal) {
          // Global variables are already formatted (brand/company info
          // or a computed date), so no further order lookup is needed.
          textValue = resolveGlobalVariablePath(variablePath, globalData);
        } else {
          const val = getValueByPath(orderData, variablePath);
          if (Array.isArray(val)) {
            textValue = val.map((v) => String(v)).join(", ");
          } else {
            if (val == null || val === undefined) {
              textValue = "";
            } else if (val instanceof Date) {
              textValue = val.toLocaleString("en-GB", {
                day: "2-digit",
                month: "2-digit",
                year: "numeric",
              });
            } else if (typeof val === "string") {
              const date = new Date(val);

              textValue = !isNaN(date.getTime())
                ? date.toLocaleString("en-GB", {
                  day: "2-digit",
                  month: "2-digit",
                  year: "numeric",
                })
                : val;
            } else {
              textValue = String(val);
            }
          }
        }

        if (!textValue && !isGlobal) {
          throw new Error(
            `Variable "${key}" not found at path "${varDetails.variablePath}" in order data`,
          );
        }
      }

      // Truncate to max 30 characters by removing words first
      textValue = this.truncateToMaxLength(textValue, 30);

      result[key] = textValue;
    });
    return result;
  }

  private truncateToMaxLength(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }

    const words = text.split(" ");

    // Try removing words one by one from the end until it fits
    while (words.length > 1) {
      words.pop();
      const truncated = words.join(" ");
      if (truncated.length <= maxLength) {
        return truncated;
      }
    }

    // If only one word left, truncate it directly
    return text.substring(0, maxLength);
  }
}

@Injectable()
export class ActionSendWhatsappMessageHandler extends FlowNodeHandler {
  private readonly logger = new Logger(this.constructor.name);
  constructor(
    private readonly adapter: AutomationAdapter,
    @InjectRepository(OrderEntity)
    protected readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(WhatsappMessageEntity)
    private readonly messageRepo: Repository<WhatsappMessageEntity>,
    private readonly whatsappService?: WhatsappService,
    @InjectRepository(User)
    private readonly userRepo?: Repository<User>,
    private readonly clientSettingsService?: ClientSettingsService,
    private readonly automationQueueService?: AutomationQueueService,
  ) {
    super(orderRepo);
  }
  async execute(
    config: SendWhatsappMessageConfig,
    run: AutomationRunEntity,
  ): Promise<NodeHandlerResponse> {
    try {
      const orderData = await this.getOrder(run.executionState.trigger.output);
      if (!orderData) {
        return {
          success: false,
          error: "Order data not found in trigger output",
        };
      }

      // Check WhatsApp account
      const account = await this.adapter.getWhatsappAccount(config.accountId);
      if (!account) {
        return { success: false, error: "WhatsApp account not found" };
      }

      // Global context (brand/company info + admin language) for global.* variables
      const globalData = (await loadGlobalData(
        this.userRepo,
        orderData?.adminId,
        this.clientSettingsService,
      )) || { values: {}, lang: Language.EN };

      // Business postpone messages: skip weekends (Friday/Saturday) when
      // computing {{global.date.N.<format>}} replacements.
      globalData.excludeWeekends = !!config.businessConfig?.excludeWeekends;

      // Process messageData to replace variables
      const processedMessageData = this.deepReplaceVariables(
        config.messageData,
        orderData,
        globalData,
      );

      // Determine recipient
      const to = config.recipientNumber
        ? normalizeEgyptianPhoneNumber(config.recipientNumber)
        : orderData.normalizedPhoneNumber
          ? orderData.normalizedPhoneNumber
          : normalizeEgyptianPhoneNumber(orderData.phoneNumber);

      if (!to) {
        return { success: false, error: "Recipient phone number not found" };
      }

      const payload: any = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        ...processedMessageData,
      };

      // Attach the business context (businessConfig + use case + command)
      // as message metadata so it can be used when the user responds.
      if (
        config.businessConfig ||
        config.businessUseCase ||
        config.businessCommand
      ) {
        payload.metadata = {
          businessConfig: config.businessConfig,
          businessUseCase: config.businessUseCase,
          businessCommand: config.businessCommand,
        };
      }

      let response: any;
      if (this.whatsappService) {
        // Send the message only if service is available (production mode)
        response = await this.whatsappService.sendMessage(
          { adminId: orderData.adminId },
          payload,
          config.accountId,
          null,
          config.actionIntent || MessageActionIntent.NONE,
          orderData.id,
        );
        const messageId = response.messages?.[0]?.id;
      } else {
        // Preview mode, mock response
        response = {
          messages: [{ id: `preview-${Date.now()}` }],
        };
      }

      const finalMessageId = response.messages?.[0]?.id;
      await wait(4000);
      // Check message status after 5 seconds (only in production mode)
      if (this.whatsappService && finalMessageId) {
        await checkMessageStatus(finalMessageId, this.messageRepo, this.logger);
      }
      const shouldPause = config.branches?.length > 0;

      // "No response" (timeout) branch: pause the run and schedule a
      // wait-resume job that continues down the no-response branch when
      // the client doesn't respond within the configured time.
      const noResponseBranch = (config.branches || []).find(
        (b) => b.isNoResponse === true,
      );
      const noResponseMinutes = Number(noResponseBranch?.timeoutMinutes);
      const noResponseMs =
        noResponseMinutes > 0 ? noResponseMinutes * 60 * 1000 : null;

      // Preview runs pass a PreviewRunDocument (has previewId) — never enqueue/pause there.
      if (noResponseMs && !(run as any).previewId) {
        await this.automationQueueService?.enqueueWaitResume(
          run.id,
          run.automationFlowId,
          run.versionId,
          run.adminId,
          run.currentNodeId,
          noResponseMs,
        );
      }

      return {
        success: true,
        shouldPause,
        output: {
          messageId: finalMessageId,
          recipient: to,
          ...(noResponseMs
            ? {
              waitMinutes: noResponseMinutes,
              waitMs: noResponseMs,
              resumeAt: new Date(Date.now() + noResponseMs).toISOString(),
            }
            : {}),
        },
      };
    } catch (error) {
      this.logger.error(
        `Failed to send WhatsApp message: ${error.message}`,
        error.stack,
      );
      return {
        success: false,
        error: `WhatsApp send failed: ${error.message}`,
      };
    }
  }
}

@Injectable()
export class ActionSendUpsellHandler extends FlowNodeHandler {
  private readonly logger = new Logger(this.constructor.name);
  constructor(
    private readonly adapter: AutomationAdapter,
    @InjectRepository(OrderEntity)
    protected readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(WhatsappMessageEntity)
    private readonly messageRepo: Repository<WhatsappMessageEntity>,
    @InjectRepository(User)
    private readonly userRepo?: Repository<User>,
    private readonly clientSettingsService?: ClientSettingsService,
    private readonly automationQueueService?: AutomationQueueService,
  ) {
    super(orderRepo);
  }

  async execute(
    hydratedConfig: SendUpsellConfig,
    run: AutomationRunEntity,
  ): Promise<NodeHandlerResponse> {
    try {
      // Get latest order data from database, or use old data for preview
      const orderData = await this.getOrder(run.executionState.trigger.output);
      if (!orderData) {
        return {
          success: false,
          error: "Order data not found in trigger output",
        };
      }

      // Global context (brand/company info + admin language) for global.* variables
      const globalData = await loadGlobalData(
        this.userRepo,
        orderData?.adminId,
        this.clientSettingsService,
      );

      const items = orderData.items || [];
      const productIds = items
        .map((item) => item.variant?.productId)
        .filter(Boolean);

      if (productIds.length === 0) {
        return {
          success: true,
          shouldPause: false,
          chosenBranch: "skipped",
          output: { reason: "No products in order" },
        };
      }

      // Get available upsells for these products using adapter
      const orderItemVariantIds = items
        .map((item) => item.variantId)
        .filter(Boolean);
      const upsells = await this.adapter.getUpsellsForProducts(
        productIds,
        orderData.adminId,
        orderItemVariantIds,
      );

      if (upsells.length === 0) {
        return {
          success: true,
          shouldPause: false,
          chosenBranch: "skipped",
          output: { reason: "No upsells found for products" },
        };
      }

      const sentUpsells = [];

      // Send each upsell using the adapter
      for (const upsell of upsells) {
        // Resolve order + global variables inside the upsell message config
        const messageConfig = upsell.messageConfig
          ? this.deepReplaceVariables(
            upsell.messageConfig,
            orderData,
            globalData,
          )
          : upsell.messageConfig;

        const history = await this.adapter.sendUpsell(
          { ...upsell, messageConfig },
          orderData,
          run,
        );
        if (history) {
          sentUpsells.push({
            upsellId: upsell.id,
            historyId: history.id,
            messageId: history.messageId,
            triggerProductId: upsell.triggerProductId,
            upsellProductId: upsell.upsellProductId,
          });
        }
      }
      await wait(4000);
      for (const history of sentUpsells) {
        if (history.messageId) {
          await checkMessageStatus(
            history.messageId,
            this.messageRepo,
            this.logger,
          );
        }
      }

      // "No response" (timeout) branch: pause the run and schedule a
      // wait-resume job that continues down the no-response branch when
      // the client doesn't respond within the configured time.
      const noResponseBranch = (hydratedConfig.branches || []).find(
        (b) => b.isNoResponse === true,
      );
      const noResponseMinutes = Number(noResponseBranch?.timeoutMinutes);
      const noResponseMs =
        noResponseMinutes > 0 ? noResponseMinutes * 60 * 1000 : null;

      // Preview runs pass a PreviewRunDocument (has previewId) — never enqueue/pause there.
      if (noResponseMs && !(run as any).previewId) {
        await this.automationQueueService?.enqueueWaitResume(
          run.id,
          run.automationFlowId,
          run.versionId,
          run.adminId,
          run.currentNodeId,
          noResponseMs,
        );
      }

      return {
        success: true,
        shouldPause: true, // We are waiting for a response
        output: {
          sentUpsellsCount: sentUpsells.length,
          sentUpsells,
          recipient: orderData.phoneNumber,
          ...(noResponseMs
            ? {
              waitMinutes: noResponseMinutes,
              waitMs: noResponseMs,
              resumeAt: new Date(Date.now() + noResponseMs).toISOString(),
            }
            : {}),
        },
      };
    } catch (error) {
      this.logger.error(
        `Failed to send upsells: ${error.message}`,
        error.stack,
      );
      return {
        success: false,
        error: `Upsell send failed: ${error.message}`,
      };
    }
  }
}

@Injectable()
export class ActionAssignOrderToEmployeeHandler extends FlowNodeHandler {
  private readonly logger = new Logger(ActionAssignOrderToEmployeeHandler.name);

  constructor(
    private readonly adapter: AutomationAdapter,
    @InjectRepository(OrderEntity)
    protected readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(OrderAssignmentEntity)
    private readonly orderAssignmentRepo: Repository<OrderAssignmentEntity>,
    private readonly ordersService: OrdersService,
  ) {
    super(orderRepo);
  }

  async execute(
    config: AssignOrderToEmployeeConfig,
    run: AutomationRunEntity,
  ): Promise<NodeHandlerResponse> {
    try {
      // Get latest order data
      const orderData = await this.getOrder(run.executionState.trigger.output);
      if (!orderData?.id) {
        return {
          success: false,
          shouldPause: false,
          error: "Order data not available for assignment",
        };
      }
      const adminId = orderData.adminId;

      // Check if order is eligible for assignment
      if (
        orderData.status &&
        !this.ordersService.ALLOWED_STATUS_CODES_FOR_ASSIGNMENT.has(
          orderData.status.code as any,
        )
      ) {
        return {
          success: true,
          shouldPause: false,
          chosenBranch: "not_eligable",
          output: {
            reason: "Order status not allowed for assignment",
            orderId: orderData.id,
          },
        };
      }

      // Check if order already has active assignment
      const existingAssignment = await this.orderAssignmentRepo.findOne({
        where: { orderId: orderData.id, isAssignmentActive: true },
      });
      if (existingAssignment) {
        return {
          success: true,
          shouldPause: false,
          chosenBranch: "assigned",
          output: {
            reason: "Order already assigned",
            orderId: orderData.id,
            employeeId: existingAssignment.employeeId,
          },
        };
      }

      let chosenBranch: string;
      let output: any;

      if (config.employeeId && config.employeeId !== "none") {
        // Manual assignment to specific employee
        chosenBranch = await this.adapter.manualAssign(
          config.employeeId,
          orderData,
          adminId,
        );
        output = { orderId: orderData.id, employeeId: config.employeeId };
      } else {
        // Auto assignment
        const result = await this.adapter.processAutoAssignment(adminId, [
          orderData,
        ]);
        if (result.assignedCount > 0) {
          chosenBranch = "assigned";
          output = { orderId: orderData.id, results: result.results };
        } else {
          chosenBranch = "no_roles_match";
          output = {
            orderId: orderData.id,
            reason: result.message || "No matching assignment rules",
          };
        }
      }

      return {
        success: true,
        shouldPause: false,
        chosenBranch,
        output,
      };
    } catch (error) {
      this.logger.error(
        `Failed to assign order: ${error?.message}`,
        error?.stack,
      );

      return {
        success: false,
        shouldPause: false,
        error: "Failed to assign order",
      };
    }
  }
}

export class ActionSendSmsHandler extends FlowNodeHandler {
  private readonly logger = new Logger(ActionSendSmsHandler.name);

  constructor(
    private readonly adapter: AutomationAdapter,
    @InjectRepository(OrderEntity)
    protected readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(User)
    private readonly userRepo?: Repository<User>,
    private readonly clientSettingsService?: ClientSettingsService,
  ) {
    super(orderRepo);
  }
  async execute(
    config: SendSmsConfig,
    run: AutomationRunEntity,
  ): Promise<NodeHandlerResponse> {
    try {
      const orderData = await this.getOrder(run.executionState.trigger.output);
      if (!orderData) {
        return {
          success: false,
          error: "Order data not found in trigger output",
        };
      }

      if (!config?.providerCode) {
        return {
          success: false,
          shouldPause: false,
          error: "SMS providerCode is required",
        };
      }

      // Global context (brand/company info + admin language) for global.* variables
      const globalData = await loadGlobalData(
        this.userRepo,
        orderData?.adminId,
        this.clientSettingsService,
      );

      const processedMessage = this.deepReplaceVariables(
        config.message || "",
        orderData,
        globalData,
      );
      const processedToNumber = config.toNumber || "";

      const to = processedToNumber
        ? normalizeEgyptianPhoneNumber(processedToNumber)
        : orderData.normalizedPhoneNumber
          ? orderData.normalizedPhoneNumber
          : normalizeEgyptianPhoneNumber(orderData.phoneNumber);

      if (!to) {
        return {
          success: false,
          shouldPause: false,
          error: "Recipient phone number not found",
        };
      }

      const sendResult = await this.adapter.sendSms(
        { id: orderData.adminId, adminId: orderData.adminId } as any,
        config.providerCode,
        {
          toNumber: to,
          message: processedMessage,
          senderId: config.senderId || null,
        } as any,
      );

      const log = sendResult?.log;
      const chosenBranch =
        log?.status === SmsSendStatus.SENT ? "sent" : "failed";

      return {
        success: true,
        shouldPause: false,
        chosenBranch,
        output: {
          logId: log?.id,
          status: log?.status,
          toNumber: log?.toNumber || to,
          message: processedMessage,
          sender: log.sender?.name,
          erorr: log.error,
          response: log.providerResponse,
          providerCode: log?.providerCode || config.providerCode,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to send SMS: ${error.message}`, error.stack);
      return {
        success: false,
        shouldPause: false,
        error: `SMS send failed: ${error.message}`,
      };
    }
  }
}

export class ActionCreateIssueHandler extends FlowNodeHandler {
  private readonly logger = new Logger(ActionCreateIssueHandler.name);

  constructor(
    private readonly adapter: AutomationAdapter,
    @InjectRepository(OrderEntity)
    protected readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(User)
    private readonly userRepo?: Repository<User>,
    private readonly clientSettingsService?: ClientSettingsService,
  ) {
    super(orderRepo);
  }

  async execute(
    config: CreateIssueConfig,
    run: AutomationRunEntity,
  ): Promise<NodeHandlerResponse> {
    try {
      const orderData = await this.getOrder(run.executionState.trigger.output);
      if (!orderData) {
        return {
          success: false,
          shouldPause: false,
          error: "Order data not found in trigger output",
        };
      }

      if (!config?.title) {
        return {
          success: false,
          shouldPause: false,
          error: "Issue title is required",
        };
      }

      const globalData = await loadGlobalData(
        this.userRepo,
        orderData?.adminId,
        this.clientSettingsService,
      );
      const hydrated = this.deepReplaceVariables(config, orderData, globalData);

      const createResult = await this.adapter.createIssue(
        { adminId: orderData.adminId, id: orderData.adminId },
        {
          title: String(hydrated.title || "").trim(),
          description: hydrated.description
            ? String(hydrated.description)
            : undefined,
          orderId: orderData.id,
          causeId: hydrated.causeId || null,
          priority: hydrated.priority,
          statusId: hydrated.statusId || null,
          assignedRoleId: String(hydrated.assignedRoleId || ""),
          employeeIds: hydrated.employeeIds?.length
            ? hydrated.employeeIds
            : undefined,
          estimatedMinutes: hydrated.estimatedMinutes
            ? Number(hydrated.estimatedMinutes)
            : undefined,
        } as any,
      );

      return {
        success: createResult.success,
        shouldPause: false,
        output: {
          issueId: createResult.issueId,
          previewMode: createResult.previewMode,
          skippedSideEffect: createResult.skippedSideEffect,
          issue: createResult.issue,
        },
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to create issue: ${error?.message}`,
        error?.stack,
      );
      return {
        success: false,
        shouldPause: false,
        error: `Issue creation failed: ${error?.message}`,
      };
    }
  }
}

export class ActionWaitHandler extends FlowNodeHandler {
  private readonly logger = new Logger(ActionWaitHandler.name);

  constructor(
    @InjectRepository(OrderEntity)
    protected readonly orderRepo: Repository<OrderEntity>,
    private readonly automationQueueService?: AutomationQueueService,
  ) {
    super(orderRepo);
  }

  async execute(
    config: WaitConfig,
    run: AutomationRunEntity,
  ): Promise<NodeHandlerResponse> {
    const waitMinutes = Number(config?.waitMinutes) || 0;
    if (waitMinutes <= 0) {
      return {
        success: false,
        shouldPause: false,
        error: "Wait minutes must be greater than zero",
      };
    }
    const waitMs = waitMinutes * 60 * 1000;

    // Preview runs pass a PreviewRunDocument (has previewId) — never enqueue/pause there.
    if ((run as any).previewId) {
      return {
        success: true,
        shouldPause: false,
        output: { waitMinutes, waitMs, simulated: true },
      };
    }

    await this.automationQueueService?.enqueueWaitResume(
      run.id,
      run.automationFlowId,
      run.versionId,
      run.adminId,
      run.currentNodeId,
      waitMs,
    );

    return {
      success: true,
      shouldPause: true,
      output: {
        waitMinutes,
        waitMs,
        resumeAt: new Date(Date.now() + waitMs).toISOString(),
      },
    };
  }
}

export class ActionAssignOrderToClientHandler extends FlowNodeHandler {
  private readonly logger = new Logger(ActionAssignOrderToClientHandler.name);

  constructor(
    private readonly adapter: AutomationAdapter,
    @InjectRepository(OrderEntity)
    protected readonly orderRepo: Repository<OrderEntity>,
  ) {
    super(orderRepo);
  }

  async execute(
    config: AssignOrderToClientConfig,
    run: AutomationRunEntity,
  ): Promise<NodeHandlerResponse> {
    try {
      const orderData = await this.getOrder(run.executionState.trigger.output);
      if (!orderData?.id) {
        return {
          success: false,
          shouldPause: false,
          error: "Order data not found in trigger output",
        };
      }

      const result = await this.adapter.attachOrderToClient(
        { adminId: orderData.adminId, id: orderData.adminId },
        {
          id: orderData.id,
          adminId: orderData.adminId,
          phoneNumber: orderData.phoneNumber,
          customerName: orderData.customerName,
          email: orderData.email,
          clientId: orderData.clientId,
        },
        { createIfMissing: config?.createIfMissing === true },
      );

      return {
        success: result.success,
        shouldPause: false,
        output: {
          skipped: result.skipped,
          reason: result.reason,
          clientId: result.clientId,
          clientCreated: result.clientCreated,
          previewMode: result.previewMode,
          skippedSideEffect: result.skippedSideEffect,
        },
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to assign order to client: ${error?.message}`,
        error?.stack,
      );
      return {
        success: false,
        shouldPause: false,
        error: error?.message || "Failed to assign order to client",
      };
    }
  }
}

@Injectable()
export class NodeHandlersRegistry {
  private readonly handlers = new Map<FlowNodeDataType, FlowNodeHandler>();

  constructor(
    private readonly adapter: ProductionAutomationAdapter,
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(WhatsappMessageEntity)
    private readonly messageRepo: Repository<WhatsappMessageEntity>,
    @InjectRepository(OrderAssignmentEntity)
    private readonly orderAssignmentRepo: Repository<OrderAssignmentEntity>,
    @Inject(forwardRef(() => OrdersService))
    private readonly ordersService: OrdersService,
    @Inject(forwardRef(() => ClientService))
    private readonly clientsService: ClientService,
    @Inject(forwardRef(() => WhatsappService))
    private readonly whatsappService: WhatsappService,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly clientSettingsService: ClientSettingsService,
    @Inject(forwardRef(() => AutomationQueueService))
    private readonly automationQueueService: AutomationQueueService,
    private readonly aiOrchestrator: AiOrchestratorService,
    @InjectRepository(AiProviderEntity)
    private readonly aiProviderRepo: Repository<AiProviderEntity>,
    @InjectRepository(AiModelEntity)
    private readonly aiModelRepo: Repository<AiModelEntity>,
    @InjectRepository(AiModelAvailabilityEntity)
    private readonly aiAvailabilityRepo: Repository<AiModelAvailabilityEntity>,
  ) {
    this.registerHandlers();
  }

  private registerHandlers() {
    // Create handlers with the adapter and order repo
    this.handlers.set(
      ConditionType.QUICK_ORDER_STATUS,
      new ConditionQuickOrderStatusHandler(this.orderRepo),
    );
    this.handlers.set(
      ConditionType.ORDER_CHECK,
      new ConditionOrderCheckHandler(
        this.orderRepo,
        this.ordersService,
        this.clientsService,
      ),
    );
    this.handlers.set(
      ActionType.UPDATE_ORDER_STATUS,
      new ActionUpdateOrderStatusHandler(this.adapter, this.orderRepo),
    );
    this.handlers.set(
      ActionType.AI_ADDRESS_CORRECTION,
      new ActionAiAddressCorrectionHandler(
        this.orderRepo,
        this.userRepo,
        this.aiOrchestrator,
        this.clientSettingsService,
        this.aiProviderRepo,
        this.aiModelRepo,
        this.aiAvailabilityRepo,
        this.whatsappService,
        this.messageRepo,
      ),
    );
    this.handlers.set(
      ActionType.ASSIGN_SHIPPING_PROVIDER,
      new ActionAssignShippingProviderHandler(
        this.orderRepo,
        this.adapter,
      ),
    );
    this.handlers.set(
      ActionType.SEND_WHATSAPP_TEMPLATE,
      new ActionSendWhatsappTemplateMessageHandler(
        this.adapter,
        this.orderRepo,
        this.messageRepo,
        this.userRepo,
        this.clientSettingsService,
        this.automationQueueService,
      ),
    );
    this.handlers.set(
      ActionType.SEND_WHATSAPP_MESSAGE,
      new ActionSendWhatsappMessageHandler(
        this.adapter,
        this.orderRepo,
        this.messageRepo,
        this.whatsappService,
        this.userRepo,
        this.clientSettingsService,
        this.automationQueueService,
      ),
    );
    this.handlers.set(
      ActionType.SEND_UPSELL,
      new ActionSendUpsellHandler(
        this.adapter,
        this.orderRepo,
        this.messageRepo,
        this.userRepo,
        this.clientSettingsService,
        this.automationQueueService,
      ),
    );
    this.handlers.set(
      ActionType.ASSIGN_ORDER_TO_EMPLOYEE,
      new ActionAssignOrderToEmployeeHandler(
        this.adapter,
        this.orderRepo,
        this.orderAssignmentRepo,
        this.ordersService,
      ),
    );
    this.handlers.set(
      ActionType.SEND_SMS,
      new ActionSendSmsHandler(
        this.adapter,
        this.orderRepo,
        this.userRepo,
        this.clientSettingsService,
      ),
    );
    this.handlers.set(
      ActionType.CREATE_ISSUE,
      new ActionCreateIssueHandler(
        this.adapter,
        this.orderRepo,
        this.userRepo,
        this.clientSettingsService,
      ),
    );
    this.handlers.set(
      ActionType.ASSIGN_ORDER_TO_CLIENT,
      new ActionAssignOrderToClientHandler(this.adapter, this.orderRepo),
    );
    this.handlers.set(
      ActionType.WAIT,
      new ActionWaitHandler(this.orderRepo, this.automationQueueService),
    );
  }

  /**
   * الدالة التي يستدعيها المحرك (EngineRunnerService) لجلب المعالج
   */
  getHandler(nodeType: FlowNodeDataType): FlowNodeHandler {
    const handler = this.handlers.get(nodeType);

    if (!handler) {
      throw new NotFoundException(
        `No execution handler registered for node type: ${nodeType}`,
      );
    }

    return handler;
  }
}
