import { Body, Controller, Delete, Get, MaxFileSizeValidator, Param, ParseFilePipe, ParseIntPipe, Patch, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { ExpensesService } from '../services/expenses.service';
import { CreateManualExpenseDto, UpdateManualExpenseDto } from 'dto/accounting.dto';
import { SubscriptionGuard } from 'common/subscription.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expensesService: ExpensesService) { }

  @Get('export')
  async export(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.expensesService.exportExpenses(req.user, q);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=expenses_export_${Date.now()}.xlsx`);

    return res.send(buffer);
  }

  @Get()
  async listExpenses(@Req() req: any, @Query() q: any) {
    return await this.expensesService.listExpenses(req.user, q);
  }

  @Post()
  @UseInterceptors(FileInterceptor('attachment', {
    storage: diskStorage({
      destination: './uploads/expenses',
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, `${file.fieldname}-${uniqueSuffix}${extname(file.originalname)}`);
      },
    }),
  }))
  async createExpense(
    @Req() req: any,
    @Body() dto: CreateManualExpenseDto,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 20 * 1024 * 1024 }), // 20MB limit
        ],
        fileIsRequired: false,
      }),
    ) file?: Express.Multer.File,
  ) {
    if (file) {
      dto.attachment = `/uploads/expenses/${file.filename}`;
    }
    return await this.expensesService.createExpense(req.user, dto);
  }

  @Patch(':id')
  @UseInterceptors(FileInterceptor('attachment', {
    storage: diskStorage({
      destination: './uploads/expenses',
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, `${file.fieldname}-${uniqueSuffix}${extname(file.originalname)}`);
      },
    }),
  }))
  async update(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateManualExpenseDto,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 20 * 1024 * 1024 }),
        ],
        fileIsRequired: false,
      }),
    ) file?: Express.Multer.File,
  ) {
    if (file) {
      dto.attachment = `/uploads/expenses/${file.filename}`;
    }
    return await this.expensesService.updateExpense(req.user, id, dto);
  }

  @Delete(':id')
  async remove(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number
  ) {
    return await this.expensesService.deleteExpense(req.user, id);
  }
}
