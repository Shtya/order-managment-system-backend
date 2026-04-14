import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";


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
}