import { Column, CreateDateColumn, DeleteDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn, Relation, UpdateDateColumn } from "typeorm";
import { User } from "./user.entity";
import { TemplateConfig } from "./whatsapp.entity";
import { OrderEntity } from "./order.entity";


export enum TriggerType {
    ORDER_CREATED = 'order_created',
    ORDER_UPDATED = 'order_updated',
    // TEMPLATE_RESPONSE = 'template_response',
}

export enum AutomationStatus {
    DRAFT = 'draft',
    PUBLISHED = 'published',
    PAUSED = 'paused',
    ARCHIVED = 'archived',
}


@Index(['versionString', 'automationFlowId'], { unique: true })
@Entity('automation_flow_versions')
export class AutomationFlowVersionEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    automationFlowId: string;

    @ManyToOne(
        () => AutomationFlowEntity,
        (flow) => flow.versions,
    )
    @JoinColumn({ name: 'automationFlowId' })
    automationFlow: Relation<AutomationFlowEntity>;

    // شكل الإصدار كـ String لدعم Major.Minor (مثال: "1.0", "1.1", "5.0")
    @Column({ type: 'varchar', length: 50 })
    versionString: string;

    @Column({ type: 'jsonb' })
    flow: FlowDefinition;

    // 🌟 حقل التفرع للإصلاحات العاجلة (Hotfixes)
    // يشير إلى النسخة التي تم اشتقاق هذا الإصلاح منها
    @Column({ type: 'uuid', nullable: true })
    parentVersionId: string;

    @ManyToOne(() => AutomationFlowVersionEntity, { onDelete: 'SET NULL' })
    @JoinColumn({ name: 'parentVersionId' })
    parentVersion: AutomationFlowVersionEntity;

    @CreateDateColumn({ type: 'timestamp' })
    createdAt: Date;
}

@Index(['name', 'adminId'], { unique: true, where: `"deletedAt" IS NULL` })
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

    @Column({ type: 'uuid', nullable: true })
    latestVersionId: string | null;

    @ManyToOne(() => AutomationFlowVersionEntity, {
        nullable: true,
        onDelete: 'SET NULL',
    })
    @JoinColumn({ name: 'latestVersionId' })
    latestVersion: AutomationFlowVersionEntity | null;

    @OneToMany(() => AutomationFlowVersionEntity, (version) => version.automationFlow)
    versions: AutomationFlowVersionEntity[];

    //soft Delete
    @DeleteDateColumn({ type: 'timestamp', nullable: true })
    deletedAt: Date;
}


export enum ActionType {
    UPDATE_ORDER_STATUS = 'update_order_status',
    SEND_WHATSAPP_TEMPLATE = 'send_whatsapp_template',
}

export enum ConditionType {
    QUICK_ORDER_STATUS = 'quick_order_status',
    ORDER_CHECK = 'order_check',
}

export type FlowNodeDataType = TriggerType | ActionType | ConditionType;

export enum FlowNodeType {
    TRIGGER = 'trigger',
    ACTION = 'action',
    CONDITION = 'condition',
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

export interface VariableDetails {
    type: 'direct' | 'variable';
    label: string;
    value: string;
    example: string;
    variablePath: string;
}

export interface SendWhatsappTemplateConfig {
    templateId: string;
    templateName: string;
    recipientNumber: string;
    templateData: TemplateConfig;
    bodyVariables?: Record<string, VariableDetails>;
    headerVariables?: Record<string, VariableDetails>;
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

export type VersionIncrementType = 'major' | 'minor';

export enum RunStatus {
    PENDING = 'pending',       // في طابور الانتظار للبدء
    RUNNING = 'running',       // قيد التنفيذ حالياً
    COMPLETED = 'completed',   // اكتملت جميع الخطوات بنجاح
    FAILED = 'failed',         // توقفت بسبب خطأ في إحدى الخطوات
    CANCELLED = 'cancelled',   // تم إيقافها يدوياً أو بسبب تجاوز الوقت
    PAUSED = 'paused',         // تم توقفها مدةً
}

export enum StepStatus {
    SUCCESS = 'success',
    FAILED = 'failed',
    SKIPPED = 'skipped',       // تم تخطيها (مثلاً مسار آخر في Condition تحقق)
}

export enum TriggerEntityType {
    ORDER = 'order',
}

export interface StepExecutionResult {
    type: FlowNodeDataType;
    executedAt: string; // ISO Timestamp
    input?: any;
    output: any;
    chosenBranch?: string;
    success: boolean;
    error?: string; // يسجل هنا لو فشلت الخطوة بعينها
}

export interface ExecutionState {
    trigger: {
        nodeId: string;
        type: TriggerType;
        output: OrderEntity;
    };
    // قاموس (Dictionary) مفتاحه هو الـ Node ID وقيمته هي تفاصيل تشغيل الخطوة
    steps: Record<string, StepExecutionResult>;
}

@Entity('automation_runs')
export class AutomationRunEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    // 🌟 ارتباط مباشر بالـ Flow الأساسي والنسخة المحددة
    @Column({ type: 'uuid' })
    automationFlowId: string;

