import { UseGuards } from "@nestjs/common";
import { Payload } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { UsersService } from "src/users/users.service";
import { DashboardService } from "src/dashboard/dashboard.service";
import { WalletService } from "src/wallet/wallet.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { listPaging } from "../utils/mcp-dto.util";
import { toolJson } from "../utils/mcp-result.util";
import { idDescription, TOOL } from "../utils/mcp-tool-names";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
// ═══════════════════════════════════════════════════════════════

const listEmployeesInput = z.object({
  ...listPaging({
    items: "employees",
    sortBy: ["createdAt", "name", "email", "isActive"],
    search: "Matches employee name, email, or phone",
  }),
  type: z.string().default("all").describe('Employee type to filter by. Pass "all" to skip this filter.'),
  storeId: z
    .string()
    .optional()
    .describe(idDescription("Store id for the performance window.", TOOL.stores.list, 'Pass "all" to skip.')),
  startDate: z.string().optional().describe("Performance window start, ISO date (YYYY-MM-DD)"),
  endDate: z.string().optional().describe("Performance window end, ISO date (YYYY-MM-DD)"),
  range: z.string().optional().describe("Quick range for the performance window"),
});

const getMeInput = z.object({});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: what the model RECEIVES from the tools
//    Entity -> small plain object. Never return raw entities, and
//    keep list views slim (summary) vs detail views (full).
// ═══════════════════════════════════════════════════════════════

function toEmployeeSummary(row: any) {
  const perf = (row as any).performance ?? null;
  return {
    id: row.id,
    name: row.name ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    employeeType: row.employeeType ?? row.type ?? null,
    role: row.role?.name ?? null,
    isActive: row.isActive ?? null,
    performance: perf
      ? {
          totalAssigned: Number(perf.totalAssigned ?? 0),
          confirmedCount: Number(perf.confirmedCount ?? 0),
          shippedCount: Number(perf.shippedCount ?? 0),
          deliveredCount: Number(perf.deliveredCount ?? 0),
          activeAssignments: Number(perf.activeAssignments ?? 0),
          lockedAssignments: Number(perf.lockedAssignments ?? 0),
        }
      : {
          totalAssigned: 0,
          confirmedCount: 0,
          shippedCount: 0,
          deliveredCount: 0,
          activeAssignments: 0,
          lockedAssignments: 0,
        },
  };
}

function toPlan(plan: any) {
  if (!plan) return null;
  return {
    id: plan.id,
    name: plan.name ?? null,
    nameEn: plan.nameEn ?? null,
    duration: plan.duration ?? null,
    durationInDays: plan.durationIndays ?? null,
    type: plan.type ?? null,
    description: plan.description ?? null,
    features: plan.features ?? [],
    includedOrders: plan.includedOrders ?? null,
    usersLimit: plan.usersLimit ?? null,
    storesLimit: plan.storesLimit ?? null,
    shippingCompaniesLimit: plan.shippingCompaniesLimit ?? null,
    extraOrderFee: plan.extraOrderFee ?? null,
    price: plan.price ?? null,
    isActive: plan.isActive ?? null,
    isPopular: plan.isPopular ?? null,
  };
}

function toSubscription(sub: any) {
  if (!sub) return null;
  return {
    id: sub.id,
    status: sub.status ?? null,
    duration: sub.duration ?? null,
    durationInDays: sub.durationIndays ?? null,
    planType: sub.planType ?? null,
    price: sub.price ?? null,
    includedOrders: sub.includedOrders ?? null,
    usedOrders: sub.usedOrders ?? null,
    extraOrderFee: sub.extraOrderFee ?? null,
    usersLimit: sub.usersLimit ?? null,
    storesLimit: sub.storesLimit ?? null,
    shippingCompaniesLimit: sub.shippingCompaniesLimit ?? null,
    startDate: sub.startDate ?? null,
    endDate: sub.endDate ?? null,
    plan: toPlan(sub.plan),
  };
}

function toCompany(company: any) {
  if (!company) return null;
  return {
    id: company.id,
    name: company.name ?? null,
    country: company.country ?? null,
    currency: company.currency ?? null,
    tax: company.tax ?? null,
    commercial: company.commercial ?? null,
    phone: company.phone ?? null,
    website: company.website ?? null,
    address: company.address ?? null,
    businessType: company.businessType ?? null,
  };
}

