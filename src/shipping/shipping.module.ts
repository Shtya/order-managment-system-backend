import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ShippingCompanyEntity } from "entities/shipping.entity";
import { ShippingCompaniesController } from "./shipping.controller";
import { ShippingCompaniesService } from "./shipping.service";

// shipping-companies.module.ts
@Module({
    imports: [TypeOrmModule.forFeature([ShippingCompanyEntity])],
    controllers: [ShippingCompaniesController],
    providers: [ShippingCompaniesService],
    exports: [ShippingCompaniesService], // Export if needed in OrdersModule
})
export class ShippingCompaniesModule { }