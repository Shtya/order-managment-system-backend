import { Body, Controller, Get, Param, Patch, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { CustomerService } from './customer.service';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { SubscriptionGuard } from 'common/subscription.guard';
import { Permissions } from 'common/permissions.decorator';
import { UpdateCustomerDto } from 'dto/customer.dto';
import { FileInterceptor } from '@nestjs/platform-express';

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller('customer')
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  

  @Patch(':id')
  @Permissions('customer.update')
  @UseInterceptors(FileInterceptor('profilePicture'))
  update(@Req() req: any, @Param('id') id: string, @Body() payload: UpdateCustomerDto, @UploadedFile() profilePicture: Express.Multer.File) {
    if (profilePicture) {
      payload.profilePicture = `/uploads/customers/${profilePicture.filename}`;
    } else {
      payload.profilePicture = null;
    }

    return this.customerService.update(req.user, id, payload);
  }

  
  @Get()
  @Permissions('customer.read')
  findAllPaginated(@Req() req: any, @Query() q: any) {
    return this.customerService.findAllPaginated(req.user, q);
  }


  @Get(':id')
  @Permissions('customer.read')
  findOne(@Req() req: any, @Param('id') id: string) {
    return this.customerService.findOne(req.user, id);
  }
}