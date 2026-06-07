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
  async list(@Req() req: any, @Query() q?: any) {
    return await this.systemErorrsService.list(req.user, q);
  }

  @Get('export')
  async exportErrors(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.systemErorrsService.exportErrors(req.user, q);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=system_errors_export_${Date.now()}.xlsx`);
    return res.send(buffer);
  }

  @Get('meta')
  async getMeta(@Req() req: any) {
    return await this.systemErorrsService.getMeta(req.user);
  }

  @Get('stats')
  async getStats(@Req() req: any) {
    return await this.systemErorrsService.getStats(req.user);
  }

  @Get(':id')
  async findOne(@Req() req: any, @Param('id') id: string) {
    return await this.systemErorrsService.findOne(req.user, id);
  }

  @Delete('bulk')
  async bulkDelete(@Req() req: any, @Body() body: { ids: string[] }) {
    return await this.systemErorrsService.bulkDelete(req.user, body.ids);
  }
  
  @Delete(':id')
  async delete(@Req() req: any, @Param('id') id: string) {
    return await this.systemErorrsService.delete(req.user, id);
  }

}

