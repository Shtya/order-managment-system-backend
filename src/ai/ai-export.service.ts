import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { TranslationService } from '../../common/translation.service';

@Injectable()
export class AiExportService {
	constructor(private readonly translations: TranslationService) {}

	async providers(data: any[]): Promise<Buffer> {
		const workbook = new ExcelJS.Workbook();
		const sheet = workbook.addWorksheet(this.translations.t('domains.ai.export_providers_sheet'));

		sheet.columns = [
			{ header: this.translations.t('domains.ai.export_col_id'), key: 'id', width: 38 },
			{ header: this.translations.t('domains.ai.export_col_code'), key: 'code', width: 15 },
			{ header: this.translations.t('domains.ai.export_col_name'), key: 'name', width: 25 },
			{ header: this.translations.t('domains.ai.export_col_scope'), key: 'scope', width: 12 },
			{ header: this.translations.t('domains.ai.export_col_website'), key: 'website', width: 30 },
			{ header: this.translations.t('domains.ai.export_col_protocol'), key: 'protocol', width: 20 },
			{ header: this.translations.t('domains.ai.export_col_tenant_allowed'), key: 'tenantIntegrationAllowed', width: 18 },
			{ header: this.translations.t('domains.ai.export_col_active'), key: 'isActive', width: 10 },
			{ header: this.translations.t('domains.ai.export_col_description'), key: 'description', width: 40 },
			{ header: this.translations.t('domains.ai.export_col_models_count'), key: 'modelsCount', width: 15 },
			{ header: this.translations.t('domains.ai.export_col_created_at'), key: 'created_at', width: 22 },
			{ header: this.translations.t('domains.ai.export_col_updated_at'), key: 'updated_at', width: 22 },
		];

		data.forEach((p) => {
			sheet.addRow({
				id: p.id,
				code: p.code ?? '',
				name: p.name,
				scope: p.scope,
				website: p.website ?? '',
				protocol: p.protocol ?? '',
				tenantIntegrationAllowed: p.tenantIntegrationAllowed ? this.translations.t('common.yes') : this.translations.t('common.no'),
				isActive: p.isActive ? this.translations.t('common.active') : this.translations.t('common.inactive'),
				description: p.description ?? '',
				modelsCount: p.models?.length ?? 0,
				created_at: p.created_at,
				updated_at: p.updated_at,
			});
		});

		this.applyHeaderStyle(sheet);
		return Buffer.from(await workbook.xlsx.writeBuffer());
	}

	async models(data: any[]): Promise<Buffer> {
		const workbook = new ExcelJS.Workbook();
		const sheet = workbook.addWorksheet(this.translations.t('domains.ai.export_models_sheet'));

		sheet.columns = [
			{ header: this.translations.t('domains.ai.export_col_id'), key: 'id', width: 38 },
			{ header: this.translations.t('domains.ai.export_col_provider_name'), key: 'providerName', width: 25 },
			{ header: this.translations.t('domains.ai.export_col_model_id'), key: 'modelId', width: 30 },
			{ header: this.translations.t('domains.ai.export_col_name'), key: 'name', width: 30 },
			{ header: this.translations.t('domains.ai.export_col_model_type'), key: 'modelType', width: 15 },
			{ header: this.translations.t('domains.ai.export_col_tier'), key: 'tier', width: 12 },
			{ header: this.translations.t('domains.ai.export_col_scope'), key: 'scope', width: 12 },
			{ header: this.translations.t('domains.ai.export_col_active'), key: 'isActive', width: 10 },
			{ header: this.translations.t('domains.ai.export_col_stream'), key: 'stream', width: 10 },
			{ header: this.translations.t('domains.ai.export_col_json_mode'), key: 'jsonMode', width: 12 },
			{ header: this.translations.t('domains.ai.export_col_reasoning'), key: 'reasoning', width: 12 },
			{ header: this.translations.t('domains.ai.export_col_tools_calling'), key: 'toolsCalling', width: 15 },
			{ header: this.translations.t('domains.ai.export_col_created_at'), key: 'created_t', width: 22 },
			{ header: this.translations.t('domains.ai.export_col_updated_at'), key: 'updated_at', width: 22 },
		];

		data.forEach((m) => {
			sheet.addRow({
				id: m.id,
				providerName: m.provider?.name ?? '',
				modelId: m.modelId,
				name: m.name,
				modelType: m.modelType,
				tier: m.tier ?? '',
				scope: m.scope,
				isActive: m.isActive ? this.translations.t('common.active') : this.translations.t('common.inactive'),
				stream: m.stream != null ? (m.stream ? this.translations.t('common.yes') : this.translations.t('common.no')) : '',
				jsonMode: m.jsonMode != null ? (m.jsonMode ? this.translations.t('common.yes') : this.translations.t('common.no')) : '',
				reasoning: m.reasoning != null ? (m.reasoning ? this.translations.t('common.yes') : this.translations.t('common.no')) : '',
				toolsCalling: m.toolsCalling != null ? (m.toolsCalling ? this.translations.t('common.yes') : this.translations.t('common.no')) : '',
				created_t: m.created_t,
				updated_at: m.updated_at,
			});
		});

		this.applyHeaderStyle(sheet);
		return Buffer.from(await workbook.xlsx.writeBuffer());
	}

