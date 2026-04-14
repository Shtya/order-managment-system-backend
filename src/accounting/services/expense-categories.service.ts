import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CreateManualExpenseCategoryDto, UpdateManualExpenseCategoryDto } from 'dto/accounting.dto';
import { ManualExpenseCategoryEntity } from 'entities/accounting.entity';
import { tenantId } from 'src/category/category.service';
import { Not, Repository } from 'typeorm';

@Injectable()
export class ExpenseCategoriesService {
    constructor(
        @InjectRepository(ManualExpenseCategoryEntity)
        private categoryRepo: Repository<ManualExpenseCategoryEntity>,
    ) { }

    async createCategory(me: any, dto: CreateManualExpenseCategoryDto) {
        const adminId = tenantId(me);
        const existing = await this.categoryRepo.findOne({ where: { adminId, name: dto.name } });
        if (existing) {
            throw new BadRequestException('The category name already exists. Please choose a different name.');
        }
        const category = this.categoryRepo.create({ ...dto, adminId });
        return await this.categoryRepo.save(category);
    }

    async listCategories(me: any, query?: any) {
        const adminId = tenantId(me);
        const isActiveFilter = query?.isActive;

        const qb = this.categoryRepo.createQueryBuilder('category')
            .where('category.adminId = :adminId', { adminId });


        if (isActiveFilter !== undefined) {
            // Handle strings like "true"/"false" if they come from a URL query
            const isActive = isActiveFilter === 'true' || isActiveFilter === true;
            qb.andWhere('category.isActive = :isActive', { isActive });
        }


        qb.loadRelationCountAndMap('category.expensesCount', 'category.expenses');

        // 3. Optional: Order by name
        qb.orderBy('category.name', 'ASC');

        return await qb.getMany();
    }

    async updateCategory(me: any, id: string, dto: UpdateManualExpenseCategoryDto) {
        const adminId = tenantId(me);

        const category = await this.categoryRepo.findOne({ where: { id, adminId } });
        if (!category) {
            throw new NotFoundException('Category not found');
        }

        if (dto.name && dto.name !== category.name) {
            const nameExists = await this.categoryRepo.findOne({
                where: { adminId, name: dto.name, id: Not(id) }
            });
            if (nameExists) {
                throw new BadRequestException('Another category with the same name already exists.');
            }
        }

        Object.assign(category, dto);
        return await this.categoryRepo.save(category);
    }

    async deleteCategory(me: any, id: string) {
        const adminId = tenantId(me);

        const category = await this.categoryRepo.findOne({
            where: { id, adminId }
        });

        if (!category) {
            throw new NotFoundException('Category not found');
        }

        await this.categoryRepo.remove(category);
        return { success: true, message: 'Category deleted successfully' };
    }
}

