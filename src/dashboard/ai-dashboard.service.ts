import { BadRequestException, Injectable } from "@nestjs/common";
import {
  addDays,
  addMonths,
  differenceInDays,
  format,
  startOfDay,
  startOfMonth,
} from "date-fns";
import { calculatePreviousRange, calculateRange } from "common/healpers";
import { BillingOperationKey, BillingServiceKey } from "entities/billing.entity";
import { BillingAllowanceSettings } from "entities/adminSettings.entity";
import { AdminSettingsService } from "src/admin-settings/admin-settings.service";
import { tenantId } from "src/category/category.service";
import { DataSource, Repository } from "typeorm";
import { describeTool } from "./ai-dashboard.tools";
import { AiDashboardQuery, ResolvedWindow, TokenTotals } from "./ai-dashboard.types";
import { TranslationService } from "common/translation.service";
import { AgentEntity } from "entities/agent.entity";
import { AiUsageBilledBy, AiUsageSource } from "entities/ai-usage.entity";
import { InjectRepository } from "@nestjs/typeorm";

const MICROS = 1_000_000;
const MEDIA_KINDS = ["image", "video", "audio", "document"] as const;
const TURN_COMPLETED = ["ok", "silent", "skipped"];
const USAGE_SOURCES = Object.values(AiUsageSource);
const BILLED_BY = Object.values(AiUsageBilledBy);

