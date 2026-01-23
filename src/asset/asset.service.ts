// src/asset/asset.service.ts
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Asset } from 'entities/assets.entity';
import { Repository } from 'typeorm';
import { CreateAssetDto, UpdateAssetDto } from 'dto/assets.dto';
import * as fs from 'fs';
import { User } from 'entities/user.entity';
import { BaseService } from '../../common/base.service';

@Injectable()
export class AssetService extends BaseService<Asset> {
  constructor(
    @InjectRepository(Asset) private assetRepo: Repository<Asset>,
    @InjectRepository(User) private userRepo: Repository<User>,
  ) {
    super(assetRepo);
  }

  async create(dto: CreateAssetDto, file: any, user: User) {
    if (!user?.id) throw new BadRequestException('Authenticated user is required');
    if (!file) throw new BadRequestException('File is required');

    const asset = this.assetRepo.create({
      filename: dto.filename ?? file.originalname,
      url: file.path,
      mimeType: file.mimetype ?? null,
      user,
    });

    return this.assetRepo.save(asset);
  }

  async update(id: any, dto: UpdateAssetDto, file?: any) {
    const asset = await this.assetRepo.findOne({ where: { id } });
    if (!asset) throw new NotFoundException('Asset not found');

    if (file) {
      try {
        fs.unlinkSync(asset.url);
      } catch (err: any) {
        console.warn('Old file not found in system:', err.message);
      }

      asset.url = file.path;
      asset.mimeType = file.mimetype ?? null;
      asset.filename = dto.filename ?? file.originalname;
    } else if (dto.filename) {
      asset.filename = dto.filename;
    }

    return this.assetRepo.save(asset);
  }

  async delete(id: any) {
    const asset = await this.assetRepo.findOne({ where: { id } });
    if (!asset) throw new NotFoundException('Asset not found');

    try {
      fs.unlinkSync(asset.url);
    } catch (err: any) {
      console.warn('File not found in system:', err.message);
    }

    return this.assetRepo.remove(asset);
  }

  async findAllByUser(userId: any) {
    return this.assetRepo.find({
      where: { user: { id: userId } },
      order: { created_at: 'DESC' },
    });
  }

  async findOne(id: any) {
    const asset = await this.assetRepo.findOne({ where: { id } });
    if (!asset) throw new NotFoundException('Asset not found');
    return asset;
  }
}
