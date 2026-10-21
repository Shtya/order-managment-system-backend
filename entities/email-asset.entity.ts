import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

@Entity("email_assets")
export class EmailAssetEntity {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column("uuid") adminId: string;
  @Column({ default: "image" }) kind: "image" | "video" | "document";
  @Column({ default: "upload" }) sourceType: "upload";
  @Column({ nullable: true }) originalName: string;
  @Column({ nullable: true }) mimeType: string;
  @Column({ nullable: true }) format: string;
  @Column("int", { nullable: true }) bytes: number;
  @Column("int", { nullable: true }) sourceWidth: number;
  @Column("int", { nullable: true }) sourceHeight: number;
  @Column({ type: "varchar", length: 700, nullable: true }) url: string;
  @Column("jsonb", { default: () => "'{}'::jsonb" }) metadata: Record<string, any>;
  @Column("jsonb", { default: () => "'[]'::jsonb" }) orphanIds: string[];
  @Column("jsonb", { default: () => "'[]'::jsonb" }) variants: {
    url: string;
    width: number;
    height: number;
    bytes: number;
  }[];
  @Column("timestamptz") leaseUntil: Date;
  @Column({ default: false }) saved: boolean;
  @Column({ default: false }) queued: boolean;
  @Column({ default: false }) permanent: boolean;
  @CreateDateColumn() createdAt: Date;
}
