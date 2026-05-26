
import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { CategoriesService } from '../category/category.service';
import { SupplierCategoriesService } from '../supplier/categories/categories.service';
import { SuppliersService } from '../supplier/supplier.service';
import { ProductsService } from '../products/products.service';

import { InjectRepository } from '@nestjs/typeorm';
import { ProductEntity } from 'entities/sku.entity';
import { Repository } from 'typeorm';
import { SEED_DATA } from './seed-data.config';

@Injectable()
export class SeedService {
    private readonly logger = new Logger(SeedService.name);

    constructor(
        @Inject(forwardRef(() => CategoriesService))
        private readonly categoriesService: CategoriesService,
        @Inject(forwardRef(() => SupplierCategoriesService))
        private readonly supplierCategoriesService: SupplierCategoriesService,
        @Inject(forwardRef(() => SuppliersService))
        private readonly suppliersService: SuppliersService,
        @Inject(forwardRef(() => ProductsService))
        private readonly productsService: ProductsService,
        @InjectRepository(ProductEntity)
        private readonly productRepo: Repository<ProductEntity>,
    ) {}

    async seedInitialData(user: any) {
        try {
            this.logger.log(`Starting seeding data for user: ${user.id}`);

            // 1. Seed Product Categories
            this.logger.log('Seeding product categories...');
            for (const cat of SEED_DATA.productCategories) {
                try {
                    await this.categoriesService.create(user, {
                        name: cat.name,
                        slug: cat.slug,
                        image: cat.image
                    } as any);
                } catch (e) {
                    this.logger.warn(`Failed to seed product category ${cat.name}: ${e.message}`);
                }
            }

            // 2. Seed Supplier Categories
            this.logger.log('Seeding supplier categories...');
            const supplierCategoryIds = [];
            for (const cat of SEED_DATA.supplierCategories) {
                try {
                    const savedCat = await this.supplierCategoriesService.create(user, {
                        name: cat.name,
                        description: cat.description
                    });
                    supplierCategoryIds.push(savedCat.id);
                } catch (e) {
                    this.logger.warn(`Failed to seed supplier category ${cat.name}: ${e.message}`);
                }
            }

            // 3. Seed Supplier
            this.logger.log('Seeding supplier...');
            try {
                await this.suppliersService.create(user, {
                    ...SEED_DATA.supplier,
                    categoryIds: supplierCategoryIds
                } as any);
            } catch (e) {
                this.logger.warn(`Failed to seed supplier: ${e.message}`);
            }

            // 4. Seed Products (only if user has no products)
            const productCount = await this.productRepo.count({ where: { adminId: user.id, isActive: true } });
            if (productCount === 0) {
                this.logger.log('Seeding products...');
                for (const product of SEED_DATA.products) {
                    try {
                        await this.productsService.create(user, product as any);
                    } catch (e) {
                        this.logger.warn(`Failed to seed product ${product.name}: ${e.message}`);
                    }
                }
            } else {
                this.logger.log('User already has products, skipping product seeding.');
            }

            this.logger.log(`Finished seeding data for user: ${user.id}`);
        } catch (error) {
            this.logger.error(`Error during seeding data for user ${user.id}: ${error.message}`, error.stack);
        }
    }
}
