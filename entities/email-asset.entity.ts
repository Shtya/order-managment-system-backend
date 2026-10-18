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
  @Column() format: string;
  @Column("int") sourceWidth: number;
  @Column("int") sourceHeight: number;
  @Column("jsonb") variants: {
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
