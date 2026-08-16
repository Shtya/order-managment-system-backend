import { Body, Controller, ForbiddenException, Get, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Permissions } from 'common/permissions.decorator';
import { PermissionsGuard } from 'common/permissions.guard';
import { AI_CONFIG_TOKEN, AI_PERMISSION_CHAT } from './ai.constants';
import { AiConfig } from './interfaces/provider-config.interface';
import { AiOrchestratorService } from './orchestrator/ai-orchestrator.service';
import { AiAccessGuard } from './security/ai-access.guard';
import { AiChatRequestDto, AiStatusProviderDto, AiStatusResponseDto } from './ai.dto';
import { AiToolRegistryService } from './tools/ai-tool-registry.service';
import { AiToolContext } from './tools/ai-tool-context';

@ApiTags('AI')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, AiAccessGuard)
@Controller('ai')
export class AiController {
	constructor(
		private readonly orchestrator: AiOrchestratorService,
		private readonly toolRegistry: AiToolRegistryService,
		@Inject(AI_CONFIG_TOKEN) private readonly config: AiConfig,
	) {}

	@ApiOperation({ summary: 'Run an AI assistant request with tool calling' })
	@Permissions(AI_PERMISSION_CHAT)
	@Post('chat')
	async chat(@Req() req: any, @Body() dto: AiChatRequestDto) {
		return this.orchestrator.chat(req.user, dto.message, {
			conversationId: dto.conversationId,
			// history: dto.history?.map((h) => ({
			// 	role: h.role,
			// 	content: h.content ?? null,
			// 	toolCallId: h.toolCallId,
			// 	name: h.name,
			// 	toolCalls: h.toolCalls,
			// })),
			// allowedToolNames: dto.allowedToolNames,
			// provider: dto.provider,
			// enforcePiiMasking: dto.enforcePiiMasking,
			acceptWriteOperations: dto.acceptWriteOperations,
			metadata: dto.metadata,
		});
	}

	@ApiOperation({ summary: 'Report AI module status and enabled providers' })
	@Permissions(AI_PERMISSION_CHAT)
	@Get('status')
	status(@Req() req: any): AiStatusResponseDto {
		this.ensureSuperAdmin(req.user);
		return {
			enabled: this.config.enabled,
			defaultProvider: this.config.defaultProvider,
			providers: this.config.providers.map<AiStatusProviderDto>((p) => ({
				name: p.name,
				displayName: p.displayName,
				enabled: p.enabled,
				model: p.model,
				healthy: p.enabled,
			})),
		};
	}

	@ApiOperation({ summary: 'List the tools the current user may invoke' })
	@Permissions(AI_PERMISSION_CHAT)
	@Get('tools')
	async tools(@Req() req: any) {
		this.ensureSuperAdmin(req.user);
		const me = req.user;
		const ctx = new AiToolContext({
			session: {
				sessionId: 'status',
				tenantId: me?.role?.name === 'super_admin' ? null : me?.role?.name === 'admin' ? me?.id : me?.adminId,
				userId: me?.id,
				userRoleName: me?.role?.name,
				userPermissionNames: me?.role?.permissionNames ?? [],
				enforcePiiMasking: false,
				acceptWriteOperations: false,
			},
			requestId: 'status',
		});
		return this.toolRegistry
			.getToolSpecs(ctx)
			.map((spec) => ({
				name: spec.name,
				description: spec.description,
				parameters: spec.parameters,
			}));
	}

	private ensureSuperAdmin(me: any): void {
		if (!me || me.role?.name !== 'super_admin') {
			throw new ForbiddenException({ message: 'Only super admins can access this endpoint', code: 'AI_ADMIN_ONLY' });
		}
	}
}
