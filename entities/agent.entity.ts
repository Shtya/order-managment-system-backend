import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { Role, User } from "./user.entity";
import { AiProviderEntity } from "./ai.entity";
import { IssuePriority, IssueStatusEntity } from "./issue.entity";

export enum AgentLanguage {
  AUTO = "auto",
  ARABIC = "arabic",
  ENGLISH = "english",
}

export enum AgentGender {
  MALE = "male",
  FEMALE = "female",
}

/** User-controllable capabilities (address correction is automatic, never stored). */
export enum AgentCapability {
  SEARCH_PRODUCTS = "searchProducts",
  GET_PRODUCT_DETAILS = "getProductDetails",
  SEARCH_BUNDLES = "searchBundles",
  GET_BUNDLE_DETAILS = "getBundleDetails",
  LIST_CATEGORIES = "listCategories",
  CREATE_ORDER = "createOrder",
  CAMPAIGN_ORDERS = "campaignOrders",
  GET_MY_ORDERS = "getMyOrders",
  GET_ORDER_DETAILS = "getOrderDetails",
  ADD_ORDER_ITEMS = "addOrderItems",
  REPLACE_ORDER_ITEMS = "replaceOrderItems",
  UPDATE_ORDER_ITEMS = "updateOrderItems",
  UPDATE_ORDER_INFO = "updateOrderInfo",
  CANCEL_ORDER = "cancelOrder",
  POSTPONE_ORDER = "postponeOrder",
  CONFIRM_ORDER = "confirmOrder",
  ADD_CUSTOMER_ADDRESS = "addCustomerAddress",
  UPDATE_CUSTOMER_ADDRESS = "updateCustomerAddress",
  REMOVE_CUSTOMER_ADDRESS = "removeCustomerAddress",
  SET_DEFAULT_ADDRESS = "setDefaultAddress",
  GET_MY_ADDRESSES = "getMyAddresses",
  GET_CITIES = "getCities",
  GET_AREAS_BY_CITY = "getAreasByCity",
  UPDATE_CUSTOMER = "updateCustomer",
  LOCATION = "location",
  REACTIONS = "reactions",
  TEMPLATES = "templates",
  HUMAN_HANDOFF = "humanHandoff",
}

@Index(["adminId", "name"])
@Index(["adminId", "isActive"])
@Entity("agents")
export class AgentEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "uuid", nullable: true })
  adminId: string;

  @ManyToOne(() => User, { onDelete: "SET NULL" })
  @JoinColumn({ name: "adminId" })
  admin: User;

  @Column({ type: "varchar", length: 255 })
  name: string;

  @Column({
    type: "enum",
    enum: AgentLanguage,
    default: AgentLanguage.AUTO,
  })
  language: AgentLanguage;

  @Column({
    type: "enum",
    enum: AgentGender,
    default: AgentGender.MALE,
  })
  gender: AgentGender;

  @Column({ type: "text", nullable: true })
  customInstructions?: string | null;

  @Index()
  @Column({ type: "uuid", nullable: true })
  responseProviderId?: string | null;

  @ManyToOne(() => AiProviderEntity, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "responseProviderId" })
  responseProvider?: AiProviderEntity | null;

  @Column({ type: "boolean", default: true })
  isActive: boolean;

  /** Null/empty = all capabilities (pre-capability agents keep full behavior). */
  @Column({ type: "text", array: true, nullable: true })
  capabilities?: string[] | null;

  @Column({ type: "boolean", default: false })
  acceptImage: boolean;

  @Column({ type: "boolean", default: false })
  acceptVideo: boolean;

  @Column({ type: "boolean", default: false })
  acceptDocument: boolean;

  @Column({ type: "boolean", default: false })
  acceptAudio: boolean;

  @Index()
  @Column({ type: "uuid", nullable: true })
  handoffAssignedRoleId?: string | null;

  @ManyToOne(() => Role, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "handoffAssignedRoleId" })
  handoffAssignedRole?: Role | null;

  @Column({ type: "uuid", array: true, nullable: true })
  handoffEmployeeIds?: string[] | null;

  @Column({ type: "int", nullable: true })
  handoffEstimatedMinutes?: number | null;

  @Column({
    type: "enum",
    enum: IssuePriority,
    nullable: true,
    default: IssuePriority.MEDIUM,
  })
  handoffPriority?: IssuePriority | null;

  @Index()
  @Column({ type: "uuid", nullable: true })
  handoffStatusId?: string | null;

  @ManyToOne(() => IssueStatusEntity, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "handoffStatusId" })
  handoffStatus?: IssueStatusEntity | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;
}


@Index(["adminId", "isActive"])
@Index(["adminId", "title"])
@Entity("agent_knowledge")
export class AgentKnowledgeEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "uuid" })
  adminId: string;

  @Column({ type: "varchar", length: 255 })
  title: string;

  @Column({ type: "text" })
  content: string;

  @Column({ type: "boolean", default: true })
  isActive: boolean;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;
}

@Index(["knowledgeId", "agentId"], { unique: true })
@Entity("agent_knowledge_agents")
export class AgentKnowledgeAgentEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "uuid" })
  knowledgeId: string;

  @ManyToOne(() => AgentKnowledgeEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "knowledgeId" })
  knowledge?: AgentKnowledgeEntity;

  @Index()
  @Column({ type: "uuid" })
  agentId: string;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}
