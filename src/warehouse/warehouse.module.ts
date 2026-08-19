import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  StorageLocationEntity,
  WarehouseEntity,
} from "entities/warehouses.entity";
import { WarehousesService } from "./warehouse.service";
import { WarehousesController } from "./warehouse.controller";

@Module({
  imports: [TypeOrmModule.forFeature([WarehouseEntity, StorageLocationEntity])],
  providers: [WarehousesService],
  controllers: [WarehousesController],
  exports: [WarehousesService],
})
export class WarehousesModule {}
