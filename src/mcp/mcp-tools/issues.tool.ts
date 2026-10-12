import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpSaveTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { IssuePriority } from "entities/issue.entity";
import { IssueService } from "src/issue/issue.service";
import { CreateIssueDto, UpdateIssueDto } from "dto/issue.dto";
import { listPaging, parseDto, parseSaveInput, parseSearchInput, searchInput } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, TOOL } from "../utils/mcp-tool-names";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS
//    Service sorts created_at/updated_at/last_message_at/priority/
//    due_at at SQL: advertise exactly those.
//    Status/priority changes after create go through issues_act.
// ═══════════════════════════════════════════════════════════════

const searchIssuesInput = searchInput("issue", {
  ...listPaging({
    items: "issues",
    sortBy: ["created_at", "updated_at", "last_message_at", "priority", "due_at"],
    defaultSortBy: "created_at",
    search: "Matches title, customer name, or customer phone",
  }),
  statusId: z
    .string()
    .optional()
    .describe(idDescription("Issue status id.", TOOL.issues.lookupsList)),
  causeId: z
    .string()
    .optional()
    .describe(idDescription("Issue cause id.", TOOL.issues.lookupsList)),
  priority: z.enum(IssuePriority).optional().describe("Keep issues with this priority"),
  assignedRoleId: z.string().optional().describe(idDescription("Role id issues are assigned to.", TOOL.roles.list)),
  assignedEmployeeId: z
    .string()
    .optional()
    .describe(idDescription("Employee id assigned to the issue.", TOOL.employees.list)),
}, TOOL.issues.search);

// Update DTO keeps assignedRoleId required: flat save stays plain
// z.object; Create/Update DTOs enforce at runtime.
const saveIssueFields = z.object({
  title: z.string().optional().describe("Ticket title. Required for create"),
  description: z.string().optional().describe("What the ticket is about"),
  orderId: z
    .string()
    .optional()
    .describe(idDescription("Order id for an order ticket. Omit for a general ticket.", TOOL.orders.search)),
  causeId: z
    .string()
    .optional()
    .describe(idDescription("Issue cause id.", TOOL.issues.lookupsList)),
  priority: z.enum(IssuePriority).optional().describe("Priority. Allowed on create; changes after create go through issues_act."),
  statusId: z
    .string()
    .optional()
    .describe(idDescription("Status id. Create only; changes after create go through issues_act.", TOOL.issues.lookupsList)),
  assignedRoleId: z.string().optional().describe(idDescription("Role id. Required for create.", TOOL.roles.list)),
  employeeIds: z.array(z.string()).optional().describe(idDescription("Employee ids to assign.", TOOL.employees.list)),
  estimatedMinutes: z.number().int().min(1).optional().describe("Time estimate in minutes"),
});

const saveIssueInput = z.object({
  mode: z
    .enum(["create", "update"])
    .describe(
      'Required. "create" to open a ticket. "update" to edit title/description/cause/assignees/estimate. Never infer from id.',
    ),
  id: z
    .string()
    .min(1)
    .optional()
    .describe(
      idDescription("Issue ID.", TOOL.issues.search, "Required for mode=update. Forbidden for mode=create."),
    ),
  ...saveIssueFields.shape,
});

const issuesStatsInput = z.object({
  report: z
    .enum(["overview", "causes", "board"])
    .optional()
    .describe("Which report to return. overview (default): ticket statistics. causes: cause statistics. board: counts per status."),
});

const issuesActInput = z.object({
  id: z.string().min(1).describe(idDescription("Issue ID.", TOOL.issues.search)),
  action: z.enum(["set_status", "set_priority", "assign"]).describe('Required. "set_status" to move the ticket. "set_priority" to reprioritize. "assign" to reassign.'),
  statusId: z.string().optional().describe(idDescription("New status id. Required for action=set_status.", TOOL.issues.lookupsList)),
  priority: z.enum(IssuePriority).optional().describe("New priority. Required for action=set_priority."),
  assignedRoleId: z.string().optional().describe(idDescription("New role id for action=assign.", TOOL.roles.list)),
  employeeIds: z.array(z.string()).optional().describe(idDescription("Employee ids for action=assign.", TOOL.employees.list)),
  assignedEmployeeIds: z.array(z.string()).optional().describe(idDescription("Employee ids for action=assign (alias).", TOOL.employees.list)),
});

