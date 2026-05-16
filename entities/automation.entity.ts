import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { User } from "./user.entity";


export enum TriggerType {
    ORDER_CREATED = 'order_created',
    ORDER_UPDATED = 'order_updated',
    TEMPLATE_RESPONSE = 'template_response',
}


export enum Status {
    DRAFT = 'draft',
    PUBLISHED = 'published',
    PAUSED = 'paused',
}

@Index(['name', 'adminId'], { unique: true })
@Entity('automation_flows')
export class AutomationFlowEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    adminId: string;

    @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
    @JoinColumn({ name: 'adminId' })
    admin: User;

    @Column({ type: 'varchar', length: 255 })
    name: string;

    @Column({ type: 'enum', enum: TriggerType, default: TriggerType.ORDER_CREATED })
    triggerType: TriggerType;

    @Column({ type: 'enum', enum: Status, default: Status.DRAFT })
    status: Status;

    @CreateDateColumn({ type: 'timestamp' })
    createdAt: Date;

    @UpdateDateColumn({ type: 'timestamp' })
    updatedAt: Date;

    @Column({ type: 'jsonb' })
    flow: FlowDefinition;
}

export enum FlowNodeType {
    TRIGGER = 'trigger',
    ACTION = 'action',
    CONDITION = 'condition',
}
export type FlowNodeDataType =
    TriggerType |
    ActionType |
    ConditionType


export enum ActionType {
    UPDATE_ORDER = 'update_order',
    SEND_TEMPLATE_MESSAGE = 'send_template_message',
}

export enum ConditionType {
    CHECK_ORDER_STATUS = 'check_order_status',
    CHECK_ORDER_DATA = 'check_order_data',
}

export interface FlowDefinition {
    nodes: FlowNode[];
    edges: FlowEdge[];
}

export interface FlowNode {
    id: string;
    type: FlowNodeType;

    position: {
        x: number;
        y: number;
    };

    measured?: {
        width: number;
        height: number;
    };

    data: {
        type: FlowNodeDataType;
        config: Record<string, any>;
    };

}

export interface FlowEdge {
    id: string;
    source: string;
    target: string;

    /**
     * 👇 THIS is critical for branches
     * example: button_click_0, true, false
     */

    sourceHandle?: string;

    targetHandle?: string;
}