	async integrations(data: any[]): Promise<Buffer> {
		const workbook = new ExcelJS.Workbook();
		const sheet = workbook.addWorksheet(this.translations.t('domains.ai.export_integrations_sheet'));

		sheet.columns = [
			{ header: this.translations.t('domains.ai.export_col_id'), key: 'id', width: 38 },
			{ header: this.translations.t('domains.ai.export_col_provider_name'), key: 'providerName', width: 25 },
			{ header: this.translations.t('domains.ai.export_col_scope'), key: 'scope', width: 12 },
			{ header: this.translations.t('domains.ai.export_col_auth_type'), key: 'authType', width: 15 },
			{ header: this.translations.t('domains.ai.export_col_base_url'), key: 'baseUrl', width: 35 },
			{ header: this.translations.t('domains.ai.export_col_active'), key: 'isActive', width: 10 },
			{ header: this.translations.t('domains.ai.export_col_last_validated'), key: 'lastValidatedAt', width: 22 },
			{ header: this.translations.t('domains.ai.export_col_last_error'), key: 'lastError', width: 40 },
			{ header: this.translations.t('domains.ai.export_col_created_at'), key: 'created_t', width: 22 },
			{ header: this.translations.t('domains.ai.export_col_updated_at'), key: 'updated_ut', width: 22 },
		];

		data.forEach((i) => {
			sheet.addRow({
				id: i.id,
				providerName: i.providerName ?? '',
				scope: i.scope,
				authType: i.authType,
				baseUrl: i.baseUrl ?? '',
				isActive: i.isActive ? this.translations.t('common.active') : this.translations.t('common.inactive'),
				lastValidatedAt: i.lastValidatedAt ?? '',
				lastError: i.lastError ?? '',
				created_t: i.created_t,
				updated_ut: i.updated_ut,
			});
		});

		this.applyHeaderStyle(sheet);
		return Buffer.from(await workbook.xlsx.writeBuffer());
	}

