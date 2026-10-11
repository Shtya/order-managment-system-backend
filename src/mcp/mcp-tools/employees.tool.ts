import { UseGuards } from "@nestjs/common";
import { Payload } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { UsersService } from "src/users/users.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { listPaging } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { TOOL } from "../utils/mcp-tool-names";

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
});

const getMeInput = z.object({});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: what the model RECEIVES from the tools
//    Entity -> small plain object. Never return raw entities, and
//    keep list views slim (summary) vs detail views (full).
// ═══════════════════════════════════════════════════════════════

function toEmployeeSummary(row: any) {
  return {
    id: row.id,
    name: row.name ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    employeeType: row.employeeType ?? row.type ?? null,
    role: row.role?.name ?? null,
    isActive: row.isActive ?? null,
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

function toMeDto(user: any, company: any) {
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
  constructor(private users: UsersService) {}

  @McpReadTool({
    name: TOOL.employees.list,
    description:
      "List the employees of the signed-in Madar user's workspace. Read-only.",
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
    return toolPage("employees", result, toEmployeeSummary, query.limit);
  }

  @McpReadTool({
    name: TOOL.users.me,
    description:
      "Get the signed-in Madar user: profile, role, active subscription and plan, and workspace company details. Read-only.",
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
    return toolJson(toMeDto(me, company));
  }
}
