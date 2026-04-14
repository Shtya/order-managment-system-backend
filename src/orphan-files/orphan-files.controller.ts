import {
  BadRequestException,
  Controller,
  Delete,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { extname } from "path";
import { JwtAuthGuard } from "src/auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { tenantId } from "src/category/category.service";
import { OrphanFilesService } from "./orphan-files.service";

const orphanStorage = diskStorage({
  destination: "./uploads/products",
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `product-${uniqueSuffix}${extname(file.originalname)}`);
  },
});

const multerOptions = {
  storage: orphanStorage,
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(
        new BadRequestException("Only image files are allowed!"),
        false,
      );
    }
    cb(null, true);
  },
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
};

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller("orphan-files")
export class OrphanFilesController {
  constructor(private readonly orphanFiles: OrphanFilesService) { }

  @Post()
  @UseInterceptors(FileInterceptor("file", multerOptions))
  async upload(@Req() req: any, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException("No file provided");

    const adminId = tenantId(req.user);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const url = `/uploads/products/${file.filename}`;
    const row = await this.orphanFiles.create(String(adminId), url);

    return {
      id: row.id,
      url: row.url,
    };
  }


  @Delete(":id")
  async delete(@Req() req: any, @Param("id") id: string) {
    const adminId = tenantId(req.user);
    if (!adminId) throw new BadRequestException("Missing adminId");

    return this.orphanFiles.deleteOne(
      String(adminId),
      id
    );

  }
}
