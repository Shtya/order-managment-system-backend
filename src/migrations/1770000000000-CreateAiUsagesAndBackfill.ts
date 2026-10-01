import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateAiUsagesAndBackfill1770000000000 implements MigrationInterface {
  name = "CreateAiUsagesAndBackfill1770000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ai_usages" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "adminId" uuid NOT NULL,
        "source" varchar(40) NOT NULL,
        "api" varchar(80) NOT NULL,
        "actor" varchar(20) NOT NULL,
        "billedBy" varchar(20) NOT NULL,
        "providerCode" varchar(80),
        "modelCode" varchar(200),
        "inputTokens" int NOT NULL DEFAULT 0,
        "outputTokens" int NOT NULL DEFAULT 0,
        "audioSeconds" int NOT NULL DEFAULT 0,
        "rounds" int NOT NULL DEFAULT 1,
        "status" varchar(20) NOT NULL DEFAULT 'ok',
        "grossAmount" bigint NOT NULL DEFAULT 0,
        "payableAmount" bigint NOT NULL DEFAULT 0,
        "freeUnits" bigint NOT NULL DEFAULT 0,
        "currency" varchar(8) NOT NULL DEFAULT 'USD',
        "chargeId" uuid,
        "idempotencyKey" varchar(200),
        "requestId" uuid,
        "sessionId" uuid,
        "turnId" uuid,
        "mediaUsageId" uuid,
        "agentId" uuid,
        "conversationId" uuid,
        "orderId" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_usages_admin_createdAt" ON "ai_usages" ("adminId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_usages_admin_source" ON "ai_usages" ("adminId", "source")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_usages_admin_billedBy" ON "ai_usages" ("adminId", "billedBy")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_usages_admin_modelCode" ON "ai_usages" ("adminId", "modelCode")`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_ai_usages_admin_idempotency"
      ON "ai_usages" ("adminId", "idempotencyKey")
      WHERE "idempotencyKey" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_ai_usages_chargeId"
      ON "ai_usages" ("chargeId")
      WHERE "chargeId" IS NOT NULL
    `);

    await queryRunner.query(`
      INSERT INTO "ai_usages" (
        "id", "adminId", "source", "api", "actor", "billedBy",
        "providerCode", "modelCode", "inputTokens", "outputTokens",
        "audioSeconds", "rounds", "status",
        "grossAmount", "payableAmount", "freeUnits", "currency",
        "chargeId", "idempotencyKey", "requestId", "sessionId", "turnId",
        "mediaUsageId", "agentId", "conversationId", "orderId", "createdAt"
      )
      SELECT
        gen_random_uuid(),
        t."adminId",
        'whatsapp_agent',
        'agents.runAgentTurn',
        'customer',
        'merchant',
        t.provider,
        t.model,
        COALESCE(t."promptTokens", 0),
        COALESCE(t."completionTokens", 0),
        0,
        1,
        CASE WHEN t.status = 'failed' THEN 'failed' ELSE 'ok' END,
        0, 0, 0, 'USD',
        NULL,
        'bf:turn:' || t.id::text,
        NULL,
        t."sessionId",
        t.id,
        NULL,
        t."agentId",
        t."conversationId",
        NULL,
        t."createdAt"
      FROM agent_turns t
      WHERE t."adminId" IS NOT NULL
        AND (COALESCE(t."promptTokens", 0) + COALESCE(t."completionTokens", 0) > 0 OR t.status = 'failed')
        AND NOT EXISTS (SELECT 1 FROM ai_usages u WHERE u."turnId" = t.id)
        AND NOT EXISTS (
          SELECT 1 FROM ai_usages u
          WHERE u."adminId" = t."adminId" AND u."idempotencyKey" = 'bf:turn:' || t.id::text
        )
    `);

    await queryRunner.query(`
      INSERT INTO "ai_usages" (
        "id", "adminId", "source", "api", "actor", "billedBy",
        "providerCode", "modelCode", "inputTokens", "outputTokens",
        "audioSeconds", "rounds", "status",
        "grossAmount", "payableAmount", "freeUnits", "currency",
        "chargeId", "idempotencyKey", "requestId", "sessionId", "turnId",
        "mediaUsageId", "agentId", "conversationId", "orderId", "createdAt"
      )
      SELECT
        gen_random_uuid(),
        m."adminId",
        'media',
        'media.process',
        'system',
        'madar',
        NULL,
        COALESCE(NULLIF(m."visionModel", ''), NULLIF(m."transcribeModel", ''), NULLIF(m."documentModel", '')),
        COALESCE(m."inputTokens", 0),
        COALESCE(m."outputTokens", 0),
        COALESCE(m."audioSeconds", 0),
        1,
        CASE WHEN m.status = 'failed' THEN 'failed' ELSE 'ok' END,
        COALESCE(c."grossAmount", m."chargedAmount", 0),
        COALESCE(c."payableAmount", 0),
        COALESCE(c."allowanceUnitsConsumed", 0),
        COALESCE(c.currency, 'USD'),
        m."chargeId",
        'bf:media:' || m.id::text,
        NULL,
        NULL,
        NULL,
        m.id,
        m."agentId",
        m."conversationId",
        NULL,
        m."createdAt"
      FROM agent_media_usages m
      LEFT JOIN billing_charges c ON c.id = m."chargeId"
      WHERE m."adminId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ai_usages u WHERE u."mediaUsageId" = m.id)
        AND (m."chargeId" IS NULL OR NOT EXISTS (SELECT 1 FROM ai_usages u WHERE u."chargeId" = m."chargeId"))
        AND NOT EXISTS (
          SELECT 1 FROM ai_usages u
          WHERE u."adminId" = m."adminId" AND u."idempotencyKey" = 'bf:media:' || m.id::text
        )
    `);

    await queryRunner.query(`
      INSERT INTO "ai_usages" (
        "id", "adminId", "source", "api", "actor", "billedBy",
        "providerCode", "modelCode", "inputTokens", "outputTokens",
        "audioSeconds", "rounds", "status",
        "grossAmount", "payableAmount", "freeUnits", "currency",
        "chargeId", "idempotencyKey", "requestId", "sessionId", "turnId",
        "mediaUsageId", "agentId", "conversationId", "orderId", "createdAt"
      )
      SELECT
        gen_random_uuid(),
        c."adminId",
        'address_check',
        'aiDecision.decide',
        'system',
        'madar',
        'jev',
        COALESCE(c."actualUsage"->>'modelId', a."estimatedUsage"->>'modelId'),
        COALESCE((c."actualUsage"->>'inputTokens')::int, 0),
        COALESCE((c."actualUsage"->>'outputTokens')::int, 0),
        0,
        1,
        'ok',
        COALESCE(c."grossAmount", 0),
        COALESCE(c."payableAmount", 0),
        COALESCE(c."allowanceUnitsConsumed", 0),
        COALESCE(c.currency, 'USD'),
        c.id,
        'bf:charge:' || c.id::text,
        NULL, NULL, NULL, NULL,
        CASE
          WHEN COALESCE(a.context->>'agentId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (a.context->>'agentId')::uuid
          ELSE NULL
        END,
        NULL, NULL,
        c."createdAt"
      FROM billing_charges c
      JOIN billing_authorizations a ON a.id = c."authorizationId"
      WHERE c.service = 'ai_decision'
        AND NOT EXISTS (SELECT 1 FROM agent_media_usages m WHERE m."chargeId" = c.id)
        AND NOT EXISTS (SELECT 1 FROM ai_usages u WHERE u."chargeId" = c.id)
        AND NOT EXISTS (
          SELECT 1 FROM ai_usages u
          WHERE u."adminId" = c."adminId" AND u."idempotencyKey" = 'bf:charge:' || c.id::text
        )
    `);

    await queryRunner.query(`
      INSERT INTO "ai_usages" (
        "id", "adminId", "source", "api", "actor", "billedBy",
        "providerCode", "modelCode", "inputTokens", "outputTokens",
        "audioSeconds", "rounds", "status",
        "grossAmount", "payableAmount", "freeUnits", "currency",
        "chargeId", "idempotencyKey", "requestId", "sessionId", "turnId",
        "mediaUsageId", "agentId", "conversationId", "orderId", "createdAt"
      )
      SELECT
        gen_random_uuid(),
        s."adminId",
        'address_correction',
        'automation.addressCorrection',
        'system',
        'merchant',
        ap.code,
        am."modelCode",
        COALESCE(s."usagePromptTokens", 0),
        COALESCE(s."usageCompletionTokens", 0),
        0,
        GREATEST(COALESCE(s.rounds, 1), 1),
        CASE WHEN s.status::text = 'error' THEN 'failed' ELSE 'ok' END,
        0, 0, 0, 'USD',
        NULL,
        'bf:summary:' || s.id::text,
        s."requestId",
        s."sessionId",
        NULL, NULL, NULL, NULL, NULL,
        s."createdAt"
      FROM ai_request_summaries s
      LEFT JOIN ai_models am ON am.id = s."modelId"
      LEFT JOIN ai_providers ap ON ap.id = s."providerId"
      WHERE s."adminId" IS NOT NULL
        AND s."conversationId" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ai_usages u
          WHERE u."adminId" = s."adminId" AND u."requestId" = s."requestId"
        )
        AND NOT EXISTS (
          SELECT 1 FROM ai_usages u
          WHERE u."adminId" = s."adminId" AND u."idempotencyKey" = 'bf:summary:' || s.id::text
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "ai_usages"
      WHERE "idempotencyKey" LIKE 'bf:%'
    `);
  }
}
