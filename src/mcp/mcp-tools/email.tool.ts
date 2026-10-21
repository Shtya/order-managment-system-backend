import { UseGuards } from "@nestjs/common";
import { Payload } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { User } from "entities/user.entity";
import { EmailAccountsService } from "src/email/email-accounts.service";
import { EmailContentService } from "src/email/email-content.service";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { toolJson } from "../utils/mcp-result.util";
import { ref, TOOL } from "../utils/mcp-tool-names";
import {
  emailBuilderCapabilities,
  emailVariablesUsed,
  McpEmailDocumentError,
  mcpEmailContentSchema,
  normalizeMcpEmailDocument,
} from "../schemas/mcp-email-document";

const accountsInput = z.object({
  status: z.enum(["connected", "reconnect_required", "disconnected", "suspended", "revocation_pending", "revocation_failed"]).optional().describe("Optional connection-status filter."),
}).strict();

const previewInput = mcpEmailContentSchema.extend({
  variables: z.record(z.string(), z.string().max(10_000)).optional().describe("Sample values used only for rendering. Provide a non-empty value for every variable used by the email."),
}).strict();

function diagnostics(error: any) {
  if (error instanceof McpEmailDocumentError) return error.diagnostics;
  const response = typeof error?.getResponse === "function" ? error.getResponse() : null;
  if (response && typeof response === "object" && Array.isArray(response.diagnostics)) {
    return response.diagnostics.map((item: any) => ({
      code: item.code || "invalid_document",
      elementId: item.elementId || null,
      path: item.path || null,
      message: item.message || response.message || error.message || "Invalid email document.",
    }));
  }
  return [{ code: "invalid_email_content", elementId: null, path: null, message: typeof response === "string" ? response : error?.message || "Invalid email content." }];
}

@McpController()
@UseGuards(McpScopeGuard)
export class McpEmailTools {
  constructor(
    private readonly accounts: EmailAccountsService,
    private readonly content: EmailContentService,
  ) {}

  @McpReadTool({
    name: TOOL.email.accountsSearch,
    description: `List email senders owned by the current user. Returns safe identity, provider, status, and capabilities only; credentials and tokens are never returned. Use an account id with ${ref(TOOL.campaigns.save)} when channel=email. Read-only.`,
    parameters: accountsInput,
  })
  async searchAccounts(
    @Payload() input: z.infer<typeof accountsInput>,
    @McpUser() user: User,
  ) {
    this.accounts.assertEnabled();
    const rows = await this.accounts.listSafe(this.accounts.context(user));
    return toolJson({
      accounts: rows
        .filter((row: any) => !input.status || row.status === input.status)
        .map((row: any) => ({
          id: row.id,
          email: row.email,
          senderName: row.senderName,
          connectionName: row.connectionName,
          provider: row.provider,
          authType: row.authType,
          status: row.status,
          capabilities: row.capabilities,
        })),
    });
  }

  @McpReadTool({
    name: TOOL.email.builderCapabilities,
    description: `Return the complete canonical email-builder contract: hierarchy, fields, styles, rich text, variables, URL-only media rules, runtime limits, feature flags, block examples, and a full product-offer example. Call this before designing an email, then validate the result with ${ref(TOOL.email.preview)}. Read-only.`,
    parameters: z.object({}).strict(),
  })
  capabilities() {
    return toolJson(emailBuilderCapabilities(), { maxChars: 200_000 });
  }

  @McpReadTool({
    name: TOOL.email.preview,
    description: `Normalize, validate, and render an email through the same MJML renderer used for delivery. Does not save, upload, retain, or send anything. Input is {subject, preheader?, businessIdentity, document, variables?}; document media must use remote HTTPS URLs only. Returns the normalized document, HTML, plain text, byte size, used variables, clipping warnings, and structured diagnostics. Read ${ref(TOOL.email.builderCapabilities)} first.`,
    parameters: previewInput,
  })
  async preview(
    @Payload() input: z.infer<typeof previewInput>,
    @McpUser() user: User,
  ) {
    let normalized: any;
    try {
      normalized = {
        subject: input.subject,
        ...(input.preheader !== undefined ? { preheader: input.preheader } : {}),
        businessIdentity: input.businessIdentity,
        document: normalizeMcpEmailDocument(input.document),
      };
      this.content.validate(normalized);
      const rendered = await this.content.render(
        normalized,
        input.variables || {},
        "https://example.com/unsubscribe-preview",
        this.accounts.context(user).adminId,
      );
      return toolJson({
        valid: true,
        content: normalized,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        htmlBytes: rendered.htmlBytes,
        usedVariables: emailVariablesUsed(normalized),
        diagnostics: rendered.diagnostics || [],
        clippingWarnings: (rendered.diagnostics || []).filter((item: any) => ["gmail_clipping", "html_size"].includes(item.code)),
      }, { maxChars: 300_000 });
    } catch (error) {
      return toolJson({ valid: false, ...(normalized ? { content: normalized } : {}), diagnostics: diagnostics(error) }, { maxChars: 300_000 });
    }
  }
}
