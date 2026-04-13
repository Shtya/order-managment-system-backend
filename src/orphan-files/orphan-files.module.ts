import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { OrphanFilesController } from "./orphan-files.controller";
import { OrphanFilesService } from "./orphan-files.service";
import { OrphanFileEntity } from "entities/files.entity";

@Module({
  imports: [TypeOrmModule.forFeature([OrphanFileEntity])],
  controllers: [OrphanFilesController],
  providers: [OrphanFilesService],
  exports: [OrphanFilesService],
})
export class OrphanFilesModule {}

