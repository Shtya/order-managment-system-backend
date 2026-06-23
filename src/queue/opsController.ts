import { Controller } from '@nestjs/common';
import { BullBoardInstance, InjectBullBoard } from '@bull-board/nestjs';

@Controller('ops')
export class OpsController {
  constructor(@InjectBullBoard() private readonly board: BullBoardInstance) {}
}