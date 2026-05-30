import { Body, Controller, Get, Param, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { ConversationService } from './conversation.service';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { SubscriptionGuard } from 'common/subscription.guard';
import { Permissions } from 'common/permissions.decorator';
import { CreateConversationDto } from 'dto/whatsapp.dto';
import { FileInterceptor } from '@nestjs/platform-express';

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller('conversation')
export class ConversationController {
  constructor(private readonly conversationService: ConversationService) { }


  @Post()
  @UseInterceptors(FileInterceptor('profilePicture'))
  @Permissions('conversation.create')
  create(@Req() req: any, @Body() payload: CreateConversationDto, @UploadedFile() profilePicture: Express.Multer.File) {
    if (profilePicture) {
      payload.profilePicture = `/uploads/customers/${profilePicture.filename}`;
    } else {
      payload.profilePicture = null;
    }
    return this.conversationService.getOrCreateConversation(req.user, payload);
  }


  @Get()
  @Permissions('conversation.read')
  findAllPaginated(@Req() req: any, @Query() q: any) {
    return this.conversationService.findAllPaginated(req.user, q);
  }


  @Get(':id')
  @Permissions('conversation.read')
  findOne(@Req() req: any, @Param('id') id: string) {
    return this.conversationService.findOne(req.user, id);
  }
}