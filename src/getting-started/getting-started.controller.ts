import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { GettingStartedService } from "./getting-started.service";
import { CreateEventDto } from "dto/getting-started.dto";

@UseGuards(JwtAuthGuard)
@Controller("getting-started")
export class GettingStartedController {
  constructor(private readonly gettingStartedService: GettingStartedService) {}

  @Get("items")
  items(@Req() req: any) {
    return this.gettingStartedService.getItems(req.user);
  }

  @Get("status")
  status(@Req() req: any) {
    return this.gettingStartedService.getStatus(req.user);
  }

  @Post("events")
  createEvent(@Req() req: any, @Body() dto: CreateEventDto) {
    return this.gettingStartedService.logEvent(req.user, dto);
  }

  @Get("progress")
  progress(@Req() req: any) {
    return this.gettingStartedService.getProgress(req.user);
  }
}
