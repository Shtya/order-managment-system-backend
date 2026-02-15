import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { CreateShippingCompanyDto, UpdateShippingCompanyDto } from "dto/shipping.dto";
import { ShippingCompanyEntity } from "entities/shipping.entity";
import { tenantId } from "src/orders/orders.service";
import { Repository } from "typeorm";

// shipping-companies.service.ts
@Injectable()
export class ShippingCompaniesService {
    constructor(
        @InjectRepository(ShippingCompanyEntity)
        private readonly repo: Repository<ShippingCompanyEntity>,
    ) { }

    async create(me: any, dto: CreateShippingCompanyDto) {
        const adminId = tenantId(me);
        const name = dto.name.trim();

        // Check for duplicates within this admin's account
        const exists = await this.repo.findOneBy({ name, adminId });
        if (exists) throw new BadRequestException('Shipping company name already exists.');

        const company = this.repo.create({ ...dto, name, adminId });
        return await this.repo.save(company);
    }

    async list(me: any, q?: any) {
        const adminId = tenantId(me);
        const page = Number(q?.page ?? 1);
        const limit = Number(q?.limit ?? 10);
        const search = String(q?.search ?? "").trim();

        const qb = this.repo.createQueryBuilder("company");
        qb.where("company.adminId = :adminId", { adminId });

        if (search) {
            qb.andWhere("company.name ILIKE :s", { s: `%${search}%` });
        }

        if (q?.isActive !== undefined && q?.isActive !== '') {
            const isActive = String(q.isActive) === 'true';
            qb.andWhere("company.isActive = :isActive", { isActive });
        }

        qb.orderBy("company.created_at", "DESC");

        const [records, total] = await qb
            .skip((page - 1) * limit)
            .take(limit)
            .getManyAndCount();

        return {
            total_records: total,
            current_page: page,
            total_pages: Math.ceil(total / limit),
            records,
        };
    }

    async get(me: any, id: number) {
        const adminId = tenantId(me);
        const company = await this.repo.findOne({ where: { id, adminId } });
        if (!company) throw new NotFoundException(`Shipping company not found`);
        return company;
    }

    async update(me: any, id: number, dto: UpdateShippingCompanyDto) {
        const company = await this.get(me, id);
        if (dto.name) dto.name = dto.name.trim();

        Object.assign(company, dto);
        return await this.repo.save(company);
    }

    async remove(me: any, id: number) {
        const company = await this.get(me, id);
        return await this.repo.remove(company);
    }
}