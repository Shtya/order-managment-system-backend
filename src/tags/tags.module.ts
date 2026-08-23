import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  OrderTagEntity,
  TagAutomationEntity,
  TagEntity,
} from "entities/tag.entity";
import { OrderEntity } from "entities/order.entity";
import { TagsService } from "./tags.service";
import { TagAutomationsService } from "./tag-automations.service";
import { TagsAssignmentService } from "./tags-assignment.service";
import { TagAutomationEvaluator } from "./tag-automation.evaluator";
import {
  OrderTagsController,
  TagAutomationsController,
  TagsController,
} from "./tags.controller";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TagEntity,
      OrderTagEntity,
      TagAutomationEntity,
      OrderEntity,
    ]),
  ],
  controllers: [
    TagsController,
    TagAutomationsController,
    OrderTagsController,
  ],
  providers: [
    TagsService,
    TagAutomationsService,
    TagsAssignmentService,
    TagAutomationEvaluator,
  ],
  exports: [TagsAssignmentService, TagAutomationEvaluator, TagsService],
})
export class TagsModule {}
