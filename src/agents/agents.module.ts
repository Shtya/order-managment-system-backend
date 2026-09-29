import { forwardRef, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AgentEntity,AgentKnowledgeAgentEntity, AgentKnowledgeEntity, } from "entities/agent.entity";
import { AiProviderEntity } from "entities/ai.entity";
import { ConversationEntity, WhatsappMessageEntity, } from "entities/whatsapp.entity";
import {
  AgentMemoryFactEntity,
  AgentPendingActionEntity,
  AgentSessionEntity,
  AgentTaskEntity,
  AgentTurnEntity,
  AgentTurnMessageEntity,
} from "entities/agent-conversation.entity";
import { CustomerEntity } from "entities/customers.entity";
import { OrderEntity } from "entities/order.entity";
import { User } from "entities/user.entity";
import { CampaignRecipientEntity } from "entities/campaigns.entity";
import { AreaEntity, CityEntity } from "entities/cities.entity";
import { CategoryEntity } from "entities/categories.entity";
import { ProductEntity, ProductVariantEntity } from "entities/sku.entity";
import { BundleEntity, BundleItemEntity } from "entities/bundle.entity";
import { AiModule } from "src/ai/ai.module";
import { WhatsappModule } from "src/whatsapp/whatsapp.module";
import { CampaignsModule } from "src/campaigns/campaigns.module";
import { ClientsModule } from "src/clients/clients.module";
import { OrdersModule } from "src/orders/orders.module";
import { AgentsController } from "./agents.controller";
import { AgentsService } from "./agents.service";
import { AgentRuntimeService } from "./agent-runtime.service";
import { AgentInputService } from "./runtime/agent-input.service";
import { AgentSessionService } from "./runtime/agent-session.service";
import { AgentContextService } from "./runtime/agent-context.service";
import { AgentSenderService } from "./runtime/agent-sender.service";
import { AgentCampaignOffersService } from "./runtime/agent-campaign-offers.service";
import { AgentPendingActionsService } from "./runtime/agent-pending-actions.service";
import { AgentCatalogService } from "./runtime/agent-catalog.service";
import { AgentCustomerEditsService } from "./runtime/agent-customer-edits.service";
import { AgentPauseCatchupService } from "./runtime/agent-pause-catchup.service";
import { AgentTaskService } from "./runtime/agent-task.service";
import { CustomerTools } from "src/ai/tools/tools/customer-tools";
import { AgentWhatsappTools } from "src/ai/tools/tools/whatsapp.tools";
import { ConversationModule } from "src/conversation/conversation.module";
import { ShippingModule } from "src/shipping/shipping.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AgentEntity,
      AiProviderEntity,
      WhatsappMessageEntity,
      ConversationEntity,
      AgentSessionEntity,
      AgentTurnEntity,
      AgentTurnMessageEntity,
      AgentPendingActionEntity,
      AgentMemoryFactEntity,
      AgentTaskEntity,
      AgentKnowledgeEntity,
      AgentKnowledgeAgentEntity,
      CustomerEntity,
      OrderEntity,
      User,
      CampaignRecipientEntity,
      CityEntity,
      AreaEntity,
      CategoryEntity,
      ProductEntity,
      ProductVariantEntity,
      BundleEntity,
      BundleItemEntity,
    ]),
    forwardRef(() => AiModule),
    forwardRef(() => WhatsappModule),
    forwardRef(() => CampaignsModule),
    forwardRef(() => ClientsModule),
    forwardRef(() => OrdersModule),
    forwardRef(() => ConversationModule),
    forwardRef(() => ShippingModule),
  ],
  controllers: [AgentsController],
  providers: [
    AgentsService,
    AgentRuntimeService,
    AgentInputService,
    AgentSessionService,
    AgentContextService,
    AgentSenderService,
    AgentCampaignOffersService,
    AgentPendingActionsService,
    AgentCatalogService,
    AgentCustomerEditsService,
    AgentPauseCatchupService,
    AgentTaskService,
    AgentWhatsappTools,
    CustomerTools,
  ],
  exports: [AgentsService, AgentRuntimeService, AgentPauseCatchupService, AgentTaskService],
})
export class AgentsModule {}
