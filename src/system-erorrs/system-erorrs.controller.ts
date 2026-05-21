import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { SystemErorrsService } from './system-erorrs.service';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { Permissions } from 'common/permissions.decorator';

@Controller('system-erorrs')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SystemErorrsController {
  constructor(private readonly systemErorrsService: SystemErorrsService) {}

  @Get()
  @Permissions("system.errors.list")
  async list(@Req() req: any, @Query() q?: any) {
    return await this.systemErorrsService.list(req.user, q);
  }

  @Get(':id')
  @Permissions("system.errors.view")
  async findOne(@Req() req: any, @Param('id') id: string) {
    return await this.systemErorrsService.findOne(req.user, id);
  }
}
