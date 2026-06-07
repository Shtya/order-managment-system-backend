import { Module } from '@nestjs/common';
import { CitiesService } from './cities.service';
import { CitiesController } from './cities.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CityEntity, ProviderLocationEntity, CityTenantConfigEntity } from '../../entities/cities.entity';

@Module({
  imports: [TypeOrmModule.forFeature([CityEntity, ProviderLocationEntity, CityTenantConfigEntity, ProviderLocationEntity])],
  controllers: [CitiesController],
  providers: [CitiesService],
  exports: [CitiesService],
})
export class CitiesModule {}
