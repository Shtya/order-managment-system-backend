import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ExpenseCategoriesService } from '../services/expense-categories.service';
import { CreateManualExpenseCategoryDto, UpdateManualExpenseCategoryDto } from 'dto/accounting.dto';
import { SubscriptionGuard } from 'common/subscription.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { Permissions } from 'common/permissions.decorator';

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller('expense-categories')
export class ExpenseCategoriesController {
  constructor(private readonly categoriesService: ExpenseCategoriesService) { }

  @Get()
  @Permissions('accounting.read')
  async listCategories(@Req() req: any, @Query() q: any) {
    return await this.categoriesService.listCategories(req.user, q);
  }

  @Post()
  @Permissions('accounting.update')
  async createCategory(@Req() req: any, @Body() dto: CreateManualExpenseCategoryDto) {
    return await this.categoriesService.createCategory(req.user, dto);
  }

  @Patch(':id')
  @Permissions('accounting.update')
  async update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateManualExpenseCategoryDto
  ) {
    return await this.categoriesService.updateCategory(req.user, id, dto);
  }

  @Delete(':id')
  @Permissions('accounting.update')
  async remove(@Req() req: any, @Param('id') id: string) {
    return await this.categoriesService.deleteCategory(req.user, id);
  }
}
