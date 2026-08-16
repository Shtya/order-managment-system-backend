import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AiExecutionResult, AiStaleRecoveryMode, AiToolExecutionResult } from '../interfaces/ai-types';
import { AiToolContext } from './ai-tool-context';

export type AiToolExecutor = (ctx: AiToolContext, args: Record<string, unknown>) => Promise<AiExecutionResult>;

export interface AiToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	argsDto?: new (...args: any[]) => object;
	permission?: string;
	isWrite: boolean;
	staleRecovery: AiStaleRecoveryMode;
	run: AiToolExecutor;
}

export interface AiToolDedupInfo {
	key: (args: Record<string, unknown>) => string | null;
	orderId?: (args: Record<string, unknown>) => string | null;
	phone?: (args: Record<string, unknown>) => string | null;
	normPhone?: (args: Record<string, unknown>) => string | null;
}

export class AiTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
	readonly permission?: string;
	readonly isWrite: boolean;
	readonly staleRecovery: AiStaleRecoveryMode;
	readonly dedup?: AiToolDedupInfo;

	private readonly runFn: AiToolExecutor;
	private readonly argsDto?: new (...args: any[]) => object;

	constructor(def: AiToolDefinition & { dedup?: AiToolDedupInfo }) {
		this.name = def.name;
		this.description = def.description;
		this.inputSchema = def.inputSchema;
		this.permission = def.permission;
		this.isWrite = def.isWrite;
		this.staleRecovery = def.staleRecovery;
		this.dedup = def.dedup;
		this.argsDto = def.argsDto;
		this.runFn = def.run;
	}

	toSpec() {
		return {
			name: this.name,
			description: this.description,
			parameters: this.inputSchema,
		};
	}

	canRunFor(ctx: AiToolContext): boolean {
		if (!ctx.isToolAllowed(this.name)) return false;

		const requiredPermission = this.permission;
		if (!requiredPermission) return true;

		const role = ctx.session.userRoleName;
		const permissionNames = ctx.session.userPermissionNames ?? [];

		if (role === 'super_admin') return true;
		if (permissionNames.includes('*')) return true;
		return permissionNames.includes(requiredPermission);
	}

	async execute(ctx: AiToolContext, args: Record<string, unknown>): Promise<AiToolExecutionResult> {
		try {
			const validated = await this.validateArgs(args);
			if (validated.error) {
				return { ok: false, code: 'INVALID_ARGS', error: validated.error };
			}
			const result = await this.runFn(ctx, validated.args);
			return normalizeToolResult(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, code: 'TOOL_EXECUTION_ERROR', error: message };
		}
	}

	private async validateArgs(args: Record<string, unknown>): Promise<{ args: Record<string, unknown>; error?: string }> {
		if (!this.argsDto) return { args };

		const instance = plainToInstance(this.argsDto, args ?? {});
		const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: false });
		if (errors.length) {
			const messages = errors.map((e) => Object.values(e.constraints ?? {}).join('; '));
			return { args, error: `Invalid arguments for '${this.name}': ${messages.join(' | ')}` };
		}

		return { args: instance as unknown as Record<string, unknown> };
	}
}

function normalizeToolResult(result: AiExecutionResult): AiToolExecutionResult {
	if (result && typeof result === 'object' && 'ok' in result) {
		return result as AiToolExecutionResult;
	}
	return { ok: true, code: 'TOOL_RESULT', data: result };
}

export function deduplicateByKey(args: Record<string, unknown>): string | null {
	return null;
}