function toMeDto(user: any, company: any, wallet: any) {
  const subscription = Array.isArray(user?.subscriptions)
    ? user.subscriptions[0]
    : user?.activeSubscription ?? null;
  const role = user?.role;
  return {
    id: user?.id ?? null,
    name: user?.name ?? null,
    email: user?.email ?? null,
    phone: user?.phone ?? null,
    avatarUrl: user?.avatarUrl ?? null,
    employeeType: user?.employeeType ?? null,
    isActive: user?.isActive ?? null,
    hasPassword: user?.hasPassword ?? null,
    adminId: user?.adminId ?? null,
    onboardingStatus: user?.onboardingStatus ?? null,
    currentOnboardingStep: user?.currentOnboardingStep ?? null,
    createdAt: user?.createdAt ?? null,
    role: role
      ? {
          id: role.id,
          name: role.name ?? null,
          description: role.description ?? null,
          permissionNames: role.permissionNames ?? [],
          isGlobal: role.isGlobal ?? null,
        }
      : null,
    activeSubscription: toSubscription(subscription),
    company: toCompany(company),
    wallet: wallet
      ? {
          currentBalance: Number(wallet.currentBalance ?? 0),
          aiBalance: Number(wallet.aiBalance ?? 0),
          reservedBalance: Number(wallet.reservedBalance ?? 0),
          reservedAiBalance: Number(wallet.reservedAiBalance ?? 0),
          totalCharged: Number(wallet.totalCharged ?? 0),
          totalWithdrawn: Number(wallet.totalWithdrawn ?? 0),
        }
      : null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS: the @McpController class
//    Guards, tool decorators, service calls and the toolJson /
//    toolPage return helpers. No mapping or schema code here.
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpEmployeesTools {
  constructor(
    private users: UsersService,
    private dashboard: DashboardService,
    private wallet: WalletService,
  ) {}

  @McpReadTool({
    name: TOOL.employees.list,
    description:
      "List the employees of the signed-in Madar user's workspace. Each row includes performance (assigned, confirmed, shipped, delivered, active and locked assignments) for the optional stats window (storeId, dates, range). Users with no assignments still appear with zeros. Read-only.",
    parameters: listEmployeesInput,
  })
  async listEmployees(
    @Payload() query: z.infer<typeof listEmployeesInput>,
    @McpUser() user: User,
  ) {
    const result = await this.users.listForTable(user, {
      page: query.page,
      limit: query.limit,
      search: query.search ?? "",
      type: query.type,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    });
    // Performance comes from a separate inner-join query: merge by user id
    // so idle employees are kept (zeros) instead of hidden.
    let perfById = new Map<string, any>();
    try {
      const perf = await this.dashboard.getEmployeePerformance(user, {
        storeId: (query as any).storeId,
        startDate: (query as any).startDate,
        endDate: (query as any).endDate,
        range: (query as any).range,
        page: 1,
        limit: 1000,
      });
      const rows = Array.isArray(perf) ? perf : Array.isArray((perf as any)?.records) ? (perf as any).records : [];
      for (const r of rows) {
        const id = String(r?.id ?? r?.userId ?? "");
        if (id && !perfById.has(id)) perfById.set(id, r);
      }
    } catch {
      perfById = new Map();
    }
    const records = Array.isArray((result as any)?.records) ? (result as any).records : [];
    const merged = records.map((row: any) => ({ ...row, performance: perfById.get(String(row.id)) ?? null }));
    return toolJson({
      total_records: (result as any)?.total_records ?? merged.length,
      current_page: (result as any)?.current_page ?? 1,
      per_page: (result as any)?.per_page ?? query.limit,
      employees: merged.map(toEmployeeSummary),
    });
  }

  @McpReadTool({
    name: TOOL.users.me,
    description:
      "Get the signed-in Madar user: profile, role, active subscription and plan, workspace company details, and wallet balances. Read-only.",
    parameters: getMeInput,
  })
  async getMe(@McpUser() user: User) {
    const me = await this.users.getMe(user.id);
    let company = null;
    try {
      company = await this.users.getCompany(user);
    } catch {
      company = null;
    }
    let wallet = null;
    try {
      wallet = await this.wallet.getOrCreateWallet(user.id);
    } catch {
      wallet = null;
    }
    return toolJson(toMeDto(me, company, wallet));
  }
}
