import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { minutes, Throttle } from "@nestjs/throttler";
import { PublicCampaignOrderSubmitDto } from "dto/public-campaign-order.dto";
import { PublicCampaignOrdersService } from "./public-campaign-orders.service";

@Controller("public/campaign-orders")
export class PublicCampaignOrdersController {
  constructor(private readonly publicOrders: PublicCampaignOrdersService) {}

  @Get(":token")
  get(@Param("token") token: string) {
    return this.publicOrders.getByToken(token);
  }

  @Post(":token")
  submit(
    @Param("token") token: string,
    @Body() dto: PublicCampaignOrderSubmitDto,
  ) {
    return this.publicOrders.submit(token, dto);
  }
}
