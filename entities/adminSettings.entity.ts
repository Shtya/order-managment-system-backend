import { Entity, PrimaryGeneratedColumn, Column, UpdateDateColumn } from 'typeorm';

export enum WhatsAppIntegrationMode {
  EMBEDDED_SIGNUP = 'embedded_signup',
  MANUAL = 'manual',
  NONE = 'none',
}

export interface BillingAllowanceSettings {
  // Free tokens for the operation. 0 = no free tokens.
  units?: number;
}

export interface AiDecisionBillingSettings {
  // Decimal dollars per 1M tokens (wallet currency is always dollar).
  // Single price, always applied to input + output tokens.
  tokenPrice?: number;
  // Null = not limited (unlimited free), object = capped free allowance.
  allowance?: BillingAllowanceSettings | null;
}

export interface AiMediaBillingSettings {
  tokenPrice?: number;
  /** Decimal dollars per minute of speech-to-text. */
  audioMinutePrice?: number;
  allowance?: BillingAllowanceSettings | null;
}

export interface AiHostedBillingSettings {
  // Decimal dollars per 1M input / output tokens. Shared across all hosted models.
  inputTokenPrice?: number;
  outputTokenPrice?: number;
  // Null = not limited (unlimited free), object = capped free allowance.
  allowance?: BillingAllowanceSettings | null;
}

export interface BillingSettings {
  // Shared free-allowance window for every AI product (decision, media, hosted).
  // Days since the resolved start date. Null = no expiry.
  allowanceDurationDays?: number | null;
  // Cutoff for old tenants: if the account was created before this YYYY-MM-DD,
  // the allowance clock starts on this date; otherwise it starts at creation.
  // Null = always use account creation.
  allowanceAnchorDate?: string | null;
  aiDecision?: AiDecisionBillingSettings;
  aiMedia?: AiMediaBillingSettings;
  aiHosted?: AiHostedBillingSettings;
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
    allowanceDurationDays: null,
    allowanceAnchorDate: null,
    aiDecision: {
      tokenPrice: 0.5,
      allowance: {
        units: 0,
      },
    },
    aiMedia: {
      tokenPrice: 0.5,
      audioMinutePrice: 0.006,
      allowance: {
        units: 0,
      },
    },
    aiHosted: {
      inputTokenPrice: 0.5,
      outputTokenPrice: 0.5,
      allowance: {
        units: 0,
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