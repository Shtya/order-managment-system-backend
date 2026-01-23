import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { CategoryEntity } from "entities/categories.entity";
import { CategoriesService } from "./category.service";
import { CategoriesController } from "./category.controller";

@Module({
	imports: [TypeOrmModule.forFeature([CategoryEntity])],
	providers: [CategoriesService],
	controllers: [CategoriesController],
	exports: [CategoriesService],
})

export class CategoryModule { }
