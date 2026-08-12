import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    OneToMany,
    PrimaryGeneratedColumn,
    Unique,
    UpdateDateColumn,
} from "typeorm";
import { User } from "./user.entity";

export enum GettingStartedEventType {
    ITEM_OPENED = "get_started_item_opened",
    STEP_VIEWED = "get_started_step_viewed",
    SKIPPED = "get_started_skipped",
    FINISHED = "get_started_finished",
}

// export enum GettingStartedStepActionType {
//   NEXT = "next",
//   COMPLETE = "complete",
// }

export enum GettingStartedAchievementType {
    STORE_CONNECTED = "store_connected",
    SHIPPING_INTEGRATION_CONNECTED = "shipping_integration_connected",
    FIRST_SUPPLIER_CREATED = "first_supplier_created",
    FIRST_SAFE_CREATED = "first_safe_created",
    FIRST_WAREHOUSE_CREATED = "first_warehouse_created",
    FIRST_PRODUCT_CREATED = "first_product_created", //first_warehouse_created
    FIRST_ORDER_BUNDLE_CREATED = "first_order_bundle_created",//first_product_created
    FIRST_PURCHASE_ACCEPTED = "first_purchase_accepted",//first_safe_created, first_supplier_created
    FIRST_ORDER_CREATED = "first_order_created",//first_product_created
    WHATSAPP_CONNECTED = "whatsapp_connected",
    FIRST_CUSTOM_ROLE_CREATED = "first_custom_role_created",
    FIRST_TEAM_MEMBER_CREATED = "first_team_member_created",
    FIRST_ORDER_ASSIGNMENT_AUTOMATION_RULE_CREATED = "first_order_assignment_automation_rule_created",//first_team_member_created
    FIRST_AUTOMATION_CREATED = "first_automation_created",
}

export enum GettingStartedTargetType {
    PAGE = "page",
    BUTTON = "button",
    LINK="link",
    SECTION = "section",
    DIALOG = "dialog",
    SIDEBAR_ITEM = "sidebar_item",
}

@Entity("getting_started_achievements")
@Unique(["adminId", "type"])
export class GettingStartedAchievementEntity {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column()
    adminId: string;

    @ManyToOne(() => User, { onDelete: "CASCADE" })
    @JoinColumn({ name: "adminId" })
    admin: User;

    @Column({
        type: "enum",
        enum: GettingStartedAchievementType,
    })
    type: GettingStartedAchievementType;

    @CreateDateColumn({ type: 'timestamptz' })
    first_completed_at: Date;
}


@Entity("getting_started_items")
@Unique(["key"])
export class GettingStartedItemEntity {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column()
    key: string;

    @Column({ type: "jsonb" })
    title: {
        ar: string;
        en: string;
    };

    @Column({ type: "jsonb", nullable: true })
    description: {
        ar: string;
        en: string;
    };

    @Column({
        type: "enum",
        enum: GettingStartedAchievementType,
    })
    completionType: GettingStartedAchievementType;

    @Column({ type: "jsonb", default: () => "'[]'" })
    dependsOn: string[];

    @Column({ type: "int" })
    sortOrder: number;

    @Column({ default: true })
    isActive: boolean;

    @OneToMany(() => GettingStartedStepEntity, (step) => step.item)
    steps: GettingStartedStepEntity[];

    // ---------- Timestamps ----------
    @CreateDateColumn({ type: 'timestamptz' })
    created_at: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updated_at: Date;
}

@Entity("getting_started_steps")
@Unique(["itemId", "key"])
export class GettingStartedStepEntity {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column()
    itemId: string;

    @ManyToOne(
        () => GettingStartedItemEntity,
        (item) => item.steps,
        { onDelete: "CASCADE" },
    )
    @JoinColumn({ name: "itemId" })
    item: GettingStartedItemEntity;

    @Column()
    key: string;

    @Column({ type: "jsonb" })
    title: {
        ar: string;
        en: string;
    };

    @Column({ type: "jsonb" })
    description: {
        ar: string;
        en: string;
    };

    @Column({ type: "jsonb" })
    target: {
        type: GettingStartedTargetType;
        page?: string;
        key: string;
    };

    //   @Column({
    //     type: "enum",
    //     enum: GettingStartedStepActionType,
    //   })
    //   actionType: GettingStartedStepActionType;

    @Column({ type: "jsonb", nullable: true })
    actionConfig: Record<string, any>;

    @Column({ type: "int" })
    sortOrder: number;

    // ---------- Timestamps ----------
    @CreateDateColumn({ type: 'timestamptz' })
    created_at: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updated_at: Date;
}

@Entity("getting_started_events")
@Index(["adminId", "itemId", "type"])
export class GettingStartedEventEntity {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column()
    adminId: string;

    @ManyToOne(() => User, { onDelete: "CASCADE" })
    @JoinColumn({ name: "adminId" })
    admin: User;

    @Column({ nullable: true })
    itemId: string;

    @ManyToOne(() => GettingStartedItemEntity, { onDelete: "SET NULL" })
    @JoinColumn({ name: "itemId" })
    item: GettingStartedItemEntity;

    @Column({ nullable: true })
    stepId: string;

    @ManyToOne(() => GettingStartedStepEntity, { onDelete: "SET NULL" })
    @JoinColumn({ name: "stepId" })
    step: GettingStartedStepEntity;

    @Column({ nullable: true })
    stepKey: string;

    @Column({
        type: "enum",
        enum: GettingStartedEventType,
    })
    type: GettingStartedEventType;

    @CreateDateColumn({ type: 'timestamptz' })
    created_at: Date;
}
