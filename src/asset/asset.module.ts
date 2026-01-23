// src/asset/asset.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Asset } from 'entities/assets.entity';
import { AssetController } from './asset.controller';
import { AssetService } from './asset.service';
import { JwtService } from '@nestjs/jwt';
import { User } from 'entities/user.entity';

@Module({
	imports: [TypeOrmModule.forFeature([Asset, User])],
	controllers: [AssetController],
	providers: [AssetService, JwtService],
})
export class AssetModule { }
