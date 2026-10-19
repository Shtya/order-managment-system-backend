import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpSaveTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { AutomationService } from "src/automation/automation.service";
import {
  AUTOMATION_STEP_ID_SET,
  AUTOMATION_STEP_IDS,
  buildAutomationStepsCatalog,
} from "../catalogs/automation-steps.catalog";
import { rewriteEdgeHandles } from "../catalogs/automation-branches";
import { validateAndNormalizeNodes } from "../catalogs/automation-save.validator";
import { saveFlowEdgeInput, saveFlowInput, saveFlowNodeInput } from "./automation-flow-inputs";
import {
  ActionType,
  AutomationStatus,
  ConditionType,
  RunStatus,
  TriggerEntityType,
  TriggerType,
} from "entities/automation.entity";
import { CreateAutomationDto, UpdateAutomationDto } from "dto/automation.dto";
import {
  listPaging,
  parseDto,
  parseSaveInput,
  parseSearchInput,
  resolveToolDates,
  searchInput,
} from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, ref, TOOL } from "../utils/mcp-tool-names";
import { isoDateField, uuidField } from "../utils/mcp-date.util";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS
//    Preview / Excel never offered. Get returns nodes with config plus
//    edges so the model can follow the flow. No canvas position/measured.
// ═══════════════════════════════════════════════════════════════

const runStatusCodes = Object.values(RunStatus).join(", ");
const runStatusSet = new Set<string>(Object.values(RunStatus));
const csvRunStatus = (description: string) =>
  z
    .string()
    .refine(
      (v) =>
        v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .every((code) => runStatusSet.has(code)),
      { message: `Unknown run status. Use one of: ${runStatusCodes}.` },
    )
    .optional()
    .describe(description);

const automationStatsInput = z.strictObject({
  report: z
    .enum(["flows", "runs"])
    .optional()
    .describe("Which stats to return. flows (default): flow list header { total, published, draft, paused, archived }. runs: logs header { total, pending, running, completed, failed, paused }. No dates."),
});

const searchAutomationsInput = searchInput("automation", {
  ...listPaging({
    items: "automations",
    sortBy: ["createdAt", "name", "status"],
    defaultSortBy: "createdAt",
    search: "Matches automation name",
  }),
  status: z.enum(AutomationStatus).optional().describe("Keep flows with this status"),
  triggerType: z.enum(TriggerType).optional().describe("Keep flows with this trigger"),
}, TOOL.automation.search);

const automationActInput = z.object({
  id: uuidField(idDescription("Automation flow id.", TOOL.automation.search)),
  active: z
    .boolean()
    .describe("true = activate the automation, false = deactivate it. Active maps to published and inactive maps to paused."),
});

const searchRunsInput = searchInput("automation run", {
  ...listPaging({
    items: "automation runs",
    sortBy: ["startedAt", "status", "completedAt"],
    defaultSortBy: "startedAt",
    search: "Matches trigger entity id (order id)",
  }),
  status: csvRunStatus(
    `Run status. One of: ${runStatusCodes}. Comma-separate several. The running page uses running,pending,failed,paused.`,
  ),
  triggerType: z.enum(TriggerType).optional().describe("Keep runs whose flow has this trigger"),
  automationFlowId: uuidField(idDescription("Automation flow id.", TOOL.automation.search)).optional(),
  triggerEntityType: z.enum(TriggerEntityType).optional().describe("Trigger entity type, usually order"),
  entityId: z.string().optional().describe("Trigger entity id (order id). Same as search when looking up one order."),
  startDate: isoDateField("Started-at range start, ISO date (YYYY-MM-DD)").optional(),
  endDate: isoDateField("Started-at range end, ISO date (YYYY-MM-DD)").optional(),
}, TOOL.automation.runsSearch);

const stepsListInput = z.strictObject({
  kind: z
    .enum(["trigger", "action", "condition"])
    .optional()
    .describe("Keep only this kind of step. Omit for the full catalog."),
  type: z
    .string()
    .optional()
    .describe(`One step id (${AUTOMATION_STEP_IDS.join(", ")}). Returns that step plus order-check fields when type is order_check.`),
});

