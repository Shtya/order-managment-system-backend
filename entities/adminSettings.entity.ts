import { Entity, PrimaryGeneratedColumn, Column, UpdateDateColumn } from 'typeorm';

export enum WhatsAppIntegrationMode {
  EMBEDDED_SIGNUP = 'embedded_signup',
  MANUAL = 'manual',
  NONE = 'none',
}

export interface BillingAllowanceSettings {
  // Free tokens for the operation. 0 = no free tokens.
  units?: number;
  // Days since account creation the free tokens are valid.
  // Null = no expiry.
  durationDays?: number | null;
}

export interface AiDecisionBillingSettings {
  // Decimal dollars per 1M tokens (wallet currency is always dollar).
  // Single price, always applied to input + output tokens.
  tokenPrice?: number;
  // Null = not limited (unlimited free), object = capped free allowance.
  allowance?: BillingAllowanceSettings | null;
}

export interface BillingSettings {
  aiDecision?: AiDecisionBillingSettings;
}

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

  @Column({ type: 'jsonb', nullable: true, default: {
    aiDecision: {
      tokenPrice: 0.5,
      allowance: {
        units: 0,
        durationDays: null,
      },
    },
  } })
  billing: BillingSettings | null;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;

  @Column({
    type: 'enum',
    enum: WhatsAppIntegrationMode,
    default: WhatsAppIntegrationMode.EMBEDDED_SIGNUP,
  })
  whatsappIntegrationMode: WhatsAppIntegrationMode;
}