    @ManyToOne(() => AutomationFlowEntity)
    @JoinColumn({ name: 'automationFlowId' })
    automationFlow: AutomationFlowEntity;

    @Column({ type: 'uuid' })
    versionId: string;

    @ManyToOne(() => AutomationFlowVersionEntity)
    @JoinColumn({ name: 'versionId' })
    version: AutomationFlowVersionEntity;

    @Column({ type: 'enum', enum: RunStatus, default: RunStatus.PENDING })
    status: RunStatus;

    // 🌟 التتبع السياقي (Context Tracking)
    // الكيان الذي أطلق هذه الأتمتة (مثال: 'order')
    @Column({ type: 'enum', enum: TriggerEntityType })
    triggerEntityType: TriggerEntityType;

    // المعرف الخاص بالكيان (مثال: رقم الطلب 'ord_123xyz')
    @Index()
    @Column({ type: 'varchar', length: 255 })
    triggerEntityId: string;

    // البيانات الأولية التي بدأت بها الأتمتة (مهمة جداً لإعادة التشغيل Retry)
    @Column({ type: 'jsonb' })
    initialPayload: any;

    // 🌟 تتبع مسار العمل (State Tracking)
    // لتخزين الـ ID الخاص بالعقدة التي يعمل عليها المحرك حالياً أو توقف عندها
    @Column({ type: 'varchar', length: 255, nullable: true })
    currentNodeId: string;

    // مصفوفة بأسماء العقد التي تمت بنجاح لمعرفة المتبقي
    @Column({ type: 'jsonb', default: [] })
    completedNodeIds: string[];

    // سياق البيانات المتراكم (المخرجات التي تمر من خطوة لأخرى)
    @Column({ type: 'jsonb', default: {} })
    executionState: ExecutionState;

    @Column({ type: 'text', nullable: true })
    errorMessage: string;

    @CreateDateColumn({ type: 'timestamp' })
    startedAt: Date;

    @Column({ type: 'timestamp', nullable: true })
    completedAt: Date;

    @OneToMany(() => AutomationRunStepEntity, step => step.run)
    steps: AutomationRunStepEntity[];
}

@Entity('automation_run_steps')
export class AutomationRunStepEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid' })
    runId: string;

    @ManyToOne(() => AutomationRunEntity, run => run.steps)
    @JoinColumn({ name: 'runId' })
    run: AutomationRunEntity;

    // معرف العقدة في الـ JSON (مثلاً: 'node_abc123')
    @Column({ type: 'varchar', length: 255 })
    nodeId: string;

    // نوع الخطوة (action, condition)
    @Column({ type: 'enum', enum: FlowNodeType })
    nodeType: FlowNodeType;

    // نوع البيانات التي تتم استلمها هذه الخطوة

    @Column({ type: 'varchar' })
    dataType: FlowNodeDataType;

    @Column({ type: 'enum', enum: StepStatus })
    status: StepStatus;

    // البيانات التي استلمتها هذه الخطوة بالتحديد
    @Column({ type: 'jsonb', nullable: true })
    inputData: any;

    // البيانات التي أنتجتها هذه الخطوة (ليتم دمجها في الـ executionState)
    @Column({ type: 'jsonb', nullable: true })
    outputData: any;

    @Column({ type: 'text', nullable: true })
    errorMessage: string;

    @CreateDateColumn({ type: 'timestamp' })
    executedAt: Date;

    // الوقت المستغرق لتنفيذ الخطوة بالملي ثانية (مهم لتحليل الأداء Performance)
    @Column({ type: 'int', default: 0 })
    executionTimeMs: number;
}