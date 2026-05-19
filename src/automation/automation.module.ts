import { forwardRef, Module } from '@nestjs/common';
import { AutomationService } from './automation.service';
import { AutomationController } from './automation.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutomationFlowEntity, AutomationFlowVersionEntity, AutomationRunEntity, AutomationRunStepEntity } from 'entities/automation.entity';
import { FlowExecutionQueueService, TriggerDispatcherService } from './engine/triggerDispatcher.service';
import { EngineRunnerService } from './engine/engineRunner.service';
import { FlowWorkerService } from './engine/flowWorker.service';
import { VariableHydratorService } from './engine/variableHydrator.service';
import { ActionSendWhatsappTemplateMessageHandler, ActionUpdateOrderStatusHandler, ConditionOrderCheckHandler, ConditionQuickOrderStatusHandler, NodeHandlersRegistry } from './engine/nodeHandlers.registry';
import { OrderCreatedTriggerMatcher, OrderUpdatedTriggerMatcher, TriggerMatchersRegistry } from './engine/triggerMatchers.registry';
import { OrdersModule } from 'src/orders/orders.module';
import { WhatsappModule } from 'src/whatsapp/whatsapp.module';
import { WhatsappTemplateEntity } from 'entities/whatsapp.entity';


@Module({
  imports: [
    forwardRef(() => OrdersModule),
    forwardRef(() => WhatsappModule),
    TypeOrmModule.forFeature([
      AutomationFlowEntity,
      AutomationFlowVersionEntity,
      AutomationRunStepEntity,
      AutomationRunEntity,
      WhatsappTemplateEntity
    ])
  ],
  controllers: [AutomationController],
  providers: [AutomationService, TriggerDispatcherService, FlowExecutionQueueService,
    EngineRunnerService, FlowWorkerService, VariableHydratorService,
    NodeHandlersRegistry, ConditionQuickOrderStatusHandler, ConditionOrderCheckHandler,
    ActionUpdateOrderStatusHandler, ActionSendWhatsappTemplateMessageHandler,
    TriggerMatchersRegistry, OrderCreatedTriggerMatcher, OrderUpdatedTriggerMatcher
  ],
  exports: [AutomationService, TriggerDispatcherService, FlowExecutionQueueService,
    EngineRunnerService, VariableHydratorService,
    NodeHandlersRegistry
  ],
})
export class AutomationModule { }
