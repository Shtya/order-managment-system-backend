import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { RequireSubscription } from "common/require-subscription.decorator";
import { SubscriptionGuard } from "common/subscription.guard";
import { CategoriesService } from "./category.service";
import { CreateCategoryDto, UpdateCategoryDto } from "dto/category.dto";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { extname } from "path";

const categoriesStorage = diskStorage({
  destination: "./uploads/categories",
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `category-${uniqueSuffix}${extname(file.originalname)}`);
  },
});

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller("categories")
@RequireSubscription()
export class CategoriesController {
  constructor(private cats: CategoriesService) { }

  @Permissions("categories.read")
  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.cats.list(req.user, q);
  }

  @Permissions("categories.read")
  @Get("check-slug")
  async checkSlug(
    @Req() req: any,
    @Query("slug") slug: string,
    @Query("category") category: string,
  ) {

    return this.cats.checkSlug(req.user, slug, category);
  }

  @Permissions("categories.read")
  @Get(":id")
  get(@Req() req: any, @Param("id") id: string) {
    return this.cats.get(req.user, id);
  }

  @Permissions("categories.create")
  @Post()
  @UseInterceptors(
    FileFieldsInterceptor([{ name: "image", maxCount: 1 }], {
      storage: categoriesStorage,
    })
  )
  create(
    @Req() req: any,
    @UploadedFiles()
    files: { image?: Express.Multer.File[] },
    @Body() body: any
  ) {
    const dto: CreateCategoryDto = {
      name: body.name,
      slug: body.slug,
    };
    if (files?.image?.[0]) {
      dto.image = `/uploads/categories/${files.image[0].filename}`;
    }
    return this.cats.create(req.user, dto);
  }

  @Permissions("categories.update")
  @Patch(":id")
  @UseInterceptors(
    FileFieldsInterceptor([{ name: "image", maxCount: 1 }], {
      storage: categoriesStorage,
    })
  )
  update(
    @Req() req: any,
    @Param("id") id: string,
    @UploadedFiles()
    files: { image?: Express.Multer.File[] },
    @Body() body: any
  ) {
    const dto: UpdateCategoryDto = {
      name: body.name,
      slug: body.slug,
      removeImage: !!body.removeImage
    };
    if (files?.image?.[0]) {
      dto.image = `/uploads/categories/${files.image[0].filename}`;
    }
    return this.cats.update(req.user, id, dto);
  }

  @Permissions("categories.create")
  @Post(":id/duplicate")
  duplicate(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: { name: string; slug: string }
  ) {
    return this.cats.duplicate(req.user, id, body);
  }

  @Permissions("categories.delete")
  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.cats.remove(req.user, id);
  }

}