const runsRetryInput = z.object({
  id: uuidField(idDescription("Failed run UUID.", TOOL.automation.runsSearch, "Only FAILED runs are retriable.")),
  useLatestVersion: z
    .boolean()
    .optional()
    .describe("Retry on the flow's latest version and reset node progress. Omit to retry the same version."),
});

export 
const saveAutomationInput = z.strictObject({
  mode: z.enum(["create", "update"]).describe("Required. Never infer it from id."),
  id: uuidField(idDescription("Automation flow id.", TOOL.automation.search, "Required for update."))
    .optional()
    .describe("Required with mode=update; forbidden with mode=create."),
  name: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe("Flow name, unique per tenant. Required on create; not updatable."),
  triggerType: z
    .enum(TriggerType)
    .optional()
    .describe("Create only. Omit to use the trigger node's data.type; if sent it must match that node."),
  publish: z
    .boolean()
    .optional()
    .describe("Create only. true = published, false/omitted = draft. Updates auto-publish a draft."),
  flow: saveFlowInput,
});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: flow nodes+edges+config. No canvas layout, no run payload blobs.
// ═══════════════════════════════════════════════════════════════

function slimFlow(flow: any) {
  const nodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
  const edges = Array.isArray(flow?.edges) ? flow.edges : [];
  const whatsapp = flow?.whatsapp;
  return {
    nodesCount: nodes.length,
    edgesCount: edges.length,
    whatsapp: whatsapp
      ? {
          mode: whatsapp.mode ?? null,
          accountId: whatsapp.accountId ?? null,
        }
      : null,
    nodes: nodes.map((n: any) => ({
      id: n?.id ?? null,
      type: n?.type ?? null,
      dataType: n?.data?.type ?? n?.data?.dataType ?? null,
      label: n?.data?.label ?? null,
      config: n?.data?.config ?? {},
    })),
    edges: edges.map((e: any) => ({
      id: e?.id ?? null,
      source: e?.source ?? null,
      target: e?.target ?? null,
      sourceHandle: e?.sourceHandle ?? null,
      targetHandle: e?.targetHandle ?? null,
    })),
  };
}

function toVersionSummary(version: any) {
  if (!version) return null;
  return {
    id: version.id ?? null,
    versionString: version.versionString ?? null,
    ...slimFlow(version.flow),
  };
}

function toAutomationSummary(row: any) {
  return {
    id: row.id,
    name: row.name ?? null,
    triggerType: row.triggerType ?? null,
    status: row.status ?? null,
    latestVersionId: row.latestVersionId ?? row.latestVersion?.id ?? null,
    latestVersion: row.latestVersion
      ? { id: row.latestVersion.id ?? null, versionString: row.latestVersion.versionString ?? null }
      : null,
    createdAt: row.createdAt ?? null,
  };
}

