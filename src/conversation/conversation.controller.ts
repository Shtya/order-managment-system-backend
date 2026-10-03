import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ConversationService } from "./conversation.service";
import { JwtAuthGuard } from "src/auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { SubscriptionGuard } from "common/subscription.guard";
import { Permissions } from "common/permissions.decorator";
import { CreateConversationDto } from "dto/whatsapp.dto";
import { UpdateConversationAiDto, UpdateConversationHandoffDto } from "dto/whatsapp-ai.dto";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { extname } from "path";

const meAvatarStorage = diskStorage({
  destination: "./uploads/customers",
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `customer-${uniqueSuffix}${extname(file.originalname)}`);
  },
});

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller("conversation")
export class ConversationController {
  constructor(private readonly conversationService: ConversationService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor("profilePicture", { storage: meAvatarStorage }),
  )
  @Permissions("conversation.create")
  create(
    @Req() req: any,
    @Body() payload: CreateConversationDto,
    @UploadedFile() profilePicture: Express.Multer.File,
  ) {
    if (profilePicture) {
      payload.profilePicture = `/uploads/customers/${profilePicture.filename}`;
    } else {
      payload.profilePicture = null;
    }
    return this.conversationService.createConversation(req.user, payload);
  }

  @Get()
  @Permissions("conversation.read")
  findAllPaginated(@Req() req: any, @Query() q: any) {
    return this.conversationService.findAllPaginated(req.user, q);
  }

  @Get("counts")
  @Permissions("conversation.read")
  getTabCounts(@Req() req: any) {
    return this.conversationService.getTabCounts(req.user);
  }

  @Patch(":id/ai")
  @Permissions("conversation.update")
  updateAi(
    @Req() req: any,
    @Param("id") id: string,
    @Body() dto: UpdateConversationAiDto,
  ) {
    return this.conversationService.updateAi(req.user, id, dto.aiMode);
  }

  @Patch(":id/ai/resume")
  @Permissions("conversation.update")
  resumeAgent(@Req() req: any, @Param("id") id: string) {
    return this.conversationService.resumeAgent(req.user, id);
  }

  @Patch(":id/ai/handoff")
  @Permissions("conversation.update")
  cancelHumanHandoff(
    @Req() req: any,
    @Param("id") id: string,
    @Body() dto: UpdateConversationHandoffDto,
  ) {
    if (dto.humanHandoff !== false) {
      return this.conversationService.findOne(req.user, id);
    }
    return this.conversationService.cancelHumanHandoff(req.user, id);
  }

  @Get(":id")
  @Permissions("conversation.read")
  findOne(@Req() req: any, @Param("id") id: string) {
    return this.conversationService.findOne(req.user, id);
  }
}
