import { Controller, Get, Param, Query, Req, UseGuards, Res, Delete, Body } from '@nestjs/common';
import { SystemErorrsService } from './system-erorrs.service';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { Permissions } from 'common/permissions.decorator';
import { Response } from 'express';

@Controller('system-erorrs')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SystemErorrsController {
  constructor(private readonly systemErorrsService: SystemErorrsService) { }

  @Get()
  @Permissions("system.errors.list")
  async list(@Req() req: any, @Query() q?: any) {
    return await this.systemErorrsService.list(req.user, q);
  }

  @Get('export')
  @Permissions("system.errors.list")
  async exportErrors(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.systemErorrsService.exportErrors(req.user, q);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=system_errors_export_${Date.now()}.xlsx`);
    return res.send(buffer);
  }

  @Get('meta')
  @Permissions("system.errors.list")
  async getMeta(@Req() req: any) {
    return await this.systemErorrsService.getMeta(req.user);
  }

  @Get('stats')
  @Permissions("system.errors.list")
  async getStats(@Req() req: any) {
    return await this.systemErorrsService.getStats(req.user);
  }

  @Get(':id')
  @Permissions("system.errors.view")
  async findOne(@Req() req: any, @Param('id') id: string) {
    return await this.systemErorrsService.findOne(req.user, id);
  }

  @Delete('bulk')
  @Permissions("system.errors.delete")
  async bulkDelete(@Req() req: any, @Body() body: { ids: string[] }) {
    return await this.systemErorrsService.bulkDelete(req.user, body.ids);
  }
  
  @Delete(':id')
  @Permissions("system.errors.delete")
  async delete(@Req() req: any, @Param('id') id: string) {
    return await this.systemErorrsService.delete(req.user, id);
  }

}

