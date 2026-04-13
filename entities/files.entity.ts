import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

@Entity({ name: "orphan_files" })
@Index(["adminId", "created_at"])
@Index(["created_at"])
export class OrphanFileEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 64 })
  @Index()
  adminId!: string;

  @Column({ type: "varchar", length: 600 })
  url!: string;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;
}
