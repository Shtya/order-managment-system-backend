import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { Response } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { RequireSubscription } from "common/require-subscription.decorator";
import { SubscriptionGuard } from "common/subscription.guard";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { extname } from "path";
import { plainToInstance } from "class-transformer";
import { validate, ValidationError } from "class-validator";
import { CampaignsService } from "./campaigns.service";
import {
  CreateCampaignDto,
  StartCampaignDto,
  toCampaignAudienceFilterDto,
  UpdateCampaignDto,
} from "dto/campaign.dto";
import {
  CAMPAIGN_AUDIENCE_FILE_MAX_BYTES,
  CAMPAIGN_AUDIENCE_UPLOAD_DIR,
} from "./campaign-audience-file.util";

const audienceFileMulterOptions = {
  storage: diskStorage({
    destination: CAMPAIGN_AUDIENCE_UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, `audience-${uniqueSuffix}${extname(file.originalname)}`);
    },
  }),
  limits: {
    fileSize: CAMPAIGN_AUDIENCE_FILE_MAX_BYTES,
  },
};

function collectDtoMessages(errors: ValidationError[]): string[] {
  const out: string[] = [];
  for (const error of errors) {
    if (error.constraints) out.push(...Object.values(error.constraints));
    if (error.children?.length) {
      out.push(...collectDtoMessages(error.children));
    }
  }
  return out;
}

// Multipart (JSON payload + audienceFile) and plain JSON share one path:
// a `payload` text field carries the JSON when a file rides along.
async function parseCampaignDto<T extends object>(
  Cls: new () => T,
  raw: any,
): Promise<T> {
  let plain = raw;
  if (typeof raw?.payload === "string") {
    try {
      plain = JSON.parse(raw.payload);
    } catch {
      throw new BadRequestException("Invalid request payload");
    }
  }
  const audienceFilter = Object.prototype.hasOwnProperty.call(
    plain || {},
    "audienceFilter",
  )
    ? plain.audienceFilter
    : undefined;
  const dto = plainToInstance(
    Cls,
    audienceFilter === undefined ? plain : { ...plain, audienceFilter: undefined },
    { enableImplicitConversion: true },
  );
  if (audienceFilter !== undefined) {
    (dto as any).audienceFilter = toCampaignAudienceFilterDto(audienceFilter);
  }
  const errors = await validate(dto as object, { whitelist: true });
  if (errors.length) {
    throw new BadRequestException(collectDtoMessages(errors));
  }
  return dto;
}

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@RequireSubscription()
@Controller("campaigns")
export class CampaignsController {
  constructor(private readonly service: CampaignsService) {}

  @Permissions("campaigns.read")
  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.service.list(req.user, q);
  }

  @Get("export")
  @Permissions("campaigns.read")
  @Header(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  )
  async export(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.service.exportCampaigns(req.user, q);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=campaigns-${Date.now()}.xlsx`,
    );
    res.end(buffer);
  }

  @Get("audience-file-template")
  @Permissions("campaigns.read")
  @Header(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  )
  async audienceFileTemplate(@Res() res: Response) {
    const buffer = await this.service.audienceFileTemplate();
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=campaign-audience-template.xlsx`,
    );
    res.end(buffer);
  }

  @Permissions("campaigns.read")
  @Get("stats")
  stats(@Req() req: any) {
    return this.service.stats(req.user);
  }

  @Permissions("campaigns.read")
  @Get(":id")
  get(@Req() req: any, @Param("id") id: string) {
    return this.service.get(req.user, id);
  }

  @Permissions("campaigns.read")
  @Get(":id/recipients")
  recipients(@Req() req: any, @Param("id") id: string, @Query() q: any) {
    return this.service.listRecipients(req.user, id, q);
  }

  @Permissions("campaigns.create")
  @Post()
  @UseInterceptors(FileInterceptor("audienceFile", audienceFileMulterOptions))
  async create(
    @Req() req: any,
    @Body() raw: any,
    @UploadedFile() audienceFile?: Express.Multer.File,
  ) {
    const dto = await parseCampaignDto(CreateCampaignDto, raw);
    return this.service.create(req.user, dto, audienceFile);
  }

  @Permissions("campaigns.update")
  @Patch(":id")
  @UseInterceptors(FileInterceptor("audienceFile", audienceFileMulterOptions))
  async update(
    @Req() req: any,
    @Param("id") id: string,
    @Body() raw: any,
    @UploadedFile() audienceFile?: Express.Multer.File,
  ) {
    const dto = await parseCampaignDto(UpdateCampaignDto, raw);
    return this.service.update(req.user, id, dto, audienceFile);
  }

  @Permissions("campaigns.delete")
  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.service.remove(req.user, id);
  }

  @Permissions("campaigns.start")
  @Post(":id/start")
  start(
    @Req() req: any,
    @Param("id") id: string,
    @Body() dto: StartCampaignDto,
  ) {
    return this.service.start(req.user, id, dto);
  }

  @Permissions("campaigns.update")
  @Post(":id/pause")
  pause(@Req() req: any, @Param("id") id: string) {
    return this.service.pause(req.user, id);
  }

  @Permissions("campaigns.update")
  @Post(":id/resume")
  resume(@Req() req: any, @Param("id") id: string) {
    return this.service.resume(req.user, id);
  }

  @Permissions("campaigns.update")
  @Post(":id/cancel")
  cancel(@Req() req: any, @Param("id") id: string) {
    return this.service.cancel(req.user, id);
  }

  @Permissions("campaigns.start")
  @Post(":id/retry-failed")
  retryFailed(@Req() req: any, @Param("id") id: string) {
    return this.service.retryFailed(req.user, id);
  }
}
