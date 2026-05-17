import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { User } from "./user.entity";
import { TemplateConfig } from "./whatsapp.entity";


export enum TriggerType {
    ORDER_CREATED = 'order_created',
    ORDER_UPDATED = 'order_updated',
    TEMPLATE_RESPONSE = 'template_response',
}

export enum AutomationStatus {
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

    @Column({ type: 'enum', enum: AutomationStatus, default: AutomationStatus.DRAFT })
    status: AutomationStatus;

    @CreateDateColumn({ type: 'timestamp' })
    createdAt: Date;

    @UpdateDateColumn({ type: 'timestamp' })
    updatedAt: Date;

    @Column({ type: 'jsonb' })
    flow: FlowDefinition;

    @Column({ type: 'int', default: 0 })
    version: number;
}

export enum ActionType {
    UPDATE_ORDER_STATUS = 'update_order_status',
    SEND_WHATSAPP_TEMPLATE = 'send_whatsapp_template',
}

export enum ConditionType {
    QUICK_ORDER_STATUS = 'quick_order_status',
    ORDER_CHECK = 'order_check',
}

export enum FlowNodeType {
    TRIGGER = 'trigger',
    ACTION = 'action',
    CONDITION = 'condition',
}

export type FlowNodeDataType = TriggerType | ActionType | ConditionType;

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
        label: string;
        config: NodeConfig;
    };
}

export type NodeConfig =
    OrderCreatedConfig |
    OrderUpdatedConfig |
    UpdateOrderStatusConfig |
    SendWhatsappTemplateConfig |
    QuickOrderStatusConfig |
    OrderCheckConfig;

export interface OrderCreatedConfig {
    store?: string;
    storeId?: string;
}

export interface OrderUpdatedConfig {
    status?: string;
    statusId?: string;
}

export interface UpdateOrderStatusConfig {
    newStatus: string;
    newStatusId: string;
}

export interface SendWhatsappTemplateConfig {
    templateId: string;
    templateName: string;
    recipientNumber: string;
    templateData: TemplateConfig;
    branches?: {
        id: string;
        label: string;
        condition: string;
        sourceButton: any;
    }[];
}

export interface QuickOrderStatusConfig {
    status: string;
    statusId: string;
}

export type OperationType = ">" | "<" | ">=" | "<=" | "!=" | "contains" | "not_contains" | "starts_with" | "=="

export interface OrderCheckConfig {
    checks: {
        field: string;
        fieldLabel: string;
        operator: OperationType;
        targetValue: any;
        targetLabel?: string;
    }[];
}

export interface FlowEdge {
    id: string;
    source: string;
    target: string;
    sourceHandle?: string;
    targetHandle?: string;
}
