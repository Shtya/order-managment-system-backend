import ExcelJS from "exceljs";
import { UsersService } from "./users.service";

describe("UsersService.superAdminExport", () => {
  it("exports full user/company information with localized headers", async () => {
    const translations = {
      t: (key: string) => {
        const map: Record<string, string> = {
          "common.not_applicable": "N/A",
          "domains.users.export_sheet": "Users",
          "domains.users.export_id": "ID",
          "domains.users.export_name": "Name",
          "domains.users.export_email": "Email",
          "domains.users.export_phone": "Phone",
          "domains.users.export_role": "Role",
          "domains.users.export_plan": "Plan",
          "domains.users.export_admin_id": "Owner Admin ID",
          "domains.users.export_admin_name": "Owner Admin Name",
          "domains.users.export_admin_email": "Owner Admin Email",
          "domains.users.export_company_name": "Company Name",
          "domains.users.export_company_phone": "Company Phone",
          "domains.users.export_company_website": "Company Website",
          "domains.users.export_company_address": "Company Address",
          "domains.users.export_company_country": "Company Country",
          "domains.users.export_company_currency": "Company Currency",
          "domains.users.export_business_type": "Business Type",
          "domains.users.export_employee_type": "Employee Type",
          "domains.users.export_onboarding_status": "Onboarding Status",
          "domains.users.export_current_onboarding_step": "Current Onboarding Step",
          "domains.users.export_created_at": "Created At",
          "domains.users.export_updated_at": "Updated At",
          "domains.users.export_status": "Status",
          "domains.users.export_wallet_balance": "Wallet Balance",
          "domains.users.export_wallet_total_withdrawn": "Total Withdrawn",
        };
        return map[key] ?? key;
      },
    };

    const qb = {
      leftJoinAndSelect: () => qb,
      leftJoin: () => qb,
      addSelect: () => qb,
      orderBy: () => qb,
      andWhere: () => qb,
      getRawAndEntities: async () => ({
        entities: [
          {
            id: "user-1",
            name: "Alice",
            email: "alice@example.com",
            phone: "+966500000000",
            role: { id: "role-1", name: "admin" },
            company: {
              name: "Acme Co",
              phone: "+966500111111",
              website: "https://acme.example",
              address: "Riyadh, KSA",
              country: "SA",
              currency: "SAR",
              businessType: "Retail",
            },
            adminId: "owner-1",
            isActive: true,
            employeeType: "Marketing",
            onboardingStatus: "completed",
            currentOnboardingStep: "finished",
            subscriptions: [{ status: "active", plan: { name: "Pro" } }],
            wallet: { currentBalance: 123, totalWithdrawn: 45 },
            createdAt: new Date("2024-01-02T00:00:00.000Z"),
            updatedAt: new Date("2024-01-03T00:00:00.000Z"),
          },
        ],
        raw: [{ admin_id: "owner-1", admin_name: "Owner One", admin_email: "owner@example.com" }],
      }),
    };

    const service = new UsersService(
      {} as any,
      { createQueryBuilder: () => qb } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      translations as any,
      {} as any,
    );

    (service as any).isSuperAdmin = () => true;
    (service as any).usersRepo = { createQueryBuilder: () => qb };

    const buffer = await service.superAdminExport({ role: { name: "super_admin" } } as any, {
      tab: "all",
      search: "",
      role: "",
      roleId: "",
      active: "all",
      adminId: "",
      startDate: undefined,
      endDate: undefined,
      sortOrder: "DESC",
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.getWorksheet(1)!;

    expect(sheet.getRow(1).getCell(1).value).toBe("ID");
    expect(sheet.getRow(1).getCell(3).value).toBe("Email");
    expect(sheet.getRow(2).getCell(2).value).toBe("Alice");
    expect(sheet.getRow(2).getCell(4).value).toBe("alice@example.com");
    expect(sheet.getRow(2).getCell(5).value).toBe("+966500000000");
    expect(sheet.getRow(2).getCell(12).value).toBe("Acme Co");
    expect(sheet.getRow(2).getCell(13).value).toBe("Riyadh, KSA");
    expect(sheet.getRow(2).getCell(18).value).toBe("true");
  });
});
