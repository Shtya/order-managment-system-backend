import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuthModule } from "../auth/auth.module"; // must export AuthService
import { OrdersModule } from "../orders/orders.module"; // must export OrdersService
import { ClientsModule } from "../clients/clients.module"; // must export ClientService
import { CitiesModule } from "../cities/cities.module"; // must export CitiesService
import { ShippingModule } from "../shipping/shipping.module"; // must export ShippingService
import { StoresModule } from "../stores/stores.module"; // must export StoresService
import { ProductsModule } from "../products/products.module"; // must export ProductsService
import { BundlesModule } from "../bundles/bundles.module"; // must export BundlesService
import { CategoryModule } from "../category/category.module"; // must export CategoriesService
import { TagsModule } from "../tags/tags.module"; // must export TagsService
import { UsersModule } from "../users/users.module"; // must export UsersService (@Global)
import { CancelCausesModule } from "../cancel-causes/cancel-causes.module"; // must export CancelCausesService
import { DashboardModule } from "../dashboard/dashboard.module"; // must export DashboardService
import { AccountingModule } from "../accounting/accounting.module"; // must export AccountingService + Expenses + Categories + MonthlyClosing
import { PurchasesModule } from "../purchases/purchases.module"; // must export PurchasesService
import { PurchasesReturnModule } from "../purchases-return/purchases-return.module"; // must export PurchaseReturnsService
import { ClientSegmentsModule } from "../client-segments/client-segments.module";
import { ClientSettingsModule } from "../client-settings/client-settings.module";
import { CampaignsModule } from "../campaigns/campaigns.module";
import { UpsellsModule } from "../upsells/upsells.module";
import { IssueModule } from "../issue/issue.module";
import { CollectionModule } from "../order-collections/collection.module";
import { GettingStartedModule } from "../getting-started/getting-started.module";
import { ShippingAssigningModule } from "../shipping-assigning/shipping-assigning.module";
import { RolesModule } from "../roles/roles.module";
import { SafesModule } from "../safes/safes.module";
import { PlansModule } from "../plans/plans.module";
import { SupplierCategoriesModule } from "../supplier/categories/categories.module";
import { SuppliersModule } from "../supplier/supplier.module";
import { SupplierPaymentsModule } from "../supplier-payments/supplier-payments.module";
import { WarehousesModule } from "../warehouse/warehouse.module";
import { WalletModule } from "../wallet/wallet.module";
import { AutomationModule } from "../automation/automation.module";
import { WhatsappModule } from "../whatsapp/whatsapp.module";
import { McpAuthGuard } from "./mcp-guards/mcp-auth.guard";
import { McpScopeGuard } from "./mcp-guards/mcp-scope-guard";
import { McpHttpController } from "./mcp-http.controller";
import {
  OAuthAuthRequest,
  OAuthClient,
  OAuthGrant,
  OAuthRefreshToken,
} from "entities/oauth.entity";
import { OAuthController } from "./oauth.controller";
import { OAuthService } from "./oauth.service";
import { McpOrdersTools } from "./mcp-tools/orders.tool";
import { McpClientsTools } from "./mcp-tools/clients.tool";
import { McpCitiesTools } from "./mcp-tools/cities.tool";
import { McpShippingCompaniesTools } from "./mcp-tools/shipping-companies.tool";
import { McpStoresTools } from "./mcp-tools/stores.tool";
import { McpProductsTools } from "./mcp-tools/products.tool";
import { McpBundlesTools } from "./mcp-tools/bundles.tool";
import { McpCategoriesTools } from "./mcp-tools/categories.tool";
import { McpOrderStatusesTools } from "./mcp-tools/order-statuses.tool";
import { McpTagsTools } from "./mcp-tools/tags.tool";
import { McpTagAutomationsTools } from "./mcp-tools/tag-automations.tool";
import { McpEmployeesTools } from "./mcp-tools/employees.tool";
import { McpCancelCausesTools } from "./mcp-tools/cancel-causes.tool";
import { McpDashboardTools } from "./mcp-tools/dashboard.tool";
import { McpAccountingTools } from "./mcp-tools/accounting.tool";
import { McpPurchaseReturnsTools, McpPurchasesTools } from "./mcp-tools/purchases.tool";
import { McpClientSegmentsTools } from "./mcp-tools/client-segments.tool";
import { McpClientSettingsTools } from "./mcp-tools/client-settings.tool";
import { McpCampaignsTools } from "./mcp-tools/campaigns.tool";
import { McpUpsellsTools } from "./mcp-tools/upsells.tool";
import { McpIssuesTools } from "./mcp-tools/issues.tool";
import { McpOrderCollectionsTools } from "./mcp-tools/order-collections.tool";
import { McpGettingStartedTools } from "./mcp-tools/getting-started.tool";
import { McpShippingAssigningTools } from "./mcp-tools/shipping-assigning.tool";
import { McpAutomationTools } from "./mcp-tools/automation.tool";
import { McpWhatsappTools } from "./mcp-tools/whatsapp.tool";
import { McpWarehouseOpsTools } from "./mcp-tools/warehouse-ops.tool";
import { McpRolesTools } from "./mcp-tools/roles.tool";
import { McpSafesTools } from "./mcp-tools/safes.tool";
import { McpSupplierCategoriesTools } from "./mcp-tools/supplier-categories.tool";
import { McpSuppliersTools } from "./mcp-tools/suppliers.tool";
import { McpWarehouseLocationsTools, McpWarehousesTools } from "./mcp-tools/warehouses.tool";
import { McpToolRefsCheck } from "./utils/mcp-tool-names";
import { McpToolExceptionFilter } from "./filters/mcp-tool-exception.filter";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OAuthClient,
      OAuthAuthRequest,
      OAuthGrant,
      OAuthRefreshToken,
    ]),

    // A SEPARATE secret from the one used by your web JWT. A web token must
    // never be accepted by /mcp, and an MCP token must never work on your API.
    JwtModule.registerAsync({
      useFactory: () => ({ secret: process.env.MCP_JWT_SECRET }),
    }),

    AuthModule,
    OrdersModule,
    ClientsModule,
    CitiesModule,
    ShippingModule,
    StoresModule,
    ProductsModule,
    BundlesModule,
    CategoryModule,
    TagsModule,
    UsersModule,
    CancelCausesModule,
    DashboardModule,
    AccountingModule,
    PurchasesModule,
    PurchasesReturnModule,
    ClientSegmentsModule,
    ClientSettingsModule,
    CampaignsModule,
    UpsellsModule,
    IssueModule,
    CollectionModule,
    GettingStartedModule,
    ShippingAssigningModule,
    RolesModule,
    SafesModule,
    PlansModule,
    SupplierCategoriesModule,
    SuppliersModule,
    SupplierPaymentsModule,
    WarehousesModule,
    WalletModule,
    AutomationModule,
    WhatsappModule,
  ],
  // v2: MCP tools are @McpController classes and MUST be listed in `controllers`
  // (classes in `providers` are not discovered, so tools/list would be empty).
  controllers: [
    OAuthController,
    McpHttpController,
    McpOrdersTools,
    McpClientsTools,
    McpCitiesTools,
    McpShippingCompaniesTools,
    McpStoresTools,
    McpProductsTools,
    McpBundlesTools,
    McpCategoriesTools,
    McpOrderStatusesTools,
    McpTagsTools,
    McpTagAutomationsTools,
    McpEmployeesTools,
    McpCancelCausesTools,
    McpDashboardTools,
    McpAccountingTools,
    McpPurchasesTools,
    McpPurchaseReturnsTools,
    McpClientSegmentsTools,
    McpClientSettingsTools,
    McpCampaignsTools,
    McpUpsellsTools,
    McpIssuesTools,
    McpOrderCollectionsTools,
    McpGettingStartedTools,
    McpShippingAssigningTools,
    McpRolesTools,
    McpSafesTools,
    McpSupplierCategoriesTools,
    McpSuppliersTools,
    McpWarehousesTools,
    McpWarehouseLocationsTools,
    McpAutomationTools,
    McpWhatsappTools,
    McpWarehouseOpsTools,
  ],
  providers: [
    OAuthService,
    McpAuthGuard,
    McpScopeGuard,
    McpToolRefsCheck,
    McpToolExceptionFilter,
  ],
})
export class McpModule {}

/*
 * ── main.ts ─────────────────────────────────────────────────────────
 * import { NestFactory } from "@nestjs/core";
 * import { AppModule } from "./app.module";
 * import { mcp } from "./mcp/mcp.strategy";
 *
 * async function bootstrap() {
 *   const app = await NestFactory.create(AppModule);
 *   mcp.setHttpAdapter(app.getHttpAdapter());   // needed for HTTP transports
 *   app.connectMicroservice({ strategy: mcp });
 *   await app.startAllMicroservices();          // BEFORE listen()
 *   await app.listen(3000);
 * }
 * void bootstrap();
 *
 * ── .env ────────────────────────────────────────────────────────────
 *   BACKEND_URL=https://api.madar.app      (public https URL, no trailing slash)
 *   FRONTEND_URL=https://app.madar.app
 *   MCP_JWT_SECRET=<long random string, different from JWT_SECRET>
 *
 * If you use a global prefix, exclude the OAuth + MCP routes from it:
 *   app.setGlobalPrefix("api", { exclude: [".well-known/(.*)", "oauth/(.*)", "mcp"] });
 */