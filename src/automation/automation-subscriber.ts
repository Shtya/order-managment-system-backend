import {
    EntitySubscriberInterface,
    EventSubscriber,
    UpdateEvent,
    DataSource,
    TransactionCommitEvent,
} from 'typeorm';

import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { AutomationFlowEntity, AutomationStatus } from 'entities/automation.entity';
import { TriggerDispatcherService } from 'src/automation/engine/triggerDispatcher.service';

@EventSubscriber()
@Injectable()
export class AutomationSubscriber implements EntitySubscriberInterface<AutomationFlowEntity> {
    constructor(
        private dataSource: DataSource,
        @Inject(forwardRef(() => TriggerDispatcherService))
        private readonly triggerDispatcher: TriggerDispatcherService,
    ) {
        // Register this subscriber in the TypeORM lifecycle
        this.dataSource.subscribers.push(this);
    }

    listenTo() {
        return AutomationFlowEntity;
    }

    async afterUpdate(event: UpdateEvent<AutomationFlowEntity>) {
        const automation = event.entity;
        if (!automation || !automation.id || !automation.adminId) {
            return;
        }

        // We only need to trigger autoRetryFailedRuns if latestVersionId changed
        const originalAutomation = event.databaseEntity;
        if (originalAutomation?.latestVersionId === automation.latestVersionId && automation.status === AutomationStatus.PUBLISHED) {
            return;
        }

        const runAfterCommit = async () => {
            await this.triggerDispatcher.autoRetryFailedRuns(
                automation.adminId,
                automation.id,
            );
        };

        if (event.queryRunner) {
            if (!event.queryRunner.data.postCommitTasks) {
                event.queryRunner.data.postCommitTasks = [];
            }
            event.queryRunner.data.postCommitTasks.push(runAfterCommit);
        } else {
            await runAfterCommit();
        }
    }

    // TypeORM hook that automatically runs after a transaction successfully commits
    async afterTransactionCommit(event: TransactionCommitEvent) {
        const tasks = event.queryRunner.data?.postCommitTasks;

        if (tasks && tasks.length > 0) {
            for (let i = 0; i < tasks.length; i++) {
                const task = tasks[i];
                try {
                    await task();
                } catch (error) {
                    console.error(`[AutomationSubscriber] Error executing post-commit task ${i + 1}:`, error);
                }
            }
            // Clear the tasks to prevent memory leaks or duplicate executions
            event.queryRunner.data.postCommitTasks = [];
        }
    }
}
