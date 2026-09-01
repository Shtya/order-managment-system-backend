import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { User } from "./user.entity";
import { CustomerEntity } from "./customers.entity";
import { AreaEntity, CityEntity } from "./cities.entity";
import { OrderEntity } from "./order.entity";

export enum ClientStatus {
  ACTIVE = "active",
  ARCHIVED = "archived",
}

@Index(["adminId", "name"])
@Entity("clients")
export class ClientEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "uuid" })
  adminId: string;

  @ManyToOne(() => User, { onDelete: "SET NULL" })
  @JoinColumn({ name: "adminId" })
  admin: User;

  @Column({ type: "varchar", nullable: true })
  name: string;

  @Column({ type: "varchar", nullable: true })
  email: string;

  @Column({ type: "varchar", nullable: true })
  profilePicture: string;

  @Column({ type: "text", nullable: true })
  notes: string;

  @Index()
  @Column({
    type: "enum",
    enum: ClientStatus,
    default: ClientStatus.ACTIVE,
  })
  status: ClientStatus;

  @Column({ type: "jsonb", nullable: true })
  metadata: any;

  @Column({ type: "uuid", nullable: true })
  primaryContactId: string;

  @OneToOne(() => CustomerEntity, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "primaryContactId" })
  primaryContact?: CustomerEntity;

  @OneToMany(() => CustomerEntity, (contact) => contact.client)
  contacts: CustomerEntity[];

  @OneToMany(() => ClientAddressEntity, (address) => address.client)
  addresses: ClientAddressEntity[];

  @OneToMany(() => OrderEntity, (order) => order.client)
  orders: OrderEntity[];

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;
}

@Index(["clientId", "isDefault"])
@Entity("client_addresses")
export class ClientAddressEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "uuid" })
  adminId: string;

  @ManyToOne(() => User, { onDelete: "SET NULL" })
  @JoinColumn({ name: "adminId" })
  admin: User;

  @Index()
  @Column({ type: "uuid" })
  clientId: string;

  @ManyToOne(() => ClientEntity, (client) => client.addresses, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "clientId" })
  client: ClientEntity;

  @Column({ type: "varchar", length: 100, nullable: true })
  label?: string;

  @Column({ type: "text" })
  address: string;

  @Column({ type: "varchar", length: 100 })
  city: string;

  @Column({ type: "uuid", nullable: true })
  cityId: string;

  @ManyToOne(() => CityEntity, { eager: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "cityId" })
  cityDetails?: CityEntity;

  @Column({ type: "varchar", length: 100 })
  area: string;

  @Column({ type: "uuid", nullable: true })
  areaId: string;

  @ManyToOne(() => AreaEntity, { eager: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "areaId" })
  areaDetails?: AreaEntity;

  @Column({ type: "varchar", length: 200, nullable: true })
  landmark?: string;

  @Column({ type: "boolean", default: false })
  isDefault: boolean;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;
}
