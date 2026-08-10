import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  IssueActivityEntity,
  IssueCauseEntity,
  IssueEntity,
  IssueMessageEntity,
  IssueStatusEntity,
  IssueUserEntity,
} from "entities/issue.entity";
import { IssueService } from "./issue.service";
import { IssueController } from "./issue.controller";
import { Role, User } from "entities/user.entity";
import { OrderEntity } from "entities/order.entity";
import { CustomerModule } from "../customer/customer.module";

@Module({
  imports: [
    CustomerModule,
    TypeOrmModule.forFeature([
      IssueEntity,
      IssueStatusEntity,
      IssueUserEntity,
      IssueMessageEntity,
      IssueActivityEntity,
      IssueCauseEntity,
      User,
      Role,
      OrderEntity,
    ]),
  ],
  controllers: [IssueController],
  providers: [IssueService],
  exports: [IssueService],
})
export class IssueModule {}
