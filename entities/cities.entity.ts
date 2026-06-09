import { ProviderCode, ShippingProvider } from "src/shipping/providers/shipping-provider.interface";
import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from "typeorm";
import { User } from "./user.entity";


@Index(["nameEn"])
@Index(["nameAr"])
@Entity('cities')
export class CityEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ unique: true })
    nameEn: string;

    @Column()
    nameAr: string;

    @Column({default: true})
    isActive: boolean;

    @OneToMany(() => ProviderLocationEntity, (providerLocation) => providerLocation.city)
    providerLocations: ProviderLocationEntity[];
    
    @OneToMany(() => CityTenantConfigEntity, (tenantConfig) => tenantConfig.city)
    tenantConfigs: CityTenantConfigEntity[];
}

@Index(['provider', 'providerCityId'], { unique: true })
@Index(['cityId', 'provider']) 
@Entity('provider_locations')
export class ProviderLocationEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'varchar', })
    provider: ProviderCode;

    
    @Column({type: 'varchar'})
    providerCityId: string; 

    
    @Column({type: 'varchar'})
    providerCityNameAr: string; 

    @Column({type: 'varchar', nullable: true})
    providerCityNameEn: string; 


    @ManyToOne(() => CityEntity, (city) => city.providerLocations, {
        nullable: true,       // Crucial: Allows inserting new provider cities that aren't mapped yet
        onDelete: 'SET NULL', // If you delete a unified city, it just unmaps the provider location instead of deleting it
    })
    @JoinColumn({ name: 'cityId' })
    city: CityEntity;

    @Column({ nullable: true })
    cityId: string;

    @Column({default: true})
    dropOff: boolean;
    
    @Column({default: true})
    pickup: boolean;
}


@Index(['adminId', 'cityId'], { unique: true }) 
@Entity('city_tenant_configs')
export class CityTenantConfigEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid' })
    adminId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' }) 
    @JoinColumn({ name: 'adminId' })
    admin: User;

    // --- Unified City Relation ---
    @Index()
    @Column({ type: 'uuid' })
    cityId: string;

    // Using CASCADE: If a unified city is deleted, its tenant configurations are cleaned up
    @ManyToOne(() => CityEntity, (city) => city.tenantConfigs, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'cityId' })
    city: CityEntity;

    // --- Tenant-Specific Configuration ---
    @Column({ nullable: true })
    minShippingDays: number;

    @Column({ nullable: true })
    maxShippingDays: number;
    
    @CreateDateColumn({ type: 'timestamptz' })
    createdAt: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updatedAt: Date;
}