@Injectable()
export class AiDashboardService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly adminSettings: AdminSettingsService,
    private readonly translations: TranslationService,
    @InjectRepository(AgentEntity)
    private readonly agentRepo: Repository<AgentEntity>,
  ) {}

  async overview(user: any, query: AiDashboardQuery) {
    const adminId = this.requireTenant(user);
    const window = this.resolveWindow(query);
    await this.assertAgent(adminId, query.agentId);
    const extras = this.sharedFilters(query);

    const [totals, today, month, credits] = await Promise.all([
      this.kpiSlice(adminId, window, extras),
      this.kpiSlice(adminId, calculateRange("today"), extras),
      this.kpiSlice(adminId, calculateRange("this_month"), extras),
      this.credits(user, query),
    ]);

    const body: Record<string, unknown> = {
      currency: "USD",
      totals: {
        cost: totals.cost,
        tokens: totals.tokens,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        sessions: totals.sessions,
        agents: totals.agents,
        media: totals.media,
      },
      today: { cost: today.cost, tokens: today.tokens },
      month: { cost: month.cost, tokens: month.tokens },
      free: credits.free,
      aiBalance: credits.aiBalance,
    };

    if (this.wantsCompare(query)) {
      const prev = calculatePreviousRange(query.range, window.start, window.end);
      const previous = await this.kpiSlice(adminId, prev, extras);
      body.previous = {
        cost: previous.cost,
        tokens: previous.tokens,
        sessions: previous.sessions,
      };
    }
    return body;
  }

  async tokensOverTime(user: any, query: AiDashboardQuery) {
    const adminId = this.requireTenant(user);
    const window = this.resolveWindow(query);
    await this.assertAgent(adminId, query.agentId);
    const granularity = this.granularity(query, window);
    const extras = this.sharedFilters(query);
    const rows = await this.tokenBuckets(adminId, window, extras, granularity);
    return {
      granularity,
      buckets: this.fillTokenBuckets(window, granularity, rows),
    };
  }

  async tokensByAgent(user: any, query: AiDashboardQuery) {
    const adminId = this.requireTenant(user);
    const window = this.resolveWindow(query);
    await this.assertAgent(adminId, query.agentId);
    const extras = this.sharedFilters(query);
    const sql = new Sql();
    const admin = sql.add(adminId);
    const usage = this.usageWhere("u", sql, window, extras);
    const rows = await this.dataSource.query(
      `
      SELECT u."agentId", COALESCE(a.name, 'Unknown') AS "agentName",
             COALESCE(SUM(u."inputTokens"), 0)::int AS input,
             COALESCE(SUM(u."outputTokens"), 0)::int AS output
      FROM ai_usages u
      ${usage.joins}
      LEFT JOIN agents a ON a.id = u."agentId"
      WHERE u."adminId" = ${admin} AND u."agentId" IS NOT NULL ${usage.clause}
      GROUP BY u."agentId", a.name
      HAVING SUM(u."inputTokens") + SUM(u."outputTokens") > 0
      ORDER BY SUM(u."inputTokens") + SUM(u."outputTokens") DESC
      `,
      sql.params,
    );
    return { records: rows.map((r) => this.tokenRecord(r)) };
  }

  async tokensByModel(user: any, query: AiDashboardQuery) {
    const adminId = this.requireTenant(user);
    const window = this.resolveWindow(query);
    await this.assertAgent(adminId, query.agentId);
    const extras = this.sharedFilters(query);
    const sql = new Sql();
    const admin = sql.add(adminId);
    const usage = this.usageWhere("u", sql, window, extras);
    const rows = await this.dataSource.query(
      `
      SELECT COALESCE(NULLIF(u."modelCode", ''), 'unknown') AS model,
             COALESCE(SUM(u."inputTokens"), 0)::int AS input,
             COALESCE(SUM(u."outputTokens"), 0)::int AS output
      FROM ai_usages u
      ${usage.joins}
      WHERE u."adminId" = ${admin} ${usage.clause}
      GROUP BY 1
      HAVING SUM(u."inputTokens") + SUM(u."outputTokens") > 0
      ORDER BY SUM(u."inputTokens") + SUM(u."outputTokens") DESC
      `,
      sql.params,
    );
    const labels = await this.modelLabels(rows.map((r: any) => r.model));
    return {
      records: rows.map((r) => ({
        model: r.model,
        label: labels.get(r.model) || r.model,
        ...this.tokenParts(r),
      })),
    };
  }

  async costOverTime(user: any, query: AiDashboardQuery) {
    const adminId = this.requireTenant(user);
    const window = this.resolveWindow(query);
    await this.assertAgent(adminId, query.agentId);
    const granularity = this.granularity(query, window);
    const extras = this.sharedFilters(query);
    const sql = new Sql();
    const admin = sql.add(adminId);
    const trunc = granularity === "day" ? "day" : "month";
    const keyFmt = granularity === "day" ? "YYYY-MM-DD" : "YYYY-MM";
    const usage = this.usageWhere("u", sql, window, extras);
    const rows = await this.dataSource.query(
      `
      SELECT to_char(date_trunc('${trunc}', u."createdAt"), '${keyFmt}') AS key,
             COALESCE(SUM(u."payableAmount"::numeric), 0) AS cost,
             COALESCE(SUM(u."grossAmount"::numeric), 0) AS estimated
      FROM ai_usages u
      ${usage.joins}
      WHERE u."adminId" = ${admin} ${usage.clause}
      GROUP BY 1
      ORDER BY 1
      `,
      sql.params,
    );
    const map = new Map<string, { cost: number; estimated: number }>(
      rows.map((r: any) => [
        String(r.key),
        {
          cost: this.usd(r.cost),
          estimated: this.usd(r.estimated),
        },
      ]),
    );
    return {
      currency: "USD",
      granularity,
      buckets: this.fillKeys(
        window,
        granularity,
        rows.map((r: any) => String(r.key)),
        (key) => ({
          key,
          cost: map.get(key)?.cost ?? 0,
          estimated: map.get(key)?.estimated ?? 0,
        }),
      ),
    };
  }

  async costByAgent(user: any, query: AiDashboardQuery) {
    const adminId = this.requireTenant(user);
    const window = this.resolveWindow(query);
    await this.assertAgent(adminId, query.agentId);
    const extras = this.sharedFilters(query);
    const sql = new Sql();
    const admin = sql.add(adminId);
    const usage = this.usageWhere("u", sql, window, extras);
    const rows = await this.dataSource.query(
      `
      SELECT u."agentId" AS "agentId", COALESCE(ag.name, 'Unknown') AS "agentName",
             COALESCE(SUM(u."payableAmount"::numeric), 0) AS cost
      FROM ai_usages u
      ${usage.joins}
      LEFT JOIN agents ag ON ag.id = u."agentId"
      WHERE u."adminId" = ${admin} AND u."agentId" IS NOT NULL ${usage.clause}
      GROUP BY u."agentId", ag.name
      HAVING SUM(u."payableAmount"::numeric) > 0
      ORDER BY SUM(u."payableAmount"::numeric) DESC
      `,
      sql.params,
    );
    return {
      currency: "USD",
      records: rows.map((r) => ({
        agentId: r.agentId,
        agentName: r.agentName,
        cost: this.usd(r.cost),
      })),
    };
  }

  async costByModel(user: any, query: AiDashboardQuery) {
    const adminId = this.requireTenant(user);
    const window = this.resolveWindow(query);
    await this.assertAgent(adminId, query.agentId);
    const extras = this.sharedFilters(query);
    const sql = new Sql();
    const admin = sql.add(adminId);
    const usage = this.usageWhere("u", sql, window, extras);
    const rows = await this.dataSource.query(
      `
      SELECT COALESCE(NULLIF(u."modelCode", ''), 'unknown') AS model,
             COALESCE(SUM(u."payableAmount"::numeric), 0) AS cost
      FROM ai_usages u
      ${usage.joins}
      WHERE u."adminId" = ${admin} ${usage.clause}
      GROUP BY 1
      HAVING SUM(u."payableAmount"::numeric) > 0
      ORDER BY SUM(u."payableAmount"::numeric) DESC
      `,
      sql.params,
    );
    const labels = await this.modelLabels(rows.map((r: any) => r.model));
    return {
      currency: "USD",
      records: rows.map((r) => ({
        model: r.model,
        label: labels.get(r.model) || r.model,
        cost: this.usd(r.cost),
      })),
    };
  }

  async costByMediaType(user: any, query: AiDashboardQuery) {
    const adminId = this.requireTenant(user);
    const window = this.resolveWindow(query);
    await this.assertAgent(adminId, query.agentId);
    const extras = this.sharedFilters(query);
    const sql = new Sql();
    const admin = sql.add(adminId);
    const usage = this.usageWhere("u", sql, window, extras);
    const rows = await this.dataSource.query(
      `
      SELECT m.kind AS "mediaType",
             COALESCE(SUM(u."payableAmount"::numeric), 0) AS cost
      FROM ai_usages u
      ${usage.joins}
      JOIN agent_media_usages m ON m.id = u."mediaUsageId"
      WHERE u."adminId" = ${admin} AND u.source = 'media' ${usage.clause}
      GROUP BY m.kind
      `,
      sql.params,
    );
    const map = new Map(rows.map((r) => [r.mediaType, this.usd(r.cost)]));
    return {
      currency: "USD",
      records: MEDIA_KINDS.map((mediaType) => ({
        mediaType,
        cost: map.get(mediaType) ?? 0,
      })),
    };
  }

  async costBreakdown(user: any, query: AiDashboardQuery) {
    const adminId = this.requireTenant(user);
    const window = this.resolveWindow(query);
    await this.assertAgent(adminId, query.agentId);
    const extras = this.sharedFilters(query);
    const [range, today, month] = await Promise.all([
      this.costSlice(adminId, window, extras),
      this.costSlice(adminId, calculateRange("today"), extras),
      this.costSlice(adminId, calculateRange("this_month"), extras),
    ]);
    const body: Record<string, unknown> = {
      currency: "USD",
      total: range.paid,
      today: today.paid,
      month: month.paid,
      inputCost: range.inputCost,
      outputCost: range.outputCost,
      transcriptionCost: range.transcriptionCost,
      estimated: range.estimated,
      actual: range.gross,
      freeValue: range.freeValue,
      paidValue: range.paid,
    };
    if (this.wantsCompare(query)) {
      const prev = calculatePreviousRange(query.range, window.start, window.end);
      const previous = await this.costSlice(adminId, prev, extras);
      body.previous = {
        total: previous.paid,
        inputCost: previous.inputCost,
        outputCost: previous.outputCost,
      };
    }
    return body;
  }

  async credits(user: any, _query?: AiDashboardQuery) {
    const adminId = this.requireTenant(user);
    const settings = await this.adminSettings.getSettings();
    const [account, wallet, decisionUsage, mediaUsage] = await Promise.all([
      this.dataSource.query(`SELECT "createdAt" FROM users WHERE id = $1`, [
        adminId,
      ]),
      this.dataSource.query(
        `SELECT "aiBalance" FROM wallets WHERE "userId" = $1`,
        [adminId],
      ),
      this.dataSource.query(
        `SELECT "usedUnits", "reservedUnits"
         FROM billing_allowance_usage
         WHERE "adminId" = $1 AND service = $2 AND operation = $3`,
        [adminId, BillingServiceKey.AI_DECISION, BillingOperationKey.EVALUATE],
      ),
      this.dataSource.query(
        `SELECT "usedUnits", "reservedUnits"
         FROM billing_allowance_usage
         WHERE "adminId" = $1 AND service = $2 AND operation = $3`,
        [adminId, BillingServiceKey.AI_MEDIA, BillingOperationKey.PROCESS],
      ),
    ]);
    const createdAt = account[0]?.createdAt
      ? new Date(account[0].createdAt)
      : null;
    return {
      currency: "USD",
      free: {
        aiDecision: this.liveGrant(
          settings.billing?.aiDecision?.allowance,
          decisionUsage[0],
          createdAt,
        ),
        aiMedia: this.liveGrant(
          settings.billing?.aiMedia?.allowance,
          mediaUsage[0],
          createdAt,
        ),
      },
      aiBalance: round4(Number(wallet[0]?.aiBalance ?? 0)),
    };
  }

  async agentsTable(user: any, query: AiDashboardQuery) {
    const adminId = this.requireTenant(user);
    const window = this.resolveWindow(query);
    const extras = { ...this.sharedFilters(query), agentId: undefined };
    const { page, limit, offset } = this.paging(query);
    const sort = this.pick(
      query.sort,
      [
        "sessions",
        "messages",
        "tokens",
        "cost",
        "avgTokens",
        "avgCost",
        "today",
        "month",
        "media",
      ],
      "tokens",
    );
    const order = query.order === "asc" ? "ASC" : "DESC";
    const sql = new Sql();
    const admin = sql.add(adminId);
    const today = calculateRange("today");
    const month = calculateRange("this_month");
    const tStart = sql.add(today.start);
    const tEnd = sql.add(today.end);
    const mStart = sql.add(month.start);
    const mEnd = sql.add(month.end);
    const { clause, joins } = this.sessionWhere("s", sql, window, extras);

    const sortSql: Record<string, string> = {
      sessions: `sessions`,
      messages: `messages`,
      tokens: `tokens`,
      cost: `cost`,
      avgTokens: `avg_tokens`,
      avgCost: `avg_cost`,
      today: `today_tokens`,
      month: `month_tokens`,
      media: `media`,
    };

    const rows = await this.dataSource.query(
      `
      WITH scoped AS (
        SELECT s.*
        FROM agent_sessions s
        ${joins}
        WHERE s."adminId" = ${admin} ${clause}
      ),
      stats AS (
        SELECT
          s."agentId" AS agent_id,
          COUNT(DISTINCT s.id)::int AS sessions,
          COALESCE((
            SELECT COUNT(*)::int FROM agent_turn_messages tm
            JOIN agent_turns tt ON tt.id = tm."turnId"
            WHERE tt."sessionId" IN (SELECT id FROM scoped sc WHERE sc."agentId" = s."agentId")
              AND tm.role = 'assistant'
          ), 0) AS messages,
          COALESCE((
            SELECT SUM(tt."promptTokens" + tt."completionTokens") FROM agent_turns tt
            WHERE tt."sessionId" IN (SELECT id FROM scoped sc WHERE sc."agentId" = s."agentId")
          ), 0)::int
          + COALESCE((
            SELECT SUM(mu."inputTokens" + mu."outputTokens") FROM agent_media_usages mu
            WHERE mu."adminId" = ${admin} AND mu."agentId" = s."agentId"
              AND mu."conversationId" IN (SELECT "conversationId" FROM scoped sc WHERE sc."agentId" = s."agentId")
          ), 0)::int AS tokens,
          COALESCE((
            SELECT SUM(c."payableAmount"::numeric) FROM billing_charges c
            JOIN agent_media_usages mu ON mu."chargeId" = c.id
            WHERE mu."adminId" = ${admin} AND mu."agentId" = s."agentId"
              AND c.service IN ('${BillingServiceKey.AI_DECISION}', '${BillingServiceKey.AI_MEDIA}')
              AND mu."conversationId" IN (SELECT "conversationId" FROM scoped sc WHERE sc."agentId" = s."agentId")
          ), 0) AS cost,
          COALESCE((
            SELECT SUM(tt."promptTokens" + tt."completionTokens") FROM agent_turns tt
            WHERE tt."agentId" = s."agentId" AND tt."adminId" = ${admin}
              AND tt."createdAt" BETWEEN ${tStart} AND ${tEnd}
          ), 0)::int AS today_tokens,
          COALESCE((
            SELECT SUM(tt."promptTokens" + tt."completionTokens") FROM agent_turns tt
            WHERE tt."agentId" = s."agentId" AND tt."adminId" = ${admin}
              AND tt."createdAt" BETWEEN ${mStart} AND ${mEnd}
          ), 0)::int AS month_tokens,
          COALESCE((
            SELECT COUNT(*) FROM agent_media_usages mu
            WHERE mu."adminId" = ${admin} AND mu."agentId" = s."agentId"
              AND mu."conversationId" IN (SELECT "conversationId" FROM scoped sc WHERE sc."agentId" = s."agentId")
          ), 0)::int AS media,
          (
            SELECT tt.model FROM agent_turns tt
            WHERE tt."sessionId" IN (SELECT id FROM scoped sc WHERE sc."agentId" = s."agentId")
              AND tt.model IS NOT NULL AND tt.model <> ''
            GROUP BY tt.model
            ORDER BY SUM(tt."promptTokens" + tt."completionTokens") DESC
            LIMIT 1
          ) AS top_model
        FROM scoped s
        GROUP BY s."agentId"
      )
      SELECT
        agent_id AS "agentId",
        COALESCE(ag.name, 'Unknown') AS "agentName",
        sessions, messages, tokens, cost,
        CASE WHEN sessions = 0 THEN 0 ELSE ROUND(tokens::numeric / sessions) END AS avg_tokens,
        CASE WHEN sessions = 0 THEN 0 ELSE cost / sessions END AS avg_cost,
        today_tokens, month_tokens, media, top_model
      FROM stats
      LEFT JOIN agents ag ON ag.id = stats.agent_id
      ORDER BY ${sortSql[sort]} ${order}
      LIMIT ${sql.add(limit)} OFFSET ${sql.add(offset)}
      `,
      sql.params,
    );

    const countSql = new Sql();
    const countAdmin = countSql.add(adminId);
    const scoped = this.sessionWhere("s", countSql, window, extras);
    const countRows = await this.dataSource.query(
      `SELECT COUNT(DISTINCT s."agentId")::int AS n
       FROM agent_sessions s
       ${scoped.joins}
       WHERE s."adminId" = ${countAdmin} ${scoped.clause}`,
      countSql.params,
    );

    const labels = await this.modelLabels(
      rows.map((r: any) => r.top_model).filter(Boolean),
    );
    return {
      records: rows.map((r) => ({
        agentId: r.agentId,
        agentName: r.agentName,
        sessions: Number(r.sessions),
        messages: Number(r.messages),
        tokens: Number(r.tokens),
        cost: this.usd(r.cost),
        avgTokensPerSession: Number(r.avg_tokens),
        avgCostPerSession: this.usd(Number(r.avg_cost) || 0),
        topModel: r.top_model ? labels.get(r.top_model) || r.top_model : null,
        todayTokens: Number(r.today_tokens),
        monthTokens: Number(r.month_tokens),
        media: Number(r.media),
      })),
      total_records: Number(countRows[0]?.n ?? 0),
      current_page: page,
      per_page: limit,
    };
  }

  async mediaSummary(user: any, query: AiDashboardQuery) {
    const adminId = this.requireTenant(user);
    const window = this.resolveWindow(query);
    await this.assertAgent(adminId, query.agentId);
    const extras = this.sharedFilters(query);
    const sql = new Sql();
    const admin = sql.add(adminId);
    const { clause, joins } = this.mediaWhere("m", sql, window, extras);
    const rows = await this.dataSource.query(
      `
      SELECT m.kind,
             COUNT(*)::int AS count,
             COALESCE(SUM(m."inputTokens" + m."outputTokens"), 0)::int AS tokens,
             COALESCE(SUM(m."chargedAmount"::numeric), 0) AS cost
      FROM agent_media_usages m
      ${joins}
      WHERE m."adminId" = ${admin} ${clause}
      GROUP BY m.kind
      `,
      sql.params,
    );
    const topSql = new Sql();
    const topAdmin = topSql.add(adminId);
    const topWhere = this.mediaWhere("m", topSql, window, extras);
    const topRows = await this.dataSource.query(
      `
      SELECT DISTINCT ON (kind) kind, model AS "topModel"
      FROM (
        SELECT m.kind,
               COALESCE(NULLIF(m."visionModel", ''), NULLIF(m."transcribeModel", ''), NULLIF(m."documentModel", '')) AS model,
               COUNT(*) AS n
        FROM agent_media_usages m
        ${topWhere.joins}
        WHERE m."adminId" = ${topAdmin} ${topWhere.clause}
        GROUP BY 1, 2
      ) x
      WHERE model IS NOT NULL
      ORDER BY kind, n DESC
      `,
      topSql.params,
    );
    const map = new Map<string, any>(rows.map((r: any) => [r.kind, r]));
    const topMap = new Map<string, string>(
      topRows.map((r: any) => [r.kind, r.topModel]).filter((pair) => pair[1]),
    );
    const labels = await this.modelLabels([...topMap.values()]);
    return {
      currency: "USD",
      records: MEDIA_KINDS.map((kind) => {
        const row = map.get(kind);
        const topModel = topMap.get(kind);
        return {
          kind,
          count: Number(row?.count ?? 0),
          tokens: Number(row?.tokens ?? 0),
          cost: this.usd(row?.cost ?? 0),
          topModel: topModel ? labels.get(topModel) || topModel : null,
        };
      }),
    };
  }

  async mediaOverTime(user: any, query: AiDashboardQuery) {
    const adminId = this.requireTenant(user);
    const window = this.resolveWindow(query);
    await this.assertAgent(adminId, query.agentId);
    const granularity = this.granularity(query, window);
    const extras = this.sharedFilters(query);
    const sql = new Sql();
    const admin = sql.add(adminId);
    const trunc = granularity === "day" ? "day" : "month";
    const keyFmt = granularity === "day" ? "YYYY-MM-DD" : "YYYY-MM";
    const { clause, joins } = this.mediaWhere("m", sql, window, extras);
    const rows = await this.dataSource.query(
      `
      SELECT to_char(date_trunc('${trunc}', m."createdAt"), '${keyFmt}') AS key,
             COUNT(*)::int AS count
      FROM agent_media_usages m
      ${joins}
      WHERE m."adminId" = ${admin} ${clause}
      GROUP BY 1
      ORDER BY 1
      `,
      sql.params,
    );
    const map = new Map<string, number>(
      rows.map((r: any) => [String(r.key), Number(r.count)]),
    );
    return {
      granularity,
      buckets: this.fillKeys(
        window,
        granularity,
        rows.map((r: any) => String(r.key)),
        (key) => ({ key, count: map.get(key) ?? 0 }),
      ),
    };
  }

  async toolsSummary(user: any, query: AiDashboardQuery) {
    const adminId = this.requireTenant(user);
    const window = this.resolveWindow(query);
    await this.assertAgent(adminId, query.agentId);
    const extras = { ...this.sharedFilters(query), mediaType: undefined };
    const sort = this.pick(
      query.sort,
      ["tool", "calls", "share", "input", "output", "total", "errors", "cost"],
      "calls",
    );
    const order = query.order === "asc" ? 1 : -1;
    const sql = new Sql();
    const admin = sql.add(adminId);
    const { clause, joins } = this.turnWhere("t", sql, window, extras);
    const rows = await this.dataSource.query(
      `
      SELECT call->>'name' AS name,
             COUNT(*)::int AS calls,
             COUNT(*) FILTER (
               WHERE t.status = 'failed'
                  OR COALESCE(tm.content, '') ILIKE '%"ok":false%'
                  OR COALESCE(tm.content, '') ILIKE '%error%'
             )::int AS errors,
             COALESCE(SUM(t."promptTokens"), 0)::int AS input,
             COALESCE(SUM(t."completionTokens"), 0)::int AS output
      FROM agent_turns t
      JOIN agent_turn_messages tm ON tm."turnId" = t.id
      ${joins}
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(tm."toolCalls", '[]'::jsonb)) call
      WHERE t."adminId" = ${admin}
        AND tm.role = 'assistant'
        ${clause}
      GROUP BY 1
      `,
      sql.params,
    );

    const totalCalls = rows.reduce((s, r) => s + Number(r.calls), 0) || 0;
    const records = rows.map((r) => {
      const meta = describeTool(r.name);
      const input = Number(r.input);
      const output = Number(r.output);
      return {
        name: r.name,
        label: meta.label,
        group: meta.group,
        calls: Number(r.calls),
        share: totalCalls ? round4((Number(r.calls) / totalCalls) * 100) : 0,
        input,
        output,
        total: input + output,
        errors: Number(r.errors),
        cost: 0,
      };
    });

    const sortKey: Record<string, (r: (typeof records)[0]) => number | string> = {
      tool: (r) => r.label,
      calls: (r) => r.calls,
      share: (r) => r.share,
      input: (r) => r.input,
      output: (r) => r.output,
      total: (r) => r.total,
      errors: (r) => r.errors,
      cost: (r) => r.cost,
    };
    records.sort((a, b) => {
      const av = sortKey[sort](a);
      const bv = sortKey[sort](b);
      if (av < bv) return -1 * order;
      if (av > bv) return 1 * order;
      return 0;
    });

    const groupMap = new Map<
      string,
      { group: string; tools: number; calls: number; tokens: number; cost: number }
    >();
    for (const r of records) {
      const g = groupMap.get(r.group) || {
        group: r.group,
        tools: 0,
        calls: 0,
        tokens: 0,
        cost: 0,
      };
      g.tools += 1;
      g.calls += r.calls;
      g.tokens += r.total;
      groupMap.set(r.group, g);
    }

    const top = records[0];
    const errorCalls = records.reduce((s, r) => s + r.errors, 0);
    const tokenSum = records.reduce((s, r) => s + r.total, 0);
    return {
      currency: "USD",
      totals: {
        calls: totalCalls,
        topTool: top?.label ?? null,
        avgTokensPerCall: totalCalls ? Math.round(tokenSum / totalCalls) : 0,
        errorRate: totalCalls ? round4((errorCalls / totalCalls) * 100) : 0,
      },
      groups: [...groupMap.values()],
      records: records.map(({ name: _n, ...rest }) => rest),
    };
  }

  async sessions(user: any, query: AiDashboardQuery) {
    const adminId = this.requireTenant(user);
    const window = this.resolveWindow(query);
    await this.assertAgent(adminId, query.agentId);
    const extras = this.sharedFilters(query);
    const { page, limit, offset } = this.paging(query);
    const sort = this.pick(query.sort, ["date", "tokens", "cost", "duration"], "date");
    const order = query.order === "asc" ? "ASC" : "DESC";
    const sortSql = {
      date: `s."startedAt"`,
      tokens: `tokens`,
      cost: `cost`,
      duration: `duration_ms`,
    }[sort];

    const sql = new Sql();
    const admin = sql.add(adminId);
    const { clause, joins } = this.sessionWhere("s", sql, window, extras, true);
    const rows = await this.dataSource.query(
      `
      SELECT
        s.id, s."startedAt" AS date, s."agentId",
        COALESCE(ag.name, 'Unknown') AS "agentName",
        cu.name AS customer, cu."phoneNumber" AS phone,
        COALESCE((
          SELECT SUM(t."promptTokens") FROM agent_turns t WHERE t."sessionId" = s.id
        ), 0)::int AS input,
        COALESCE((
          SELECT SUM(t."completionTokens") FROM agent_turns t WHERE t."sessionId" = s.id
        ), 0)::int AS output,
        COALESCE((
          SELECT SUM(t."durationMs") FROM agent_turns t WHERE t."sessionId" = s.id
        ), 0)::int AS duration_ms,
        COALESCE((
          SELECT COUNT(*) FROM agent_media_usages mu
          WHERE mu."conversationId" = s."conversationId"
        ), 0)::int AS media,
        COALESCE((
          SELECT SUM(c."payableAmount"::numeric) FROM billing_charges c
          JOIN agent_media_usages mu ON mu."chargeId" = c.id
          WHERE mu."conversationId" = s."conversationId"
            AND c.service IN ('${BillingServiceKey.AI_DECISION}', '${BillingServiceKey.AI_MEDIA}')
        ), 0) AS cost,
        (
          SELECT t.model FROM agent_turns t
          WHERE t."sessionId" = s.id AND t.model IS NOT NULL AND t.model <> ''
          GROUP BY t.model
          ORDER BY SUM(t."promptTokens" + t."completionTokens") DESC
          LIMIT 1
        ) AS model,
        CASE
          WHEN EXISTS (SELECT 1 FROM agent_turns t WHERE t."sessionId" = s.id AND t.status = 'running')
            THEN 'processing'
          WHEN EXISTS (SELECT 1 FROM agent_turns t WHERE t."sessionId" = s.id AND t.status = 'failed')
            THEN 'failed'
          ELSE 'completed'
        END AS status
      FROM agent_sessions s
      LEFT JOIN agents ag ON ag.id = s."agentId"
      ${joins}
      WHERE s."adminId" = ${admin} ${clause}
      ORDER BY ${sortSql} ${order}
      LIMIT ${sql.add(limit)} OFFSET ${sql.add(offset)}
      `,
      sql.params,
    );

    const countSql = new Sql();
    const countAdmin = countSql.add(adminId);
    const scoped = this.sessionWhere("s", countSql, window, extras, true);
    const countRows = await this.dataSource.query(
      `SELECT COUNT(*)::int AS n FROM agent_sessions s ${scoped.joins}
       WHERE s."adminId" = ${countAdmin} ${scoped.clause}`,
      countSql.params,
    );
    const labels = await this.modelLabels(
      rows.map((r: any) => r.model).filter(Boolean),
    );
    const records = rows.map((r) => this.sessionRow(r, labels));
    return {
      records,
      total_records: Number(countRows[0]?.n ?? 0),
      current_page: page,
      per_page: limit,
    };
  }

  async exportSessions(user: any, query: AiDashboardQuery) {
    const result = await this.sessions(user, {
      ...query,
      page: 1,
      limit: 10000,
    });
    const header = "id,date,agent,customer,phone,model,input,output,total,cost,status";
    const lines = result.records.map((r) =>
      [
        r.id,
        r.date,
        csv(r.agentName),
        csv(r.customer),
        csv(r.phone),
        csv(r.model),
        r.input,
        r.output,
        r.total,
        r.cost,
        r.status,
      ].join(","),
    );
    return [header, ...lines].join("\n");
  }

  async topCustomers(user: any, query: AiDashboardQuery) {
    const adminId = this.requireTenant(user);
    const window = this.resolveWindow(query);
    await this.assertAgent(adminId, query.agentId);
    const extras = this.sharedFilters(query);
    const limit = Math.min(50, Math.max(1, Number(query.limit) || 8));
    const sql = new Sql();
    const admin = sql.add(adminId);
    const { clause, joins } = this.sessionWhere("s", sql, window, extras, true);
    const rows = await this.dataSource.query(
      `
      SELECT
        COALESCE(cu.name, 'Unknown') AS customer,
        cu."phoneNumber" AS phone,
        COUNT(DISTINCT s.id)::int AS sessions,
        COALESCE(SUM(tok.tokens), 0)::int AS tokens,
        COALESCE(SUM(pay.cost), 0) AS cost
      FROM agent_sessions s
      ${joins}
      LEFT JOIN LATERAL (
        SELECT SUM(t."promptTokens" + t."completionTokens") AS tokens
        FROM agent_turns t WHERE t."sessionId" = s.id
      ) tok ON true
      LEFT JOIN LATERAL (
        SELECT SUM(c."payableAmount"::numeric) AS cost
        FROM billing_charges c
        JOIN agent_media_usages mu ON mu."chargeId" = c.id
        WHERE mu."conversationId" = s."conversationId"
          AND c.service IN ('${BillingServiceKey.AI_DECISION}', '${BillingServiceKey.AI_MEDIA}')
      ) pay ON true
      WHERE s."adminId" = ${admin} ${clause}
      GROUP BY cu.name, cu."phoneNumber"
      ORDER BY COALESCE(SUM(pay.cost), 0) DESC, COALESCE(SUM(tok.tokens), 0) DESC
      LIMIT ${sql.add(limit)}
      `,
      sql.params,
    );
    return {
      currency: "USD",
      records: rows.map((r) => ({
        customer: r.customer,
        phone: r.phone,
        sessions: Number(r.sessions),
        tokens: Number(r.tokens),
        cost: this.usd(r.cost),
      })),
    };
  }

  async filters(user: any) {
    const adminId = this.requireTenant(user);
    const [agents, models] = await Promise.all([
      this.dataSource.query(
        `SELECT DISTINCT a.id, a.name
         FROM agents a
         JOIN agent_sessions s ON s."agentId" = a.id
         WHERE a."adminId" = $1
         ORDER BY a.name`,
        [adminId],
      ),
      this.dataSource.query(
        `SELECT DISTINCT u."modelCode" AS model
         FROM ai_usages u
         WHERE u."adminId" = $1 AND u."modelCode" IS NOT NULL AND u."modelCode" <> ''
         ORDER BY 1`,
        [adminId],
      ),
    ]);
    const labels = await this.modelLabels(models.map((m) => m.model));
    return {
      agents,
      models: models.map((m) => ({
        id: m.model,
        label: labels.get(m.model) || m.model,
      })),
      mediaTypes: [...MEDIA_KINDS],
      statuses: ["completed", "failed", "processing"],
      sources: [...USAGE_SOURCES],
      billedBy: [...BILLED_BY],
    };
  }

  private async kpiSlice(
    adminId: string,
    window: ResolvedWindow,
    extras: SharedFilters,
  ) {
    const sessSql = new Sql();
    const sessAdmin = sessSql.add(adminId);
    const sessions = this.sessionWhere("s", sessSql, window, extras);
    const medSql = new Sql();
    const medAdmin = medSql.add(adminId);
    const media = this.mediaWhere("m", medSql, window, extras);
    const costSql = new Sql();
    const costAdmin = costSql.add(adminId);
    const usage = this.usageWhere("u", costSql, window, extras);
    const [sess, med, cost, tokens] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*)::int AS sessions, COUNT(DISTINCT s."agentId")::int AS agents
         FROM agent_sessions s ${sessions.joins}
         WHERE s."adminId" = ${sessAdmin} ${sessions.clause}`,
        sessSql.params,
      ),
      this.dataSource.query(
        `SELECT COUNT(*)::int AS media FROM agent_media_usages m ${media.joins}
         WHERE m."adminId" = ${medAdmin} AND m.status = 'ok' ${media.clause}`,
        medSql.params,
      ),
      this.dataSource.query(
        `SELECT COALESCE(SUM(u."payableAmount"::numeric), 0) AS cost
         FROM ai_usages u
         ${usage.joins}
         WHERE u."adminId" = ${costAdmin} ${usage.clause}`,
        costSql.params,
      ),
      this.tokenTotals(adminId, window, extras)
    ]);
    return {
      ...tokens,
      sessions: Number(sess[0]?.sessions ?? 0), // count of sessions used in the selected window
      agents: Number(sess[0]?.agents ?? 0), // count of agents used in the selected window
      media: Number(med[0]?.media ?? 0), // count of media usages used in the selected window
      cost: this.usd(cost[0]?.cost ?? 0),//cost for ai_decision and ai_media used in the selected window
    };
  }

  private async tokenTotals(
    adminId: string,
    window: ResolvedWindow,
    extras: SharedFilters,
  ): Promise<TokenTotals> {
    const sql = new Sql();
    const admin = sql.add(adminId);
    const usage = this.usageWhere("u", sql, window, extras);
    const rows = await this.dataSource.query(
      `SELECT COALESCE(SUM(u."inputTokens"), 0)::int AS input,
              COALESCE(SUM(u."outputTokens"), 0)::int AS output
       FROM ai_usages u
       ${usage.joins}
       WHERE u."adminId" = ${admin} ${usage.clause}`,
      sql.params,
    );
    const input = Number(rows[0]?.input ?? 0);
    const output = Number(rows[0]?.output ?? 0);
    return { inputTokens: input, outputTokens: output, tokens: input + output };
  }

  private async tokenBuckets(
    adminId: string,
    window: ResolvedWindow,
    extras: SharedFilters,
    granularity: "day" | "month",
  ) {
    const sql = new Sql();
    const admin = sql.add(adminId);
    const trunc = granularity === "day" ? "day" : "month";
    const keyFmt = granularity === "day" ? "YYYY-MM-DD" : "YYYY-MM";
    const usage = this.usageWhere("u", sql, window, extras);
    return this.dataSource.query(
      `
      SELECT to_char(date_trunc('${trunc}', u."createdAt"), '${keyFmt}') AS key,
             COALESCE(SUM(u."inputTokens"), 0)::int AS input,
             COALESCE(SUM(u."outputTokens"), 0)::int AS output
      FROM ai_usages u
      ${usage.joins}
      WHERE u."adminId" = ${admin} ${usage.clause}
      GROUP BY 1
      ORDER BY 1
      `,
      sql.params,
    );
  }

  private async costSlice(
    adminId: string,
    window: ResolvedWindow,
    extras: SharedFilters,
  ) {
    const sql = new Sql();
    const admin = sql.add(adminId);
    const usage = this.usageWhere("u", sql, window, extras);
    const [totals, lines] = await Promise.all([
      this.dataSource.query(
        `SELECT
           COALESCE(SUM(u."payableAmount"::numeric), 0) AS paid,
           COALESCE(SUM(u."grossAmount"::numeric), 0) AS gross,
           COALESCE(SUM(u."grossAmount"::numeric), 0) AS estimated
         FROM ai_usages u
         ${usage.joins}
         WHERE u."adminId" = ${admin} ${usage.clause}`,
        sql.params,
      ),
      this.dataSource.query(
        `SELECT line->>'meter' AS meter,
                COALESCE(SUM((line->>'amount')::numeric), 0) AS amount
         FROM ai_usages u
         ${usage.joins}
         JOIN billing_charges c ON c.id = u."chargeId"
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c."chargeLines", '[]'::jsonb)) line
         WHERE u."adminId" = ${admin} ${usage.clause}
         GROUP BY 1`,
        sql.params,
      ),
    ]);
    const lineMap = new Map(lines.map((l) => [l.meter, Number(l.amount)]));
    const paid = Number(totals[0]?.paid ?? 0);
    const gross = Number(totals[0]?.gross ?? 0);
    return {
      paid: this.usd(paid),
      gross: this.usd(gross),
      freeValue: this.usd(gross - paid),
      estimated: this.usd(totals[0]?.estimated ?? 0),
      inputCost: this.usd(lineMap.get("INPUT_TOKENS") ?? 0),
      outputCost: this.usd(lineMap.get("OUTPUT_TOKENS") ?? 0),
      transcriptionCost: this.usd(lineMap.get("AUDIO_SECONDS") ?? 0),
    };
  }

  private liveGrant(
    allowance: BillingAllowanceSettings | null | undefined,
    row: { usedUnits?: string; reservedUnits?: string } | undefined,
    accountCreatedAt: Date | null,
  ) {
    const used = Number(row?.usedUnits ?? 0);
    const reserved = Number(row?.reservedUnits ?? 0);
    if (allowance === null || allowance === undefined) {
      return {
        unlimited: true,
        initial: null,
        used,
        remaining: null,
        expired: 0,
        expiryDate: null,
        usagePercent: 0,
      };
    }
    const initial = Number(allowance.units ?? 0);
    const durationDays = allowance.durationDays ?? null;
    const expiredGrant =
      durationDays != null &&
      (!accountCreatedAt ||
        Date.now() >
          accountCreatedAt.getTime() + durationDays * 24 * 60 * 60 * 1000);
    const expiryDate =
      durationDays != null && accountCreatedAt
        ? format(
            new Date(accountCreatedAt.getTime() + durationDays * 86400000),
            "yyyy-MM-dd",
          )
        : null;
    if (expiredGrant) {
      return {
        unlimited: false,
        initial,
        used,
        remaining: 0,
        expired: Math.max(0, initial - used),
        expiryDate,
        usagePercent: initial ? Math.min(100, Math.round((used / initial) * 100)) : 0,
      };
    }
    const remaining = Math.max(0, initial - used - reserved);
    return {
      unlimited: false,
      initial,
      used,
      remaining,
      expired: 0,
      expiryDate,
      usagePercent: initial ? Math.min(100, Math.round((used / initial) * 100)) : 0,
    };
  }

  private sessionRow(r: any, labels: Map<string, string>) {
    const input = Number(r.input);
    const output = Number(r.output);
    return {
      id: r.id,
      date: new Date(r.date).toISOString(),
      agentId: r.agentId,
      agentName: r.agentName,
      customer: r.customer ?? null,
      phone: r.phone ?? null,
      model: r.model ? labels.get(r.model) || r.model : null,
      input,
      output,
      total: input + output,
      cost: this.usd(r.cost),
      durationSecs: Math.round(Number(r.duration_ms || 0) / 1000),
      media: Number(r.media),
      status: r.status,
    };
  }

  private sharedFilters(query: AiDashboardQuery): SharedFilters {
    const mediaType = query.mediaType?.trim();
    if (mediaType && !MEDIA_KINDS.includes(mediaType as any)) {
      throw new BadRequestException("Invalid mediaType");
    }
    const status = query.status?.trim();
    if (status && !["completed", "failed", "processing"].includes(status)) {
      throw new BadRequestException("Invalid status");
    }
    const source = query.source?.trim();
    if (source && !USAGE_SOURCES.includes(source as AiUsageSource)) {
      throw new BadRequestException("Invalid source");
    }
    const billedBy = query.billedBy?.trim();
    if (billedBy && !BILLED_BY.includes(billedBy as AiUsageBilledBy)) {
      throw new BadRequestException("Invalid billedBy");
    }
    return {
      agentId: query.agentId?.trim() || undefined,
      model: query.model?.trim() || undefined,
      mediaType,
      status,
      search: query.search?.trim() || undefined,
      source,
      billedBy,
    };
  }

  private usageWhere(
    alias: string,
    sql: Sql,
    window: ResolvedWindow,
    extras: SharedFilters,
  ) {
    let clause = this.dateClause(`${alias}."createdAt"`, sql, window);
    let joins = "";
    if (extras.source) {
      clause += ` AND ${alias}.source = ${sql.add(extras.source)}`;
    }
    if (extras.billedBy) {
      clause += ` AND ${alias}."billedBy" = ${sql.add(extras.billedBy)}`;
    }
    if (extras.agentId) {
      clause += ` AND ${alias}."agentId" = ${sql.add(extras.agentId)}`;
    }
    if (extras.model) {
      clause += ` AND ${alias}."modelCode" = ${sql.add(extras.model)}`;
    }
    if (extras.mediaType) {
      joins += ` LEFT JOIN agent_media_usages mu_u ON mu_u.id = ${alias}."mediaUsageId"`;
      clause += ` AND mu_u.kind = ${sql.add(extras.mediaType)}`;
    }
    if (extras.status === "failed") {
      clause += ` AND ${alias}.status = 'failed'`;
    } else if (extras.status === "completed") {
      clause += ` AND ${alias}.status = 'ok'`;
    } else if (extras.status === "processing") {
      clause += " AND FALSE";
    }
    if (extras.search) {
      joins += `
        LEFT JOIN whatsapp_conversations wc_u ON wc_u.id = ${alias}."conversationId"
        LEFT JOIN customers cu_u ON cu_u.id = wc_u."customerId"`;
      const q = sql.add(`%${extras.search}%`);
      clause += ` AND (
        CAST(${alias}."sessionId" AS text) ILIKE ${q}
        OR COALESCE(cu_u.name, '') ILIKE ${q}
        OR COALESCE(cu_u."phoneNumber", '') ILIKE ${q}
      )`;
    }
    return { clause, joins };
  }

  private turnWhere(
    alias: string,
    sql: Sql,
    window: ResolvedWindow,
    extras: SharedFilters,
  ) {
    let clause = this.dateClause(`${alias}."createdAt"`, sql, window);
    let joins = "";
    if (extras.agentId) {
      clause += ` AND ${alias}."agentId" = ${sql.add(extras.agentId)}`;
    }
    if (extras.model) {
      clause += ` AND ${alias}.model = ${sql.add(extras.model)}`;
    }
    clause += this.statusClause(alias, sql, extras.status);
    if (extras.search) {
      joins += `
        LEFT JOIN whatsapp_conversations wc_t ON wc_t.id = ${alias}."conversationId"
        LEFT JOIN customers cu_t ON cu_t.id = wc_t."customerId"`;
      const q = sql.add(`%${extras.search}%`);
      clause += ` AND (
        CAST(${alias}."sessionId" AS text) ILIKE ${q}
        OR COALESCE(cu_t.name, '') ILIKE ${q}
        OR COALESCE(cu_t."phoneNumber", '') ILIKE ${q}
      )`;
    }
    return { clause, joins };
  }

  private mediaWhere(
    alias: string,
    sql: Sql,
    window: ResolvedWindow,
    extras: SharedFilters,
  ) {
    let clause = this.dateClause(`${alias}."createdAt"`, sql, window);
    let joins = "";
    if (extras.agentId) {
      clause += ` AND ${alias}."agentId" = ${sql.add(extras.agentId)}`;
    }
    if (extras.mediaType) {
      clause += ` AND ${alias}.kind = ${sql.add(extras.mediaType)}`;
    }
    if (extras.model) {
      const m = sql.add(extras.model);
      clause += ` AND (
        ${alias}."visionModel" = ${m}
        OR ${alias}."transcribeModel" = ${m}
        OR ${alias}."documentModel" = ${m}
      )`;
    }
    if (extras.status === "failed") {
      clause += ` AND ${alias}.status = 'failed'`;
    } else if (extras.status === "completed") {
      clause += ` AND ${alias}.status = 'ok'`;
    } else if (extras.status === "processing") {
      clause += ` AND FALSE`;
    }
    if (extras.search) {
      joins += `
        LEFT JOIN whatsapp_conversations wc_m ON wc_m.id = ${alias}."conversationId"
        LEFT JOIN customers cu_m ON cu_m.id = wc_m."customerId"`;
      const q = sql.add(`%${extras.search}%`);
      clause += ` AND (
        COALESCE(cu_m.name, '') ILIKE ${q}
        OR COALESCE(cu_m."phoneNumber", '') ILIKE ${q}
      )`;
    }
    return { clause, joins };
  }

  private sessionWhere(
    alias: string,
    sql: Sql,
    window: ResolvedWindow,
    extras: SharedFilters,
    withCustomerJoin = false,
  ) {
    let clause = this.dateClause(`${alias}."startedAt"`, sql, window);
    let joins = withCustomerJoin
      ? `
        LEFT JOIN whatsapp_conversations wc ON wc.id = ${alias}."conversationId"
        LEFT JOIN customers cu ON cu.id = wc."customerId"`
      : "";
    if (extras.agentId) {
      clause += ` AND ${alias}."agentId" = ${sql.add(extras.agentId)}`;
    }
    if (extras.search) {
      if (!withCustomerJoin) {
        joins += `
          LEFT JOIN whatsapp_conversations wc ON wc.id = ${alias}."conversationId"
          LEFT JOIN customers cu ON cu.id = wc."customerId"`;
      }
      const q = sql.add(`%${extras.search}%`);
      clause += ` AND (
        CAST(${alias}.id AS text) ILIKE ${q}
        OR COALESCE(cu.name, '') ILIKE ${q}
        OR COALESCE(cu."phoneNumber", '') ILIKE ${q}
      )`;
    }
    if (extras.status) {
      if (extras.status === "processing") {
        clause += ` AND EXISTS (SELECT 1 FROM agent_turns t WHERE t."sessionId" = ${alias}.id AND t.status = 'running')`;
      } else if (extras.status === "failed") {
        clause += ` AND EXISTS (SELECT 1 FROM agent_turns t WHERE t."sessionId" = ${alias}.id AND t.status = 'failed')
                    AND NOT EXISTS (SELECT 1 FROM agent_turns t WHERE t."sessionId" = ${alias}.id AND t.status = 'running')`;
      } else {
        clause += ` AND NOT EXISTS (SELECT 1 FROM agent_turns t WHERE t."sessionId" = ${alias}.id AND t.status IN ('running','failed'))`;
      }
    }
    if (extras.model) {
      clause += ` AND EXISTS (
        SELECT 1 FROM agent_turns t
        WHERE t."sessionId" = ${alias}.id AND t.model = ${sql.add(extras.model)}
      )`;
    }
    return { clause, joins };
  }

  private statusClause(alias: string, _sql: Sql, status?: string) {
    if (!status) return "";
    if (status === "processing") return ` AND ${alias}.status = 'running'`;
    if (status === "failed") return ` AND ${alias}.status = 'failed'`;
    return ` AND ${alias}.status IN ('${TURN_COMPLETED.join("','")}')`;
  }

  private dateClause(column: string, sql: Sql, window: ResolvedWindow) {
    if (window.start && window.end) {
      return ` AND ${column} BETWEEN ${sql.add(window.start)} AND ${sql.add(window.end)}`;
    }
    if (window.start) return ` AND ${column} >= ${sql.add(window.start)}`;
    if (window.end) return ` AND ${column} <= ${sql.add(window.end)}`;
    return "";
  }

  private resolveWindow(query: AiDashboardQuery): ResolvedWindow {
    const calculated = calculateRange(query.range);
    const start = calculated.start || this.parseDate(query.startDate, "startDate");
    const end = calculated.end || this.parseDate(query.endDate, "endDate");
    if (start && end && end.getTime() < start.getTime()) {
      throw new BadRequestException("endDate must be on or after startDate");
    }
    return { start, end };
  }

  private parseDate(value: string | undefined, field: string): Date | undefined {
    if (!value) return undefined;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException(`Invalid ${field}`);
    }
    return d;
  }

  private granularity(
    query: AiDashboardQuery,
    window: ResolvedWindow,
  ): "day" | "month" {
    if (query.granularity === "day" || query.granularity === "month") {
      return query.granularity;
    }
    if (window.start && window.end) {
      return differenceInDays(window.end, window.start) + 1 <= 62
        ? "day"
        : "month";
    }
    return "month";
  }

  private fillTokenBuckets(
    window: ResolvedWindow,
    granularity: "day" | "month",
    rows: any[],
  ) {
    const map = new Map<string, { input: number; output: number }>(
      rows.map((r) => [
        String(r.key),
        { input: Number(r.input), output: Number(r.output) },
      ]),
    );
    return this.fillKeys(
      window,
      granularity,
      rows.map((r: any) => String(r.key)),
      (key) => {
        const v = map.get(key) || { input: 0, output: 0 };
        return {
          key,
          tokens: v.input + v.output,
          input: v.input,
          output: v.output,
        };
      },
    );
  }

  private fillKeys<T>(
    window: ResolvedWindow,
    granularity: "day" | "month",
    existingKeys: string[],
    factory: (key: string) => T,
  ): T[] {
    if (!window.start || !window.end) {
      return [...new Set(existingKeys)].sort().map(factory);
    }
    const keys: string[] = [];
    let cursor =
      granularity === "day"
        ? startOfDay(window.start)
        : startOfMonth(window.start);
    const last =
      granularity === "day" ? startOfDay(window.end) : startOfMonth(window.end);
    while (cursor.getTime() <= last.getTime()) {
      keys.push(
        granularity === "day"
          ? format(cursor, "yyyy-MM-dd")
          : format(cursor, "yyyy-MM"),
      );
      cursor =
        granularity === "day" ? addDays(cursor, 1) : addMonths(cursor, 1);
    }
    return keys.map(factory);
  }

  private async modelLabels(codes: string[]) {
    const unique = [...new Set(codes.filter(Boolean))];
    const map = new Map<string, string>();
    if (!unique.length) return map;
    const rows = await this.dataSource.query(
      `SELECT "modelCode", name FROM ai_models WHERE "modelCode" = ANY($1)`,
      [unique],
    );
    for (const row of rows) map.set(row.modelCode, row.name);
    return map;
  }

  private async assertAgent(adminId: string, agentId?: string) {
    if (!agentId) return;
    const agent = await this.agentRepo.findOne({ where: { id: agentId, adminId } });
    if (!agent) {
      throw new BadRequestException(this.translations.t("domains.agents.agent_not_found"));
    }
  }

  private requireTenant(user: any) {
    const id = tenantId(user);
    if (!id) throw new BadRequestException(this.translations.t("common.missing_admin_id"));
    return id;
  }

  private wantsCompare(query: AiDashboardQuery) {
    return query.compare === true || query.compare === "true";
  }

  private paging(query: AiDashboardQuery) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 10));
    return { page, limit, offset: (page - 1) * limit };
  }

  private pick(value: string | undefined, allowed: string[], fallback: string) {
    if (value && allowed.includes(value)) return value;
    return fallback;
  }

  private usd(micros: any) {
    return round4(Number(micros || 0) / MICROS);
  }

  private tokenRecord(r: any) {
    return {
      agentId: r.agentId,
      agentName: r.agentName,
      ...this.tokenParts(r),
    };
  }

  private tokenParts(r: any): TokenTotals & { input: number; output: number } {
    const input = Number(r.input);
    const output = Number(r.output);
    return {
      tokens: input + output,
      inputTokens: input,
      outputTokens: output,
      input,
      output,
    };
  }
}

type SharedFilters = {
  agentId?: string;
  model?: string;
  mediaType?: string;
  status?: string;
  search?: string;
  source?: string;
  billedBy?: string;
};

class Sql {
  params: any[] = [];
  add(value: any) {
    this.params.push(value);
    return `$${this.params.length}`;
  }
}

function round4(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

function csv(value: any) {
  const s = value == null ? "" : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
