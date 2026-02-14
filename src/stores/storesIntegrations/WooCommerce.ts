import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { BaseStoreService } from "./BaseStoreService";
import { InjectRepository } from "@nestjs/typeorm";
import { CategoryEntity } from "entities/categories.entity";
import { StoreEntity, StoreProvider } from "entities/stores.entity";
import { ProductEntity, ProductVariantEntity } from "entities/sku.entity";
import { StoresService } from "../stores.service";
import { OrdersService } from "src/orders/orders.service";
import { ProductsService } from "src/products/products.service";
import { CategoriesService } from "src/category/category.service";
import { RedisService } from "common/redis/RedisService";
import { EncryptionService } from "common/encryption.service";
import { Repository } from "typeorm";
import { OrderEntity } from "entities/order.entity";



@Injectable()
export class WooCommerceService extends BaseStoreService {
    constructor(
        @InjectRepository(StoreEntity) protected readonly storesRepo: Repository<StoreEntity>,
        @InjectRepository(CategoryEntity) protected readonly categoryRepo: Repository<CategoryEntity>,
        @InjectRepository(ProductEntity) protected readonly productsRepo: Repository<ProductEntity>,

        protected readonly mainStoresService: StoresService,
        @Inject(forwardRef(() => OrdersService))
        protected readonly ordersService: OrdersService,
        @Inject(forwardRef(() => ProductsService)) private readonly productsService: ProductsService,
        @Inject(forwardRef(() => CategoriesService))
        private readonly categoriesService: CategoriesService,

        protected readonly redisService: RedisService,
        protected readonly encryptionService: EncryptionService,
    ) {
        super(storesRepo, categoryRepo, encryptionService, mainStoresService, process.env.EASY_ORDER_BASE_URL, 400, StoreProvider.WOOCOMMERCE)

    }

    public syncCategory({ category, relatedAdminId, slug }: { category: CategoryEntity; relatedAdminId?: string; slug?: string; }) {
        throw new Error("Method not implemented.");
    }
    public syncProduct({ product, variants, slug }: { product: ProductEntity; variants: ProductVariantEntity[]; slug?: string; }) {
        throw new Error("Method not implemented.");
    }
    public syncOrderStatus(order: OrderEntity) {
        throw new Error("Method not implemented.");
    }
    public syncFullStore(store: StoreEntity) {
        throw new Error("Method not implemented.");
    }

}

