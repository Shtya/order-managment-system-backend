import { Module } from '@nestjs/common';
import { CitiesService } from './cities.service';
import { CitiesController } from './cities.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CityEntity, ProviderLocationEntity, CityTenantConfigEntity, AreaEntity } from '../../entities/cities.entity';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([CityEntity, ProviderLocationEntity, CityTenantConfigEntity, ProviderLocationEntity, AreaEntity])],
  controllers: [CitiesController],
  providers: [CitiesService],
  exports: [CitiesService],
})
export class CitiesModule {}
