import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ShippingCompanyEntity } from '../../entities/shipping.entity';
import { OrderEntity } from '../../entities/order.entity';

export enum ShipmentStatus {
  CREATED = 'created',
  SUBMITTED = 'submitted',
  IN_TRANSIT = 'in_transit',
  DELIVERED = 'delivered',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum UnifiedShippingStatus {
  NEW = 'new',
  IN_PROGRESS = 'in_progress',
  PICKED_UP = 'picked_up',
  IN_TRANSIT = 'in_transit',
  DELIVERED = 'delivered',
  RETURNED = 'returned',
  EXCEPTION = 'exception',
  CANCELLED = 'cancelled',
  TERMINATED = 'terminated',
  LOST = 'lost',
  DAMAGED = 'damaged',
  ON_HOLD = 'on_hold',
  ACTION_REQUIRED = 'action_required',
  ARCHIVED = 'archived',
}

@Entity({ name: 'shipping_integrations' })
@Index(['adminId', 'shippingCompanyId'], { unique: true })
export class ShippingIntegrationEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Index()
  adminId: string;

  @Column({ type: 'int' })
  @Index()
  shippingCompanyId: number;

  @ManyToOne(() => ShippingCompanyEntity, { onDelete: 'CASCADE', eager: true })
  @JoinColumn({ name: 'shippingCompanyId' })
  shippingCompany: ShippingCompanyEntity;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  /**
   * ✅ Per-admin credentials for provider integration
   * IMPORTANT: sanitize when returning (do not return full key if you want).
   */
  @Column({ type: 'jsonb', nullable: true })
  credentials?: {
    apiKey?: string;
  } | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

@Entity({ name: 'shipments' })
@Index(['adminId', 'orderId'])
@Index(['adminId', 'shippingCompanyId'])
@Index(['trackingNumber'])
export class ShipmentEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Index()
  adminId: string;

  @Column({ type: 'int', nullable: true })
  @Index()
  orderId?: number | null;

  @ManyToOne(() => OrderEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'orderId' })
  order?: OrderEntity | null;

  @Column({ type: 'int' })
  @Index()
  shippingCompanyId: number;

  @ManyToOne(() => ShippingCompanyEntity, { eager: true })
  @JoinColumn({ name: 'shippingCompanyId' })
  shippingCompany: ShippingCompanyEntity;

  @Column({ type: 'varchar', length: 120, nullable: true })
  providerShipmentId?: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  trackingNumber?: string | null;

  @Column({ type: 'enum', enum: ShipmentStatus, default: ShipmentStatus.CREATED })
  status: ShipmentStatus;

  @Column({ type: 'enum', enum: UnifiedShippingStatus, default: UnifiedShippingStatus.NEW })
  unifiedStatus: UnifiedShippingStatus;

  @Column({ type: 'text', nullable: true })
  labelUrl?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  providerRaw?: any;

  @Column({ type: 'text', nullable: true })
  failureReason?: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

@Entity({ name: 'shipment_events' })
@Index(['shipmentId', 'created_at'])
export class ShipmentEventEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  @Index()
  shipmentId: number;

  @ManyToOne(() => ShipmentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'shipmentId' })
  shipment: ShipmentEntity;

  @Column({ type: 'varchar', length: 80 })
  source: 'bosta' | 'aramex' | 'dhl' | 'system';

  @Column({ type: 'varchar', length: 80 })
  eventType: string;

  @Column({ type: 'jsonb', nullable: true })
  payload?: any;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
