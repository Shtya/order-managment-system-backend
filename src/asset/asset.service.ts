// src/asset/asset.service.ts
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Asset } from 'entities/assets.entity';
import { Repository } from 'typeorm';
import { CreateAssetDto, UpdateAssetDto } from 'dto/assets.dto';
import * as fs from 'fs';
import { User } from 'entities/user.entity';
import { BaseService } from '../../common/base.service';
import { TranslationService } from 'common/translation.service';

@Injectable()
export class AssetService extends BaseService<Asset> {
    constructor(
        @InjectRepository(Asset) private assetRepo: Repository<Asset>,
        @InjectRepository(User) private userRepo: Repository<User>,
        private readonly translations: TranslationService,
    ) {
        super(assetRepo);
    }

    async create(dto: CreateAssetDto, file: any, user: User) {
        if (!user?.id) throw new BadRequestException(this.translations.t('common.authenticated_user_required'));
        if (!file) throw new BadRequestException(this.translations.t('common.no_file_provided'));

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
        if (!asset) throw new NotFoundException(this.translations.t('domains.assets.not_found'));

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
        if (!asset) throw new NotFoundException(this.translations.t('domains.assets.not_found'));

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
        if (!asset) throw new NotFoundException(this.translations.t('domains.assets.not_found'));
        return asset;
    }
}
