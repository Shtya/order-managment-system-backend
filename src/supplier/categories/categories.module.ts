import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm"; 
import { SupplierCategoryEntity } from "../../../entities/supplier.entity";
import { SupplierCategoriesService } from "./categories.service";
import { SupplierCategoriesController } from "./categories.controller";

@Module({
  imports: [TypeOrmModule.forFeature([SupplierCategoryEntity])],
  providers: [SupplierCategoriesService],
  controllers: [SupplierCategoriesController],
  exports: [SupplierCategoriesService],
})
export class SupplierCategoriesModule {}