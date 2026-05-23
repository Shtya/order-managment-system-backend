import { Controller, Get } from "@nestjs/common";
import { OrderPostponedCronService } from "./OrderPostponedCron.service";



@Controller('cron')
export class CronController {
    constructor(private readonly cronService: OrderPostponedCronService) {
    }

}