function toAutomationDto(row: any) {
  const version = Array.isArray(row?.versions) && row.versions.length ? row.versions[0] : row?.latestVersion;
  return {
    id: row.id,
    name: row.name ?? null,
    triggerType: row.triggerType ?? null,
    status: row.status ?? null,
    latestVersionId: row.latestVersionId ?? version?.id ?? null,
    version: toVersionSummary(version),
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

function currentNodeLabel(row: any) {
  const nodes = Array.isArray(row?.version?.flow?.nodes) ? row.version.flow.nodes : [];
  const current = nodes.find((n: any) => n?.id === row?.currentNodeId);
  return current?.data?.label ?? row?.currentNodeId ?? null;
}

function toRunSummary(row: any) {
  const completed = Array.isArray(row?.completedNodeIds) ? row.completedNodeIds : [];
  return {
    id: row.id,
    status: row.status ?? null,
    automationFlowId: row.automationFlowId ?? row.automationFlow?.id ?? null,
    automationName: row.automationFlow?.name ?? null,
    triggerType: row.automationFlow?.triggerType ?? null,
    versionId: row.versionId ?? row.version?.id ?? null,
    versionString: row.version?.versionString ?? null,
    triggerEntityType: row.triggerEntityType ?? null,
    triggerEntityId: row.triggerEntityId ?? null,
    currentNodeId: row.currentNodeId ?? null,
    currentNodeLabel: currentNodeLabel(row),
    completedSteps: completed.length,
    errorMessage: row.errorMessage ?? null,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
  };
}

function toRunDto(row: any) {
  const steps = Array.isArray(row?.steps) ? row.steps : [];
  const completed = Array.isArray(row?.completedNodeIds) ? row.completedNodeIds : [];
  return {
    ...toRunSummary(row),
    whatsappAccountId: row.whatsappAccountId ?? null,
    whatsappAccountName: row.whatsappAccountName ?? null,
    whatsappAccountPhone: row.whatsappAccountPhone ?? null,
    completedNodeIds: completed,
    version: toVersionSummary(row.version),
    steps: steps.map((s: any) => ({
      id: s.id ?? null,
      nodeId: s.nodeId ?? null,
      nodeType: s.nodeType ?? null,
      dataType: s.dataType ?? null,
      status: s.status ?? null,
      errorMessage: s.errorMessage ?? null,
      executedAt: s.executedAt ?? null,
      executionTimeMs: s.executionTimeMs ?? null,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpAutomationTools {
  constructor(private automation: AutomationService) {}

  @McpReadTool({
    name: TOOL.automation.stats,
    description:
      `Automation headers. Pass \`report\`: flows (default) or runs. No date filters. Flow/run rows are on ${ref(TOOL.automation.search)} / ${ref(TOOL.automation.runsSearch)}. Extra fields (e.g. startDate) are rejected. Read-only.`,
    parameters: automationStatsInput,
  })
  async getStats(
    @Payload() input: z.infer<typeof automationStatsInput>,
    @McpUser() user: User,
  ) {
    const report = (input as any)?.report ?? "flows";
    if (report === "runs") {
      return toolJson({ report, ...(await this.automation.getRunsStats(user)) });
    }
    return toolJson({ report, ...(await this.automation.getFlowsStats(user)) });
  }

  @McpReadTool({
    name: TOOL.automation.stepsList,
    description:
      `Builder catalog for automation steps. One call returns: a definitions block (what an automation is, what trigger/action/condition mean, flow statuses, the branch contract, and the placeholder syntax with every allowed order/global path and when to use it), then the filtered steps with id, title/description, configSchema (JSON Schema with lookups/enums) or config key list, and the step's branches (fixed + dynamic) with the exact sourceHandle to use on outgoing edges. Optional kind or type. Fields that accept {{path}} tokens are marked supportsPlaceholders: true; fields that take a raw path are marked placeholderPath: true. ` +
      `FLOW GRAPH CONTRACT — what a saved automation is. A flow is { nodes: [...], edges: [...], whatsapp?: { mode: "random"|"fixed", accountId } }. A node is { id, type: "trigger"|"action"|"condition", data: { type, label, config } } where data.type is a step id from this catalog of that same kind, data.label is a short name for the step instance (save defaults it to the step title), and config carries the step's settings exactly as described in this catalog. An edge is { id, source, target, sourceHandle? }. Rules: exactly one trigger node; the trigger has no incoming edges; every other node needs at least one incoming edge; every node must be reachable from the trigger through edges; the graph must be acyclic; node ids and edge ids are unique, arbitrary strings (e.g. "n1", "e1"); 2-100 nodes; each edge's source/target must be an existing node id. Branches are derived by the server from each step's config — never write data.config.branches. When a step's branches list is non-empty, every outgoing edge must set sourceHandle to one of those branch ids (the common "yes"/"no" condition handles and button labels are remapped automatically); when the step has no branches, omit sourceHandle. Canvas position is layout metadata only and never affects execution; an "*Id"-suffixed config value must be a real UUID (or one of a step's well-known literal values) from the lookup tools below — never a name and never a guess. ` +
      `Existing flow graphs (worked examples with real configs and correct edge handles) are on ${ref(TOOL.automation.search)}. Config ids: ${ref(TOOL.stores.list)}, ${ref(TOOL.orderStatuses.list)}, ${ref(TOOL.shippingCompanies.list)} (use providerId), ${ref(TOOL.whatsapp.templatesSearch)}, ${ref(TOOL.whatsapp.accountsSearch)}, ${ref(TOOL.employees.list)}, ${ref(TOOL.cancelCauses.list)}, ${ref(TOOL.issues.lookupsList)}, ${ref(TOOL.roles.list)}, ${ref(TOOL.cities.list)}, ${ref(TOOL.ai.providersList)} (providerId), ${ref(TOOL.agents.list)} (agentId). Steps with a configSchema carry the exact config fields, enums, required flags, defaults, and lookupTool hints. Read-only. Create and edit flows with ${ref(TOOL.automation.save)}.`,
    parameters: stepsListInput,
  })
  async listSteps(@Payload() input: z.infer<typeof stepsListInput>) {
    const type = (input as any)?.type as string | undefined;
    if (type && !AUTOMATION_STEP_ID_SET.has(type as TriggerType | ConditionType | ActionType)) {
      throw new RpcException(`Unknown step type "${type}". Use one of: ${AUTOMATION_STEP_IDS.join(", ")}.`);
    }
    return toolJson(buildAutomationStepsCatalog({ kind: (input as any)?.kind, type }));
  }

  @McpReadTool({
    name: TOOL.automation.search,
    description:
      `Search automation flows or fetch one. Without \`id\`: paged list filtered by name, status, or triggerType (same as the Automations page). With \`id\`: that flow's latest version with nodes (type, dataType, label, config) and edges (source/target/handles) so the step graph can be followed. Step types and config fields: ${ref(TOOL.automation.stepsList)}. No canvas layout. Read-only. Create or edit with ${ref(TOOL.automation.save)}.`,
    parameters: searchAutomationsInput,
  })
  async searchAutomations(
    @Payload() input: z.infer<typeof searchAutomationsInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "automation");
    if (req.mode === "get") {
      return toolJson(toAutomationDto(await this.automation.findOne(user, req.id)));
    }
    const q = req.query;
    const result = await this.automation.findAll(user, {
      ...q,
      sortDir: (q as any).sortOrder,
    });
    return toolPage("automations", result, toAutomationSummary, (q as any).limit);
  }

  @McpSaveTool({
    name: TOOL.automation.save,
    description:
      `Create or update an automation flow, validated like the REST API. Required: mode. ` +
      `mode=create: name + flow; optional triggerType (omit to use the trigger node's data.type) and publish (default false). ` +
      `mode=update: id + the full flow (it replaces the current one; a draft auto-publishes). name/triggerType/publish are create-only. ` +
      `Step ids, configSchema, branch sourceHandles, and placeholder markers are on ${ref(TOOL.automation.stepsList)}; lookup ids come from the tools it names; worked graphs are on ${ref(TOOL.automation.search)}. ` +
      `Send only the graph: labels default to the step title, and step branches are derived server-side (do not send data.config.branches; edges only reference the branch ids listed on ${ref(TOOL.automation.stepsList)}). ` +
      `Position is optional. You may send it as a UI hint to help place nodes, or ignore it and let the editor arrange the layout. No file uploads: use public HTTPS URLs or media ids from lookup tools.`,
    parameters: saveAutomationInput,
  })
  async saveAutomation(
    @Payload() input: z.infer<typeof saveAutomationInput>,
    @McpUser() user: User,
  ) {
    const req = parseSaveInput(input, "automation", TOOL.automation.search);
    const fields = req.fields as Omit<z.infer<typeof saveAutomationInput>, "mode" | "id">;

    if (req.mode === "update") {
      const createOnly = (["name", "triggerType", "publish"] as const).filter(
        (key) => fields[key] !== undefined,
      );
      if (createOnly.length) {
        throw new RpcException(
          `${createOnly.join(", ")} ${createOnly.length === 1 ? "is" : "are"} create-only. Remove ${createOnly.join(", ")} or use mode=create.`,
        );
      }
    } else if (!fields.name) {
      throw new RpcException(`mode=create requires \`name\` (unique per tenant).`);
    }

    const validation = validateAndNormalizeNodes(fields.flow.nodes);
    if (!validation.ok) {
      throw new RpcException(`Invalid node config. ${validation.errors.join(" ")}`);
    }

    const edgeRewrite = rewriteEdgeHandles(
      fields.flow.edges,
      validation.nodes,
      validation.previousBranches,
    );
    if (edgeRewrite.errors.length) {
      throw new RpcException(`Invalid branch handle. ${edgeRewrite.errors.join(" ")}`);
    }

    const flow = {
      nodes: validation.nodes,
      edges: edgeRewrite.edges,
      ...(fields.flow.whatsapp ? { whatsapp: fields.flow.whatsapp } : {}),
    };

    if (req.mode === "create") {
      const triggerNode = validation.nodes.find((node) => node.type === "trigger");
      if (!triggerNode) {
        throw new RpcException(
          `Automation flow needs exactly one trigger node: a node with type "trigger" whose data.type is a trigger step.`,
        );
      }
      const derived = triggerNode.data.type;
      if (!Object.values(TriggerType).includes(derived as TriggerType)) {
        throw new RpcException(
          `Trigger node data.type "${derived}" is not a trigger. Use one of: ${Object.values(TriggerType).join(", ")}.`,
        );
      }
      if (fields.triggerType && fields.triggerType !== derived) {
        throw new RpcException(
          `triggerType "${fields.triggerType}" does not match the trigger node "${derived}". Omit triggerType or align them.`,
        );
      }

      const parsed = await parseDto(CreateAutomationDto, {
        name: fields.name,
        triggerType: fields.triggerType ?? derived,
        flow,
        ...(fields.publish !== undefined ? { publish: fields.publish } : {}),
      });
      if (parsed.ok === false) throw new RpcException(parsed.message);
      return toolJson(toAutomationDto(await this.automation.create(user, parsed.dto)));
    }

    const parsed = await parseDto(UpdateAutomationDto, { flow });
    if (parsed.ok === false) throw new RpcException(parsed.message);
    const result: any = await this.automation.update(user, req.id, parsed.dto);
    return toolJson({
      ...toAutomationDto(result),
      ...(result?.skipped ? { skipped: true, message: result.message ?? null } : {}),
    });
  }

  @McpSaveTool({
    name: TOOL.automation.act,
    description:
      `Activate or deactivate one automation. Required: id and active. true => published (active), false => paused (inactive). This tool does only one thing: it switches the flow between active and inactive states.`,
    parameters: automationActInput,
  })
  async actAutomation(
    @Payload() input: z.infer<typeof automationActInput>,
    @McpUser() user: User,
  ) {
    const nextStatus = input.active ? AutomationStatus.PUBLISHED : AutomationStatus.PAUSED;
    const result = await this.automation.changeStatus(user, input.id, nextStatus);
    return toolJson({
      id: result.id,
      status: result.status,
      active: result.status === AutomationStatus.PUBLISHED,
    });
  }

  @McpReadTool({
    name: TOOL.automation.runsSearch,
    description:
      `Search automation runs (logs + running queue) or fetch one. Without \`id\`: paged rows filtered by status (CSV), triggerType, flow id, entity id, or dates. Running tab: status running,pending,failed,paused. With \`id\`: that run with steps plus the version graph (node configs and edges). No execution payload blobs. Retry a failed run with ${ref(TOOL.automation.runsRetry)}. Read-only.`,
    parameters: searchRunsInput,
  })
  async searchRuns(
    @Payload() input: z.infer<typeof searchRunsInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "automation run");
    if (req.mode === "get") {
      return toolJson(toRunDto(await this.automation.findOneRun(user, req.id)));
    }
    const dates = resolveToolDates(req.query as any);
    const q = req.query as typeof req.query & { entityId?: string };
    const result = await this.automation.findAllRuns(user, {
      ...q,
      startDate: dates.startDate,
      endDate: dates.endDate,
      sortDir: (q as any).sortOrder,
    });
    return toolPage("runs", result, toRunSummary, (q as any).limit);
  }

  @McpSaveTool({
    name: TOOL.automation.runsRetry,
    description:
      `Retry a failed automation run (dedicated action, not save). Required: id of a FAILED run from ${ref(TOOL.automation.runsSearch)}. Optional useLatestVersion. Only failed runs are retriable; the service errors otherwise. Returns the run id, status, flow and version ids with the queue message. No execution state dump.`,
    parameters: runsRetryInput,
  })
  async retryRun(
    @Payload() input: z.infer<typeof runsRetryInput>,
    @McpUser() user: User,
  ) {
    const result = await this.automation.retryRun(user, input.id, (input as any).useLatestVersion);
    const run = (result as any)?.run ?? {};
    return toolJson({
      id: run.id ?? input.id,
      status: run.status ?? null,
      automationFlowId: run.automationFlowId ?? null,
      versionId: run.versionId ?? null,
      errorMessage: run.errorMessage ?? null,
      message: (result as any)?.message ?? null,
    });
  }
}
