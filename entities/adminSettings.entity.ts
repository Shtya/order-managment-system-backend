import { Entity, PrimaryGeneratedColumn, Column, UpdateDateColumn } from 'typeorm';

@Entity('admin_settings')
export class AdminSettingsEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true })
  email: string;

  @Column({ type: 'varchar', nullable: true })
  whatsapp: string;

  @Column({ type: 'jsonb', nullable: true, default: {} })
  socials: {
    facebook?: string;
    instagram?: string;
    x?: string;
    linkedin?: string;
    github?: string;
    youtube?: string;
  };

  @UpdateDateColumn()
  updatedAt: Date;
}