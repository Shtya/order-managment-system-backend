import { ForbiddenException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { SystemRole, User } from "entities/user.entity";
import { TranslationService } from "common/translation.service";
import {
  GettingStartedAchievementEntity,
  GettingStartedAchievementType,
  GettingStartedEventEntity,
  GettingStartedEventType,
  GettingStartedItemEntity,
} from "entities/getting-started.entity";

const DAY_MS = 86_400_000;

@Injectable()
export class GettingStartedStatsService {
  constructor(
    @InjectRepository(GettingStartedItemEntity)
    private readonly itemRepo: Repository<GettingStartedItemEntity>,
    @InjectRepository(GettingStartedAchievementEntity)
    private readonly achievementRepo: Repository<GettingStartedAchievementEntity>,
    @InjectRepository(GettingStartedEventEntity)
    private readonly eventRepo: Repository<GettingStartedEventEntity>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly translations: TranslationService,
  ) {}

  private ensureSuperAdmin(me: any) {
    if (!me || me.role?.name !== SystemRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        this.translations.t("domains.getting_started.stats_only_super_admins"),
      );
    }
  }

  private round1(value: number): number {
    return Math.round(value * 10) / 10;
  }

  private percent(numerator: number, denominator: number): number {
    return denominator > 0 ? this.round1((numerator / denominator) * 100) : 0;
  }

  private countAdmins(): Promise<number> {
    return this.userRepo.count({
      where: { role: { name: SystemRole.ADMIN } },
    });
  }

  // ---------- Overview ----------

  async getOverview(me: any) {
    this.ensureSuperAdmin(me);

    // 1. Fetch active items to know the required achievement types.
    const items = await this.itemRepo.find({
      where: { isActive: true },
      select: {
        completionType: true
      },
    });
    const totalItems = items.length;
    const activeTypes = items.map((i) => i.completionType);

    // If no checklist items exist, return zeros early.
    if (totalItems === 0) {
      const totalAdmins = await this.countAdmins();
      return {
        totalAdmins,
        startedCount: 0,
        completedCount: 0,
        neverStartedCount: totalAdmins,
        overallCompletionPercentage: 0,
        averageDaysToComplete: null,
      };
    }

    // 2. Run ALL aggregate queries in parallel – no sequential awaits.
    const [startedResult, completedAdminIds, totalAdmins] = await Promise.all([
      // --- a) Number of admins who have at least one onboarding event (started) ---
      this.eventRepo
        .createQueryBuilder("e")
        .select("COUNT(DISTINCT e.adminId)", "count")
        .getRawOne<{ count: string }>(),

      // --- b) Admins who have completed ALL active items ---
      // Returns an array of { adminId: '...' } – we only need the count.
      this.achievementRepo
        .createQueryBuilder("a")
        .where("a.type::text IN (:...types)", { types: activeTypes })
        .groupBy("a.adminId")
        .having("COUNT(DISTINCT a.type) = :total", { total: totalItems })
        .select("a.adminId", "adminId")
        .getRawMany<{ adminId: string }>(),

      // --- d) Total number of admin users ---
      this.userRepo.count({
        where: { role: { name: SystemRole.ADMIN } },
      }),
    ]);

    // 3. Extract & compute final values
    const startedCount = startedResult ? parseInt(startedResult.count, 10) : 0;
    const completedCount = completedAdminIds ? completedAdminIds.length : 0;

    const neverStartedCount = Math.max(0, totalAdmins - startedCount);
    const overallCompletionPercentage = this.percent(
      completedCount,
      totalAdmins,
    );

    return {
      totalAdmins,
      startedCount,
      completedCount,
      neverStartedCount,
      overallCompletionPercentage,
    };
  }

  async getItemStats(me: any) {
    this.ensureSuperAdmin(me);

    const items = await this.itemRepo.find({
      where: { isActive: true },
      order: { sortOrder: "ASC" },
      select: {
        id: true,
        key: true,
        title: true,
        completionType: true
      },
    });

    if (items.length === 0) return [];

    const totalAdmins = await this.countAdmins();

    const statsRaw = await this.itemRepo.manager.query(
      `
    WITH item_data AS (
      SELECT id, "completionType", "completionType"::text AS completion_type_text
      FROM getting_started_items
      WHERE "isActive" = true
    ),
    completed AS (
      SELECT a.type::text AS type, COUNT(DISTINCT a."adminId") AS completed_count
      FROM getting_started_achievements a
      WHERE a.type::text IN (SELECT completion_type_text FROM item_data)
      GROUP BY a.type::text
    ),
    started AS (
      SELECT "itemId", COUNT(DISTINCT "adminId") AS started_count
      FROM getting_started_events
      WHERE type IN ($1, $2)
      GROUP BY "itemId"
    ),
    finished AS (
      SELECT "itemId", COUNT(DISTINCT "adminId") AS finished_count
      FROM getting_started_events
      WHERE type = $3
      GROUP BY "itemId"
    ),
    finished_pairs AS (
      SELECT DISTINCT "adminId", "itemId"
      FROM getting_started_events
      WHERE type = $3
    ),
    skipped_distinct AS (
      SELECT "itemId", COUNT(DISTINCT "adminId") AS skipped_count
      FROM getting_started_events
      WHERE type = $4
      GROUP BY "itemId"
    ),
    skipped_total AS (
      SELECT "itemId", COUNT(*) AS skip_event_count
      FROM getting_started_events
      WHERE type = $4
      GROUP BY "itemId"
    ),
    skipped_finished AS (
      SELECT s."itemId", COUNT(DISTINCT s."adminId") AS skipped_finished_count
      FROM getting_started_events s
      JOIN finished_pairs fp ON s."adminId" = fp."adminId" AND s."itemId" = fp."itemId"
      WHERE s.type = $4
      GROUP BY s."itemId"
    ),
    first_event AS (
      SELECT "adminId", "itemId", MIN(created_at) AS first_at
      FROM getting_started_events
      WHERE type IN ($1, $2)
      GROUP BY "adminId", "itemId"
    ),
    achievement_time AS (
      SELECT a."adminId", i.id AS "itemId", a.first_completed_at AS achieved_at
      FROM getting_started_achievements a
      JOIN getting_started_items i ON a.type::text = i."completionType"::text
      WHERE i."isActive" = true
    ),
    abandoned AS (
      SELECT fe."itemId", COUNT(DISTINCT fe."adminId") AS abandoned_count
      FROM first_event fe
      LEFT JOIN finished_pairs fp ON fe."adminId" = fp."adminId" AND fe."itemId" = fp."itemId"
      LEFT JOIN achievement_time at ON fe."adminId" = at."adminId" AND fe."itemId" = at."itemId"
      WHERE fp."adminId" IS NULL AND at."adminId" IS NULL
      GROUP BY fe."itemId"
    )
    SELECT
      i.id,
      i."completionType",
      COALESCE(c.completed_count, 0) AS completed_count,
      COALESCE(s.started_count, 0) AS started_path_count,
      COALESCE(f.finished_count, 0) AS finished_path_count,
      COALESCE(sd.skipped_count, 0) AS skipped_count,
      COALESCE(st.skip_event_count, 0) AS skip_event_count,
      COALESCE(sf.skipped_finished_count, 0) AS skipped_finished_count,
      COALESCE(a.abandoned_count, 0) AS abandoned_count
    FROM item_data i
    LEFT JOIN completed c ON i.completion_type_text = c.type
    LEFT JOIN started s ON i.id = s."itemId"
    LEFT JOIN finished f ON i.id = f."itemId"
    LEFT JOIN skipped_distinct sd ON i.id = sd."itemId"
    LEFT JOIN skipped_total st ON i.id = st."itemId"
    LEFT JOIN skipped_finished sf ON i.id = sf."itemId"
    LEFT JOIN abandoned a ON i.id = a."itemId"
    ORDER BY i.id
    `,
      [
        GettingStartedEventType.ITEM_OPENED,
        GettingStartedEventType.STEP_VIEWED,
        GettingStartedEventType.FINISHED,
        GettingStartedEventType.SKIPPED,
      ],
    );

    const statsMap = new Map<string, any>();
    for (const row of statsRaw) {
      statsMap.set(row.id, row);
    }

    return items.map((item) => {
      const stats = statsMap.get(item.id) || {};
      const completedCount = Number(stats.completed_count ?? 0);
      const notCompletedCount = Math.max(0, totalAdmins - completedCount);
      const startedPathCount = Number(stats.started_path_count ?? 0);
      const finishedPathCount = Number(stats.finished_path_count ?? 0);
      const skippedCount = Number(stats.skipped_count ?? 0);
      const skipEventCount = Number(stats.skip_event_count ?? 0);
      const skippedFinishedCount = Number(stats.skipped_finished_count ?? 0);
      const skippedNotFinishedCount = skippedCount - skippedFinishedCount;
      const abandonedCount = Number(stats.abandoned_count ?? 0);

      return {
        id: item.id,
        key: item.key,
        title: item.title,
        completionType: item.completionType,
        totalAdmins,
        completedCount,
        notCompletedCount,
        completionPercent: this.percent(completedCount, totalAdmins),
        startedPathCount,
        finishedPathCount,
        skippedCount,
        skipEventCount,
        skippedFinishedCount,
        skippedNotFinishedCount,
        abandonedCount,
      };
    });
  }
  // ---------- Per Checklist Item ----------

  async getStepStats(me: any) {
    this.ensureSuperAdmin(me);

    const items = await this.itemRepo.find({
      where: { isActive: true },
      order: { sortOrder: "ASC" },
      relations: { steps: true },
    });

    if (items.length === 0) return [];

    const stepStatsRaw = await this.itemRepo.manager.query(
      `
    WITH step_data AS (
      SELECT s.id, s."itemId", s.key, s.title, s."sortOrder", s.description, s.target
      FROM getting_started_steps s
      JOIN getting_started_items i ON s."itemId" = i.id
      WHERE i."isActive" = true
    ),
    view_counts AS (
      SELECT "itemId", "stepKey", COUNT(*) AS total_views
      FROM getting_started_events
      WHERE type = $1 AND "stepKey" IS NOT NULL
      GROUP BY "itemId", "stepKey"
    ),
    unique_viewers AS (
      SELECT "itemId", "stepKey", COUNT(DISTINCT "adminId") AS unique_viewers
      FROM getting_started_events
      WHERE type = $1 AND "stepKey" IS NOT NULL
      GROUP BY "itemId", "stepKey"
    ),
    last_viewed AS (
      SELECT DISTINCT ON ("adminId", "itemId")
             "adminId", "itemId", "stepKey", created_at
      FROM getting_started_events
      WHERE type = $1 AND "stepKey" IS NOT NULL
      ORDER BY "adminId", "itemId", created_at DESC
    ),
    finished AS (
      SELECT DISTINCT "adminId", "itemId"
      FROM getting_started_events
      WHERE type = $2
    ),
    achieved AS (
      SELECT a."adminId", i.id AS "itemId"
      FROM getting_started_achievements a
      JOIN getting_started_items i ON a.type::text = i."completionType"::text
      WHERE i."isActive" = true
    ),
    drop_off AS (
      SELECT lv."itemId", lv."stepKey", COUNT(*) AS drop_off_count
      FROM last_viewed lv
      LEFT JOIN finished f ON lv."adminId" = f."adminId" AND lv."itemId" = f."itemId"
      LEFT JOIN achieved ach ON lv."adminId" = ach."adminId" AND lv."itemId" = ach."itemId"
      WHERE f."adminId" IS NULL AND ach."adminId" IS NULL
      GROUP BY lv."itemId", lv."stepKey"
    ),
    skipped_total AS (
      SELECT "itemId", "stepKey", COUNT(*) AS skip_event_count
      FROM getting_started_events
      WHERE type = $3 AND "stepKey" IS NOT NULL
      GROUP BY "itemId", "stepKey"
    ),
    skipped_distinct AS (
      SELECT "itemId", "stepKey", COUNT(DISTINCT "adminId") AS skipped_count
      FROM getting_started_events
      WHERE type = $3 AND "stepKey" IS NOT NULL
      GROUP BY "itemId", "stepKey"
    )
    SELECT
      s.id,
      s.key,
      s.title,
      s.description,
      s.target,
      s."itemId",
      s."sortOrder",
      COALESCE(vc.total_views, 0) AS total_views,
      COALESCE(uv.unique_viewers, 0) AS unique_viewers,
      COALESCE(dof.drop_off_count, 0) AS drop_off_count,
      COALESCE(st.skip_event_count, 0) AS skip_event_count,
      COALESCE(sd.skipped_count, 0) AS skipped_count
    FROM step_data s
    LEFT JOIN view_counts vc ON s."itemId" = vc."itemId" AND s.key = vc."stepKey"
    LEFT JOIN unique_viewers uv ON s."itemId" = uv."itemId" AND s.key = uv."stepKey"
    LEFT JOIN drop_off dof ON s."itemId" = dof."itemId" AND s.key = dof."stepKey"
    LEFT JOIN skipped_total st ON s."itemId" = st."itemId" AND s.key = st."stepKey"
    LEFT JOIN skipped_distinct sd ON s."itemId" = sd."itemId" AND s.key = sd."stepKey"
    ORDER BY s."sortOrder"
    `,
      [
        GettingStartedEventType.STEP_VIEWED,
        GettingStartedEventType.FINISHED,
        GettingStartedEventType.SKIPPED,
      ],
    );

    const stepStatsMap = new Map<string, any>();
    for (const row of stepStatsRaw) {
      stepStatsMap.set(row.id, row);
    }

    const result = [];
    for (const item of items) {
      const itemSteps = (item.steps ?? []).sort(
        (a, b) => a.sortOrder - b.sortOrder,
      );
      const stepsWithStats = [];

      for (const step of itemSteps) {
        const stats = stepStatsMap.get(step.id) || {};
        const uniqueViewers = Number(stats.unique_viewers ?? 0);
        const dropOffCount = Number(stats.drop_off_count ?? 0);
        const skipEventCount = Number(stats.skip_event_count ?? 0);
        const skippedCount = Number(stats.skipped_count ?? 0);

        stepsWithStats.push({
          id: step.id,
          key: step.key,
          title: step.title,
          description: step.description,
          target: step.target,
          sortOrder: step.sortOrder,
          totalViews: Number(stats.total_views ?? 0),
          uniqueViewers,
          dropOffCount,
          dropOffPercent: this.percent(dropOffCount, uniqueViewers),
          skipEventCount,
          skippedCount,
          // No percentage for skipped – use item-level for overall rates
        });
      }

      result.push({
        itemId: item.id,
        itemKey: item.key,
        itemTitle: item.title,
        steps: stepsWithStats,
      });
    }

    return result;
  }

  // ==================== Single User Stats ====================

  /**
   * Overview for a single user: how many items completed, started, skipped, etc.
   */
  async getUserOverview(me: any, userId: string) {
    this.ensureSuperAdmin(me);

    const result = await this.itemRepo.manager.query(
      `
        WITH active_items AS (
            SELECT
                i.id,
                i."completionType"
            FROM getting_started_items i
            WHERE i."isActive" = true
        ),

        user_achievements AS (
            SELECT DISTINCT
                a.type::text AS completion_type
            FROM getting_started_achievements a
            WHERE a."adminId" = $1
        ),

        completed AS (
            SELECT COUNT(DISTINCT ai.id) AS count
            FROM active_items ai
            INNER JOIN user_achievements ua
                ON ua.completion_type = ai."completionType"::text
        ),

        started AS (
            SELECT COUNT(DISTINCT e."itemId") AS count
            FROM getting_started_events e
            INNER JOIN active_items ai
                ON ai.id = e."itemId"
            WHERE e."adminId" = $1
              AND e.type IN ($2, $3)
        ),

        finished AS (
            SELECT COUNT(DISTINCT e."itemId") AS count
            FROM getting_started_events e
            INNER JOIN active_items ai
                ON ai.id = e."itemId"
            WHERE e."adminId" = $1
              AND e.type = $4
        ),

        skipped AS (
            SELECT COUNT(DISTINCT e."itemId") AS count
            FROM getting_started_events e
            INNER JOIN active_items ai
                ON ai.id = e."itemId"
            WHERE e."adminId" = $1
              AND e.type = $5
        )

        SELECT
            (SELECT COUNT(*) FROM active_items) AS total_items,
            COALESCE((SELECT count FROM completed), 0) AS completed_count,
            COALESCE((SELECT count FROM started), 0) AS started_count,
            COALESCE((SELECT count FROM finished), 0) AS finished_count,
            COALESCE((SELECT count FROM skipped), 0) AS skipped_count
        `,
      [
        userId,
        GettingStartedEventType.ITEM_OPENED,
        GettingStartedEventType.STEP_VIEWED,
        GettingStartedEventType.FINISHED,
        GettingStartedEventType.SKIPPED,
      ],
    );

    const row = result[0] ?? {};

    const totalItems = Number(row.total_items ?? 0);
    const completedCount = Number(row.completed_count ?? 0);
    const startedCount = Number(row.started_count ?? 0);
    const finishedCount = Number(row.finished_count ?? 0);
    const skippedCount = Number(row.skipped_count ?? 0);

    return {
      userId,

      totalItems,

      completedCount,
      notCompletedCount: Math.max(0, totalItems - completedCount),

      startedCount,
      notStartedCount: Math.max(0, totalItems - startedCount),

      finishedCount,
      skippedCount,

      completionPercent: this.percent(completedCount, totalItems),

      startedPercent: this.percent(startedCount, totalItems),

      finishedPercent: this.percent(finishedCount, totalItems),

      skippedPercent: this.percent(skippedCount, totalItems),
    };
  }

  /**
   * Per‑item stats for a single user.
   */
  async getUserItemStats(me: any, userId: string) {
    this.ensureSuperAdmin(me);

    const rows = await this.itemRepo.manager.query(
      `
        WITH item_data AS (
            SELECT
                i.id,
                i.key,
                i.title,
                i."completionType",
                i."sortOrder",
                COUNT(s.id)::int AS step_count
            FROM getting_started_items i
            LEFT JOIN getting_started_steps s
                ON s."itemId" = i.id
            WHERE i."isActive" = true
            GROUP BY
                i.id,
                i.key,
                i.title,
                i."completionType",
                i."sortOrder"
        ),

        user_events AS (
            SELECT
                e."itemId",

                COUNT(*) FILTER (
                    WHERE e.type = $2
                ) AS view_count,

                COUNT(*) FILTER (
                    WHERE e.type = $3
                ) AS skip_event_count,

                COUNT(DISTINCT e."stepKey") FILTER (
                    WHERE e.type = $2
                      AND e."stepKey" IS NOT NULL
                ) AS unique_steps_viewed,

                MIN(e.created_at) FILTER (
                    WHERE e.type IN ($1, $2)
                ) AS first_started_at,

                MAX(e.created_at) FILTER (
                    WHERE e.type = $2
                ) AS last_viewed_at,

                COUNT(*) FILTER (
                    WHERE e.type = $1
                ) AS item_open_count

            FROM getting_started_events e
            INNER JOIN item_data i
                ON i.id = e."itemId"
            WHERE e."adminId" = $4
            GROUP BY e."itemId"
        ),

        finished AS (
            SELECT DISTINCT
                e."itemId"
            FROM getting_started_events e
            INNER JOIN item_data i
                ON i.id = e."itemId"
            WHERE e."adminId" = $4
              AND e.type = $5
        ),

        skipped AS (
            SELECT DISTINCT
                e."itemId"
            FROM getting_started_events e
            INNER JOIN item_data i
                ON i.id = e."itemId"
            WHERE e."adminId" = $4
              AND e.type = $3
        ),

        achievements AS (
            SELECT DISTINCT
                i.id AS "itemId",
                a.first_completed_at
            FROM getting_started_achievements a
            INNER JOIN item_data i
                ON i."completionType"::text = a.type::text
            WHERE a."adminId" = $4
        ),

       last_step AS (
          SELECT DISTINCT ON (e."itemId")
              e."itemId",
              s.title AS step_title,
              e."stepKey",
              e.created_at
          FROM getting_started_events e
          INNER JOIN item_data i
              ON i.id = e."itemId"
          INNER JOIN getting_started_steps s
              ON s."itemId" = e."itemId"
            AND s.key = e."stepKey"
          WHERE e."adminId" = $4
            AND e.type = $2
            AND e."stepKey" IS NOT NULL
          ORDER BY
              e."itemId",
              e.created_at DESC
      ),

        skipped_finished AS (
            SELECT DISTINCT
                e."itemId"
            FROM getting_started_events e
            INNER JOIN item_data i
                ON i.id = e."itemId"
            INNER JOIN finished f
                ON f."itemId" = e."itemId"
            WHERE e."adminId" = $4
              AND e.type = $3
        )

        SELECT
            i.id,
            i.key,
            i.title,
            i."completionType",
            i."sortOrder",
            i.step_count,

            CASE
                WHEN a."itemId" IS NOT NULL THEN true
                ELSE false
            END AS completed,

            CASE
                WHEN ue.first_started_at IS NOT NULL THEN true
                ELSE false
            END AS started,

            CASE
                WHEN f."itemId" IS NOT NULL THEN true
                ELSE false
            END AS finished,

            CASE
                WHEN s."itemId" IS NOT NULL THEN true
                ELSE false
            END AS skipped,

            CASE
                WHEN sf."itemId" IS NOT NULL THEN true
                ELSE false
            END AS skipped_finished,

            COALESCE(ue.item_open_count, 0) AS open_count,
            COALESCE(ue.view_count, 0) AS step_view_event_count,
            COALESCE(ue.skip_event_count, 0) AS skip_event_count,
            COALESCE(ue.unique_steps_viewed, 0) AS unique_steps_viewed,

            ue.first_started_at,
            ue.last_viewed_at,

            ls."stepKey" AS last_viewed_step_key,
            ls."step_title" AS last_viewed_step_title,

            a.first_completed_at AS completed_at

        FROM item_data i

        LEFT JOIN user_events ue
            ON ue."itemId" = i.id

        LEFT JOIN achievements a
            ON a."itemId" = i.id

        LEFT JOIN finished f
            ON f."itemId" = i.id

        LEFT JOIN skipped s
            ON s."itemId" = i.id

        LEFT JOIN skipped_finished sf
            ON sf."itemId" = i.id

        LEFT JOIN last_step ls
            ON ls."itemId" = i.id

        ORDER BY i."sortOrder"
        `,
      [
        GettingStartedEventType.ITEM_OPENED,
        GettingStartedEventType.STEP_VIEWED,
        GettingStartedEventType.SKIPPED,
        userId,
        GettingStartedEventType.FINISHED,
      ],
    );

    return rows.map((row) => {
      const stepCount = Number(row.step_count ?? 0);
      const uniqueStepsViewed = Number(row.unique_steps_viewed ?? 0);

      return {
        id: row.id,
        key: row.key,
        title: row.title,
        completionType: row.completionType,

        stepCount,

        completed: row.completed,
        started: row.started,
        finished: row.finished,
        skipped: row.skipped,
        skippedFinished: row.skipped_finished,

        openCount: Number(row.open_count ?? 0),
        stepViewEventCount: Number(row.step_view_event_count ?? 0),
        skipEventCount: Number(row.skip_event_count ?? 0),

        uniqueStepsViewed,

        stepsProgressPercent: this.percent(uniqueStepsViewed, stepCount),

        firstStartedAt: row.first_started_at,
        lastViewedAt: row.last_viewed_at,
        lastViewedStepKey: row.last_viewed_step_key,
        last_viewed_step_title: row.last_viewed_step_title,
        completedAt: row.completed_at,
      };
    });
  }

  /**
   * Per‑step stats for a single user.
   */
  async getUserStepStats(me: any, userId: string) {
    this.ensureSuperAdmin(me);

    const rows = await this.itemRepo.manager.query(
      `
        WITH step_data AS (
            SELECT
                s.id,
                s."itemId",
                s.key,
                s.title,
                s."sortOrder",
                i.key AS item_key,
                i.title AS item_title
            FROM getting_started_steps s
            INNER JOIN getting_started_items i
                ON i.id = s."itemId"
            WHERE i."isActive" = true
        ),

        step_events AS (
            SELECT
                e."itemId",
                e."stepKey",

                COUNT(*) FILTER (
                    WHERE e.type = $1
                ) AS view_count,

                COUNT(*) FILTER (
                    WHERE e.type = $2
                ) AS skip_count,

                MIN(e.created_at) FILTER (
                    WHERE e.type = $1
                ) AS first_viewed_at,

                MAX(e.created_at) FILTER (
                    WHERE e.type = $1
                ) AS last_viewed_at

            FROM getting_started_events e

            INNER JOIN step_data s
                ON s."itemId" = e."itemId"
               AND s.key = e."stepKey"

            WHERE e."adminId" = $3
              AND e."stepKey" IS NOT NULL

            GROUP BY
                e."itemId",
                e."stepKey"
        )

        SELECT
            s.id,
            s.key,
            s.title,
            s."sortOrder",
            s."itemId",

            s.item_key,
            s.item_title,

            COALESCE(se.view_count, 0) AS view_count,
            COALESCE(se.skip_count, 0) AS skip_count,

            se.first_viewed_at,
            se.last_viewed_at,

            CASE
                WHEN se.view_count > 0 THEN true
                ELSE false
            END AS viewed,

            CASE
                WHEN se.skip_count > 0 THEN true
                ELSE false
            END AS skipped

        FROM step_data s

        LEFT JOIN step_events se
            ON se."itemId" = s."itemId"
           AND se."stepKey" = s.key

        ORDER BY
            s."itemId",
            s."sortOrder"
        `,
      [
        GettingStartedEventType.STEP_VIEWED,
        GettingStartedEventType.SKIPPED,
        userId,
      ],
    );

    const resultMap = new Map<string, any>();

    for (const row of rows) {
      if (!resultMap.has(row.itemId)) {
        resultMap.set(row.itemId, {
          itemId: row.itemId,
          itemKey: row.item_key,
          itemTitle: row.item_title,
          steps: [],
        });
      }

      resultMap.get(row.itemId).steps.push({
        id: row.id,
        key: row.key,
        title: row.title,
        sortOrder: Number(row.sortOrder),

        viewed: row.viewed,
        skipped: row.skipped,

        viewCount: Number(row.view_count ?? 0),
        skipCount: Number(row.skip_count ?? 0),

        firstViewedAt: row.first_viewed_at,
        lastViewedAt: row.last_viewed_at,
      });
    }

    return Array.from(resultMap.values());
  }
}
