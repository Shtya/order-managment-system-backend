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
import { User } from "./user.entity";
import { AiProviderEntity } from "./ai.entity";

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
  CREATE_ORDERS = "createOrders",
  CAMPAIGN_ORDERS = "campaignOrders",
  ORDER_LOOKUP = "orderLookup",
  LOCATION = "location",
  REACTIONS = "reactions",
  TEMPLATES = "templates",
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