	async requestSummaries(data: any[]): Promise<Buffer> {
		const workbook = new ExcelJS.Workbook();
		const sheet = workbook.addWorksheet(this.translations.t('domains.ai.export_request_summaries_sheet'));

		sheet.columns = [
			{ header: this.translations.t('domains.ai.export_col_id'), key: 'id', width: 38 },
			{ header: this.translations.t('domains.ai.export_col_admin_id'), key: 'adminId', width: 38 },
			{ header: this.translations.t('domains.ai.export_col_session_id'), key: 'sessionId', width: 38 },
			{ header: this.translations.t('domains.ai.export_col_conversation_id'), key: 'conversationId', width: 38 },
			{ header: this.translations.t('domains.ai.export_col_request_id'), key: 'requestId', width: 38 },
			{ header: this.translations.t('domains.ai.export_col_provider_name'), key: 'providerName', width: 20 },
			{ header: this.translations.t('domains.ai.export_col_model_name'), key: 'modelName', width: 25 },
			{ header: this.translations.t('domains.ai.export_col_status'), key: 'status', width: 12 },
			{ header: this.translations.t('domains.ai.export_col_prompt_tokens'), key: 'usagePromptTokens', width: 15 },
			{ header: this.translations.t('domains.ai.export_col_completion_tokens'), key: 'usageCompletionTokens', width: 18 },
			{ header: this.translations.t('domains.ai.export_col_total_tokens'), key: 'usageTotalTokens', width: 15 },
			{ header: this.translations.t('domains.ai.export_col_rounds'), key: 'rounds', width: 10 },
			{ header: this.translations.t('domains.ai.export_col_duration_ms'), key: 'durationMs', width: 15 },
			{ header: this.translations.t('domains.ai.export_col_error_code'), key: 'errorCode', width: 20 },
			{ header: this.translations.t('domains.ai.export_col_error'), key: 'error', width: 40 },
			{ header: this.translations.t('domains.ai.export_col_created_at'), key: 'createdAt', width: 22 },
		];

		data.forEach((s) => {
			sheet.addRow({
				id: s.id,
				adminId: s.adminId ?? '',
				sessionId: s.sessionId,
				conversationId: s.conversationId ?? '',
				requestId: s.requestId,
				providerName: s.provider?.name ?? '',
				modelName: s.model?.name ?? '',
				status: s.status,
				usagePromptTokens: s.usagePromptTokens,
				usageCompletionTokens: s.usageCompletionTokens,
				usageTotalTokens: s.usageTotalTokens,
				rounds: s.rounds,
				durationMs: s.durationMs ?? '',
				errorCode: s.errorCode ?? '',
				error: s.error ?? '',
				createdAt: s.createdAt,
			});
		});

		this.applyHeaderStyle(sheet);
		return Buffer.from(await workbook.xlsx.writeBuffer());
	}

	async writeToolCalls(data: any[]): Promise<Buffer> {
		const workbook = new ExcelJS.Workbook();
		const sheet = workbook.addWorksheet(this.translations.t('domains.ai.export_write_tool_calls_sheet'));

		sheet.columns = [
			{ header: this.translations.t('domains.ai.export_col_id'), key: 'id', width: 38 },
			{ header: this.translations.t('domains.ai.export_col_admin_id'), key: 'adminId', width: 38 },
			{ header: this.translations.t('domains.ai.export_col_session_id'), key: 'sessionId', width: 38 },
			{ header: this.translations.t('domains.ai.export_col_request_id'), key: 'requestId', width: 38 },
			{ header: this.translations.t('domains.ai.export_col_provider_name'), key: 'providerName', width: 20 },
			{ header: this.translations.t('domains.ai.export_col_model_name'), key: 'modelName', width: 25 },
			{ header: this.translations.t('domains.ai.export_col_tool_name'), key: 'toolName', width: 25 },
			{ header: this.translations.t('domains.ai.export_col_dedup_key'), key: 'dedupKey', width: 35 },
			{ header: this.translations.t('domains.ai.export_col_tool_call_id'), key: 'toolCallId', width: 35 },
			{ header: this.translations.t('domains.ai.export_col_args_hash'), key: 'argsHash', width: 20 },
			{ header: this.translations.t('domains.ai.export_col_status'), key: 'status', width: 15 },
			{ header: this.translations.t('domains.ai.export_col_error'), key: 'error', width: 40 },
			{ header: this.translations.t('domains.ai.export_col_completed_at'), key: 'completedAt', width: 22 },
			{ header: this.translations.t('domains.ai.export_col_created_at'), key: 'createdAt', width: 22 },
		];

		data.forEach((w) => {
			sheet.addRow({
				id: w.id,
				adminId: w.adminId ?? '',
				sessionId: w.sessionId,
				requestId: w.requestId ?? '',
				providerName: w.provider?.name ?? '',
				modelName: w.model?.name ?? '',
				toolName: w.toolName,
				dedupKey: w.dedupKey,
				toolCallId: w.toolCallId ?? '',
				argsHash: w.argsHash,
				status: w.status,
				error: w.error ?? '',
				completedAt: w.completedAt ?? '',
				createdAt: w.createdAt,
			});
		});

		this.applyHeaderStyle(sheet);
		return Buffer.from(await workbook.xlsx.writeBuffer());
	}

	private applyHeaderStyle(sheet: ExcelJS.Worksheet): void {
		const headerRow = sheet.getRow(1);
		headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
		headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
		headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
		// headerRow.height = 30;
	}
}
