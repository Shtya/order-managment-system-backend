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
import { uuidField } from "../utils/mcp-date.util";

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
  statusId: uuidField(idDescription("Issue status id.", TOOL.issues.lookupsList)).optional(),
  causeId: uuidField(idDescription("Issue cause id.", TOOL.issues.lookupsList)).optional(),
  priority: z.enum(IssuePriority).optional().describe("Keep issues with this priority"),
  assignedRoleId: uuidField(idDescription("Role id issues are assigned to.", TOOL.roles.list)).optional(),
  assignedEmployeeId: uuidField(idDescription("Employee id assigned to the issue.", TOOL.employees.list)).optional(),
}, TOOL.issues.search);

// Update DTO keeps assignedRoleId required: save fills it from the
// current ticket when omitted. Create/Update DTOs enforce at runtime.
const saveIssueFields = z.object({
  title: z.string().optional().describe("Ticket title. Required for create"),
  description: z.string().optional().describe("What the ticket is about"),
  orderId: uuidField(idDescription("Order id for an order ticket. Omit for a general ticket.", TOOL.orders.search)).optional(),
  causeId: uuidField(idDescription("Issue cause id.", TOOL.issues.lookupsList)).optional(),
  priority: z.enum(IssuePriority).optional().describe("Priority. Allowed on create; changes after create go through issues_act."),
  statusId: uuidField(idDescription("Status id. Create only; changes after create go through issues_act.", TOOL.issues.lookupsList)).optional(),
  assignedRoleId: uuidField(idDescription("Role id. Required for create. On update, omit to keep the current role.", TOOL.roles.list)).optional(),
  employeeIds: z.array(uuidField(idDescription("Employee ids to assign.", TOOL.employees.list))).optional(),
  estimatedMinutes: z.number().int().min(1).optional().describe("Time estimate in minutes"),
});

const saveIssueInput = z.object({
  mode: z
    .enum(["create", "update"])
    .describe(
      'Required. "create" to open a ticket. "update" to edit title/description/cause/assignees/estimate. Never infer from id.',
    ),
  id: uuidField(idDescription("Issue ID.", TOOL.issues.search, "Required for mode=update. Forbidden for mode=create.")).optional(),
  ...saveIssueFields.shape,
});

const issuesStatsInput = z.strictObject({
  report: z
    .enum(["overview", "causes", "board"])
    .optional()
    .describe("Which report to return. overview (default): ticket statistics. causes: cause statistics. board: counts per status."),
});

const issuesActInput = z.object({
  id: uuidField(idDescription("Issue ID.", TOOL.issues.search)),
  action: z.enum(["set_status", "set_priority", "assign"]).describe('Required. "set_status" to move the ticket. "set_priority" to reprioritize. "assign" to reassign.'),
  statusId: uuidField(idDescription("New status id. Required for action=set_status.", TOOL.issues.lookupsList)).optional(),
  priority: z.enum(IssuePriority).optional().describe("New priority. Required for action=set_priority."),
  assignedRoleId: uuidField(idDescription("New role id for action=assign.", TOOL.roles.list)).optional(),
  employeeIds: z.array(uuidField(idDescription("Employee ids for action=assign.", TOOL.employees.list))).optional(),
  assignedEmployeeIds: z.array(uuidField(idDescription("Employee ids for action=assign (alias).", TOOL.employees.list))).optional(),
});

const issuesLookupsInput = z.strictObject({
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
    estimatedMinutes: row.estimatedMinutes ?? null,
    dueAt: row.due_at ?? row.dueAt ?? null,
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

  /** Service mutations return `{ success, message, data }` without relations; re-read the full ticket. */
  private async loadIssueResult(user: User, result: any) {
    const id = result?.data?.id ?? result?.id;
    if (!id) throw new RpcException("Ticket was saved but its id could not be resolved. Fetch it with issues_search.");
    return toolJson(toIssueResultDto(await this.issues.get(user, id)));
  }

  /** The service silently drops assignees outside the ticket role; refuse instead. */
  private async requireEmployeesInRole(
    user: User,
    employeeIds: string[] | undefined,
    roleId: string | null | undefined,
    issueId?: string,
  ) {
    if (!isSet(employeeIds)) return;
    const outside = await this.issues.findEmployeesOutsideRole(user, employeeIds!, roleId, issueId);
    if (outside.length > 0) {
      throw new RpcException(
        `Employee(s) ${outside.join(", ")} do not belong to the assigned role, so they cannot be assigned. Pass employees from that role (${TOOL.employees.list}) or change assignedRoleId.`,
      );
    }
  }

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
      'Create or edit a ticket. Required: mode ("create" or "update"). Required for create: title, assignedRoleId. Optional: description, orderId, causeId, priority, statusId, employeeIds, estimatedMinutes. For update: `id` plus title/description/cause/assignedRoleId/employeeIds/estimate (omit assignedRoleId to keep the current role). employeeIds replaces the assignee list and every id must belong to the ticket role. Status/priority changes after create go through issues_act, not save. Returns the full saved ticket. No replies, no delete.',
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
      await this.requireEmployeesInRole(user, parsed.dto.employeeIds, parsed.dto.assignedRoleId);
      return this.loadIssueResult(user, await this.issues.create(user, parsed.dto));
    }
    if (isSet((req.fields as any).priority) || isSet((req.fields as any).statusId)) {
      throw new RpcException("Status/priority changes go through issues_act, not save. Remove priority/statusId or call issues_act.");
    }
    const updateFields: Record<string, unknown> = { ...req.fields };
    if (!isSet(updateFields.assignedRoleId)) {
      const current: any = await this.issues.get(user, req.id);
      updateFields.assignedRoleId = current?.assignedRoleId ?? current?.assignedRole?.id ?? undefined;
    }
    const parsed = await parseDto(UpdateIssueDto, updateFields);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    await this.requireEmployeesInRole(user, parsed.dto.employeeIds, parsed.dto.assignedRoleId, req.id);
    return this.loadIssueResult(user, await this.issues.update(user, req.id, parsed.dto));
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
    if (report === "board") {
      const statuses = await this.issues.getStatuses(user);
      const rows = Array.isArray(statuses) ? statuses : [];
      return toolJson({
        report,
        statuses: rows.map((s: any) => ({
          statusId: s.id ?? null,
          nameEn: s.nameEn ?? null,
          nameAr: s.nameAr ?? null,
          count: Number(s.issueCount ?? 0),
        })),
      });
    }
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
      return this.loadIssueResult(user, await this.issues.changeStatus(user, input.id, { statusId: input.statusId }));
    }
    if (input.action === "set_priority") {
      if (!isSet(input.priority)) throw new RpcException("action=set_priority requires `priority`.");
      return this.loadIssueResult(user, await this.issues.changePriority(user, input.id, { priority: input.priority }));
    }
    const dto = {
      ...(isSet(input.assignedRoleId) ? { assignedRoleId: input.assignedRoleId } : {}),
      ...(isSet(input.employeeIds) ? { employeeIds: input.employeeIds } : {}),
      ...(isSet(input.assignedEmployeeIds) ? { assignedEmployeeIds: input.assignedEmployeeIds } : {}),
    };
    if (Object.keys(dto).length === 0) {
      throw new RpcException("action=assign requires assignedRoleId and/or employee ids.");
    }
    await this.requireEmployeesInRole(
      user,
      isSet(input.employeeIds) ? input.employeeIds : input.assignedEmployeeIds,
      (dto as any).assignedRoleId,
      input.id,
    );
    return this.loadIssueResult(user, await this.issues.assign(user, input.id, dto));
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
