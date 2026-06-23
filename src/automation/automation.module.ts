import { forwardRef, Module } from '@nestjs/common';
import { AutomationService } from './automation.service';
import { AutomationController } from './automation.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutomationFlowEntity, AutomationFlowVersionEntity, AutomationRunEntity, AutomationRunStepEntity } from 'entities/automation.entity';
import { TriggerDispatcherService } from './engine/triggerDispatcher.service';
import { EngineRunnerService } from './engine/engineRunner.service';
import { VariableHydratorService } from './engine/variableHydrator.service';
import { ConditionOrderCheckHandler, ConditionQuickOrderStatusHandler, NodeHandlersRegistry } from './engine/nodeHandlers.registry';
import { OrderCreatedTriggerMatcher, OrderUpdatedTriggerMatcher, TriggerMatchersRegistry } from './engine/triggerMatchers.registry';
import { OrdersModule } from 'src/orders/orders.module';
import { WhatsappModule } from 'src/whatsapp/whatsapp.module';
import { WhatsappAccountEntity, WhatsappTemplateEntity } from 'entities/whatsapp.entity';
import { NotificationModule } from 'src/notifications/notification.module';
import { WebSocketModule } from 'common/websocket.module';
import { ProductionAutomationAdapter } from './engine/adapters/production.adapters';
import { AutomationPreviewService } from './engine/automation-preview.service';
import { Upsell, UpsellHistory } from 'entities/upsells.entity';
import { UpsellsModule } from 'src/upsells/upsells.module';
import { OrderEntity } from 'entities/order.entity';
import { User } from 'entities/user.entity';
import { OrderAssignmentEntity } from 'entities/assignment.entity';
import { OrderAssignmentModule } from 'src/order-assignment/order-assignment.module';


@Module({
  imports: [
    forwardRef(() => UpsellsModule),
    forwardRef(() => OrdersModule),
    forwardRef(() => WhatsappModule),
    forwardRef(() => OrderAssignmentModule),
    NotificationModule,
    WebSocketModule,
    TypeOrmModule.forFeature([
      AutomationFlowEntity,
      AutomationFlowVersionEntity,
      AutomationRunStepEntity,
      AutomationRunEntity,
      WhatsappTemplateEntity,
      Upsell,
      UpsellHistory,
      WhatsappAccountEntity,
      OrderEntity,
      User,
      OrderAssignmentEntity
    ])
  ],
  controllers: [AutomationController],
  providers: [AutomationService, TriggerDispatcherService,
    EngineRunnerService, VariableHydratorService,
    NodeHandlersRegistry, ConditionQuickOrderStatusHandler, ConditionOrderCheckHandler,
    ProductionAutomationAdapter, AutomationPreviewService,
    TriggerMatchersRegistry, OrderCreatedTriggerMatcher, OrderUpdatedTriggerMatcher
  ],
  exports: [AutomationService, TriggerDispatcherService,
    EngineRunnerService, VariableHydratorService,
    NodeHandlersRegistry
  ],
})
export class AutomationModule { }
