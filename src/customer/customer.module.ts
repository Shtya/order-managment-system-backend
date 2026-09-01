import { forwardRef, Module } from "@nestjs/common";
import { CustomerService } from "./customer.service";
import { CustomerController } from "./customer.controller";
import { TypeOrmModule } from "@nestjs/typeorm";
import { CustomerEntity } from "entities/customers.entity";
import { ClientAddressEntity, ClientEntity } from "entities/clients.entity";
import { ConversationModule } from "../conversation/conversation.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([CustomerEntity, ClientEntity, ClientAddressEntity]),
    forwardRef(() => ConversationModule),
  ],
  controllers: [CustomerController],
  providers: [CustomerService],
  exports: [CustomerService],
})
export class CustomerModule {}
