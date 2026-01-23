import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { SupplierCategoryEntity, SupplierEntity } from "entities/supplier.entity";
 import { SuppliersService } from "./supplier.service";
import { SuppliersController } from "./supplier.controller";

@Module({
  imports: [TypeOrmModule.forFeature([SupplierEntity, SupplierCategoryEntity])],
  providers: [SuppliersService],
  controllers: [SuppliersController],
  exports: [SuppliersService],
})
export class SuppliersModule {}