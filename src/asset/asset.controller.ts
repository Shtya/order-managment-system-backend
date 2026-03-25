// src/asset/asset.controller.ts
import {
  Controller,
  Post,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
  Req,
  Body,
  Delete,
  Param,
  Get,
  Patch,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { CreateAssetDto, UpdateAssetDto } from 'dto/assets.dto';
import { AssetService } from './asset.service';
import { multerOptions } from '../../common/multer.config';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { Permissions } from 'common/permissions.decorator';
import { RequireSubscription } from 'common/require-subscription.decorator';
import { SubscriptionGuard } from 'common/subscription.guard';
 
@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller('assets')
@RequireSubscription()
export class AssetController {
  constructor(private readonly assetService: AssetService) {}

  @Permissions("assets.create")
  @Post()
   @UseInterceptors(FileInterceptor('file', multerOptions))
  async upload(@UploadedFile() file: any, @Body() dto: CreateAssetDto, @Req() req: any) {
    const user = req.user;
    if (!user) throw new NotFoundException('Authenticated user not found in request');
    return this.assetService.create(dto, file, user);
  }

  @Permissions("assets.create")
  @Post('bulk') 
  @UseInterceptors(FilesInterceptor('files', 20, multerOptions))
  async uploadMultiple(@UploadedFiles() files: any[], @Body() dto: CreateAssetDto, @Req() req: any) {
    if (!files?.length) throw new NotFoundException('No files uploaded');

    const user = req.user;
    if (!user) throw new NotFoundException('Authenticated user not found in request');

    const assets = await Promise.all(files.map(file => this.assetService.create(dto, file, user)));

    return {
      message: 'Assets uploaded successfully',
      assets,
    };
  }

  @Permissions("assets.read")
  @Get()
   async getMyAssets(@Req() req: any) {
    const user = req.user;
    if (!user) throw new NotFoundException('Authenticated user not found in request');
    return this.assetService.findAllByUser(user.id);
  }

  @Permissions("assets.read")
  @Get(':id')
  async getAsset(@Param('id') id: any) {
    return this.assetService.findOne(id);
  }

  @Permissions("assets.update")
  @Patch(':id')
  @UseInterceptors(FileInterceptor('file', multerOptions))
  async updateAsset(@Param('id') id: any, @UploadedFile() file: any, @Body() dto: UpdateAssetDto) {
    return this.assetService.update(id, dto, file);
  }

  @Permissions("assets.delete")
  @Delete(':id')
  async deleteAsset(@Param('id') id: any) {
    return this.assetService.delete(id);
  }
}
