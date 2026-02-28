import { forwardRef, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { OrderCollectionEntity } from "entities/order-collection.entity";
import { OrdersModule } from "src/orders/orders.module";
import { CollectionController } from "./collection.controller";
import { CollectionService } from "./collection.service";
import { OrderEntity } from "entities/order.entity";
import { ShippingIntegrationEntity } from "entities/shipping.entity";

// collection.module.ts
@Module({
    imports: [
        TypeOrmModule.forFeature([OrderCollectionEntity, OrderEntity, ShippingIntegrationEntity]),
        forwardRef(() => OrdersModule), // To access OrdersService
    ],
    controllers: [CollectionController],
    providers: [CollectionService],
    exports: [CollectionService],
})
export class CollectionModule { }