const issuesLookupsInput = z.object({
  kind: z.enum(["status", "cause"]).describe('Required. "status" for issue statuses, "cause" for issue causes.'),
  search: z.string().optional().describe("Matches status or cause name"),
});

const isSet = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS
//    Get merges ticket + order/customer + status/cause + assignees +
//    last messages + short activity. Read-only (never mark-read).
// ═══════════════════════════════════════════════════════════════

function toIssueSummary(row: any) {
  return {
    id: row.id,
    title: row.title ?? null,
    status: row.status ? { id: row.status.id ?? null, name: row.status.nameEn ?? row.status.name ?? null } : null,
    cause: row.cause ? { id: row.cause.id ?? null, name: row.cause.nameEn ?? null } : null,
    priority: row.priority ?? null,
    orderNumber: row.order?.orderNumber ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null,
  };
}

function toIssueResultDto(row: any, extra?: { messages?: unknown[]; activity?: unknown[] }) {
  const users = Array.isArray(row?.users) ? row.users : [];
  const messages = Array.isArray(extra?.messages) ? extra!.messages! : [];
  const activity = Array.isArray(extra?.activity) ? extra!.activity! : [];
  return {
    id: row.id,
    title: row.title ?? null,
    description: row.description ?? null,
    priority: row.priority ?? null,
    status: row.status ? { id: row.status.id ?? null, name: row.status.nameEn ?? row.status.name ?? null } : null,
    cause: row.cause ? { id: row.cause.id ?? null, name: row.cause.nameEn ?? null } : null,
    order: row.order ? { id: row.order.id ?? row.orderId ?? null, orderNumber: row.order.orderNumber ?? null } : null,
    customer: { name: row.customerName ?? row.customer?.name ?? null, phone: row.customerPhone ?? null },
    assignedRole: row.assignedRole ? { id: row.assignedRole.id ?? row.assignedRoleId ?? null, name: row.assignedRole.name ?? null } : null,
    assignees: users.map((u: any) => ({ id: u.user?.id ?? u.userId ?? null, name: u.user?.name ?? null })),
    lastMessages: messages.map((m: any) => ({
      id: m.id ?? null,
      message: m.message ?? m.body ?? null,
      createdAt: m.created_at ?? m.createdAt ?? null,
    })),
    activity: activity.map((a: any) => ({ id: a.id ?? null, type: a.type ?? a.action ?? null, createdAt: a.created_at ?? a.createdAt ?? null })),
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpIssuesTools {
  constructor(private issues: IssueService) {}

  @McpReadTool({
    name: TOOL.issues.search,
    description:
      "Search support tickets or fetch one. Without `id`: paged summaries filtered by search text, status, cause, priority, role, or assignee. With `id`: returns that ticket with order, customer, status, cause, assignees, last messages, and short activity. Read-only, never marks as read.",
    parameters: searchIssuesInput,
  })
  async searchIssues(
    @Payload() input: z.infer<typeof searchIssuesInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "issue");
    if (req.mode === "get") {
      const [issue, messages, activity] = await Promise.all([
        this.issues.get(user, req.id),
        this.issues.getMessages(user, req.id, { page: 1, limit: 5 }).catch(() => []),
        this.issues.getActivity(user, req.id).catch(() => []),
      ]);
      const msgRows = Array.isArray((messages as any)?.records) ? (messages as any).records : Array.isArray(messages) ? messages : [];
      const actRows = Array.isArray(activity) ? activity.slice(0, 10) : [];
      return toolJson(toIssueResultDto(issue, { messages: msgRows.slice(0, 5), activity: actRows }));
    }
    const result = await this.issues.list(user, req.query);
    return toolPage("issues", result, toIssueSummary, req.query.limit);
  }

  @McpSaveTool({
    name: TOOL.issues.save,
    description:
      'Create or edit a ticket. Required: mode ("create" or "update"). Required for create: title, assignedRoleId. Optional: description, orderId, causeId, priority, statusId, employeeIds, estimatedMinutes. For update: `id` plus title/description/cause/assignees/estimate. Status/priority changes after create go through issues_act, not save. No replies, no delete.',
    parameters: saveIssueInput,
  })
  async saveIssue(
    @Payload() input: z.infer<typeof saveIssueInput>,
    @McpUser() user: User,
  ) {
    const req = parseSaveInput(input, "issue", TOOL.issues.search);
    if (req.mode === "create") {
      const parsed = await parseDto(CreateIssueDto, req.fields);
      if (parsed.ok === false) throw new RpcException(parsed.message);
      const created = await this.issues.create(user, parsed.dto);
      return toolJson(toIssueResultDto(created));
    }
    if (isSet((req.fields as any).priority) || isSet((req.fields as any).statusId)) {
      throw new RpcException("Status/priority changes go through issues_act, not save. Remove priority/statusId or call issues_act.");
    }
    const parsed = await parseDto(UpdateIssueDto, req.fields);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    return toolJson(toIssueResultDto(await this.issues.update(user, req.id, parsed.dto)));
  }

  @McpReadTool({
    name: TOOL.issues.stats,
    description:
      "Ticket statistics. Pass `report`: overview (default — ticket statistics), causes (cause statistics), board (counts per status). Read-only.",
    parameters: issuesStatsInput,
  })
  async getIssuesStats(
    @Payload() input: z.infer<typeof issuesStatsInput>,
    @McpUser() user: User,
  ) {
    const report = (input as any)?.report ?? "overview";
    if (report === "causes") return toolJson({ report, ...(await this.issues.getCausesStats(user)) });
    if (report === "board") return toolJson({ report, ...(await this.issues.board(user, {})) });
    return toolJson({ report, ...(await this.issues.getStats(user)) });
  }

  @McpSaveTool({
    name: TOOL.issues.act,
    description:
      "Move, reprioritize, or reassign a ticket. Required: id, action. action=set_status needs statusId. action=set_priority needs priority. action=assign needs assignedRoleId and/or employee ids. No delete, no mark_read.",
    parameters: issuesActInput,
  })
  async actOnIssue(
    @Payload() input: z.infer<typeof issuesActInput>,
    @McpUser() user: User,
  ) {
    if (input.action === "set_status") {
      if (!isSet(input.statusId)) throw new RpcException("action=set_status requires `statusId`. Use issues_lookups_list to find it.");
      return toolJson(toIssueResultDto(await this.issues.changeStatus(user, input.id, { statusId: input.statusId })));
    }
    if (input.action === "set_priority") {
      if (!isSet(input.priority)) throw new RpcException("action=set_priority requires `priority`.");
      return toolJson(toIssueResultDto(await this.issues.changePriority(user, input.id, { priority: input.priority })));
    }
    const dto = {
      ...(isSet(input.assignedRoleId) ? { assignedRoleId: input.assignedRoleId } : {}),
      ...(isSet(input.employeeIds) ? { employeeIds: input.employeeIds } : {}),
      ...(isSet(input.assignedEmployeeIds) ? { assignedEmployeeIds: input.assignedEmployeeIds } : {}),
    };
    if (Object.keys(dto).length === 0) {
      throw new RpcException("action=assign requires assignedRoleId and/or employee ids.");
    }
    return toolJson(toIssueResultDto(await this.issues.assign(user, input.id, dto)));
  }

  @McpReadTool({
    name: TOOL.issues.lookupsList,
    description: "List issue statuses or causes. Pass kind=status for statuses, kind=cause for causes. Read-only, no save.",
    parameters: issuesLookupsInput,
  })
  async listIssueLookups(
    @Payload() input: z.infer<typeof issuesLookupsInput>,
    @McpUser() user: User,
  ) {
    if (input.kind === "cause") {
      const rows = await this.issues.getCauses(user, { search: (input as any).search });
      const records = Array.isArray(rows) ? rows : [];
      return toolJson({
        causes: records.map((r: any) => ({
          id: r.id ?? null,
          nameEn: r.nameEn ?? null,
          nameAr: r.nameAr ?? null,
          sortOrder: Number(r.sortOrder ?? 0),
        })),
      });
    }
    const rows = await this.issues.getStatuses(user, { search: (input as any).search });
    const records = Array.isArray(rows) ? rows : [];
    return toolJson({
      statuses: records.map((r: any) => ({
        id: r.id ?? null,
        nameEn: r.nameEn ?? null,
        nameAr: r.nameAr ?? null,
        sortOrder: Number(r.sortOrder ?? 0),
      })),
    });
  }
}
