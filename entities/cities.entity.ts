import { ShippingProvider } from "src/shipping/providers/shipping-provider.interface";
import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";


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
}



// @Index(['provider', 'providerCityId'], { unique: true })
// 2. Performance index: Used during checkout to quickly find the mapped ID
// @Index(['cityId', 'provider']) 
@Entity('provider_locations')
export class ProviderLocationEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    // @Column({
    //     type: 'enum',
    //     enum: ShippingProvider,
    // })
    // provider: ShippingProvider;

    
    @Column()
    providerCityId: string; 

    
    @Column()
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
}