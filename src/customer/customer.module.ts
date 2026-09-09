import { forwardRef, Module } from "@nestjs/common";
import { CustomerService } from "./customer.service";
import { CustomerController } from "./customer.controller";
import { TypeOrmModule } from "@nestjs/typeorm";
import { CustomerEntity } from "entities/customers.entity";
import { ClientAddressEntity, ClientEntity } from "entities/clients.entity";
import { ConversationModule } from "../conversation/conversation.module";
import { ClientsModule } from "src/clients/clients.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([CustomerEntity, ClientEntity, ClientAddressEntity]),
    forwardRef(() => ConversationModule),
    forwardRef(() => ClientsModule),
  ],
  controllers: [CustomerController],
  providers: [CustomerService],
  exports: [CustomerService],
})
export class CustomerModule {}
