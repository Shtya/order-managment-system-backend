import { forwardRef, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { CategoryEntity } from "entities/categories.entity";
import { CategoriesService } from "./category.service";
import { CategoriesController } from "./category.controller";
import { CategorySubscriber } from "./category-subscriber";
import { StoresModule } from "src/stores/stores.module";

@Module({
	imports: [forwardRef(() => StoresModule), TypeOrmModule.forFeature([CategoryEntity])],
	providers: [CategoriesService, CategorySubscriber],
	controllers: [CategoriesController],
	exports: [CategoriesService],
})

export class CategoryModule { }
