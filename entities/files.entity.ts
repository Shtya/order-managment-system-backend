import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { User } from "./user.entity";

@Entity({ name: "orphan_files" })
@Index(["adminId", "created_at"])
@Index(["created_at"])
export class OrphanFileEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid', nullable: true }) // Set to false if adminId is mandatory
  adminId: string;

  @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
  @JoinColumn({ name: 'adminId' })
  admin: User;

  @Column({ type: "varchar", length: 600 })
  url!: string;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;
}
