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
    return denominator > 0
      ? this.round1((numerator / denominator) * 100)
      : 0;
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
      select: ['completionType'],
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
    const [startedResult, completedAdminIds, avgDaysResult, totalAdmins] =
      await Promise.all([
        // --- a) Number of admins who have at least one onboarding event (started) ---
        this.eventRepo
          .createQueryBuilder('e')
          .select('COUNT(DISTINCT e.adminId)', 'count')
          .getRawOne<{ count: string }>(),

        // --- b) Admins who have completed ALL active items ---
        // Returns an array of { adminId: '...' } – we only need the count.
        this.achievementRepo
          .createQueryBuilder('a')
          .where('a.type IN (:...types)', { types: activeTypes })
          .groupBy('a.adminId')
          .having('COUNT(DISTINCT a.type) = :total', { total: totalItems })
          .select('a.adminId', 'adminId')
          .getRawMany<{ adminId: string }>(),

        // --- c) Average days from first event to full completion ---
        // Raw SQL with CTEs – efficient, single aggregation pass.
        this.eventRepo.manager.query(
          `
        WITH completed_admins AS (
          SELECT a.adminId, MAX(a.first_completed_at) as completed_at
          FROM getting_started_achievements a
          WHERE a.type = ANY($1)
          GROUP BY a.adminId
          HAVING COUNT(DISTINCT a.type) = $2
        ),
        started_at AS (
          SELECT e.adminId, MIN(e.created_at) as started_at
          FROM getting_started_events e
          WHERE e.adminId IN (SELECT adminId FROM completed_admins)
          GROUP BY e.adminId
        )
        SELECT AVG(EXTRACT(EPOCH FROM (c.completed_at - s.started_at)) / 86400) as avg_days
        FROM completed_admins c
        JOIN started_at s ON c.adminId = s.adminId
        `,
          [activeTypes, totalItems],
        ),

        // --- d) Total number of admin users ---
        this.userRepo.count({
          where: { role: { name: SystemRole.ADMIN } },
        }),
      ]);

    // 3. Extract & compute final values
    const startedCount = startedResult ? parseInt(startedResult.count, 10) : 0;
    const completedCount = completedAdminIds ? completedAdminIds.length : 0;
    const avgDays = avgDaysResult[0]?.avg_days
      ? this.round1(parseFloat(avgDaysResult[0].avg_days))
      : null;

    const neverStartedCount = Math.max(0, totalAdmins - startedCount);
    const overallCompletionPercentage = this.percent(completedCount, totalAdmins);

    return {
      totalAdmins,
      startedCount,
      completedCount,
      neverStartedCount,
      overallCompletionPercentage,
      averageDaysToComplete: avgDays,
    };
  }
  

  async getItemStats(me: any) {
    this.ensureSuperAdmin(me);

    // 1. Fetch active items (needed for response and to map completionType → item id)
    const items = await this.itemRepo.find({
      where: { isActive: true },
      order: { sortOrder: 'ASC' },
      select: ['id', 'key', 'title', 'completionType'],
    });

    if (items.length === 0) {
      return [];
    }

    const totalAdmins = await this.countAdmins();

    // 2. Run the aggregate query (one single query for all per‑item stats)
    const statsRaw = await this.itemRepo.manager.query(
      `
    WITH item_data AS (
      SELECT id, completion_type
      FROM getting_started_items
      WHERE is_active = true
    ),
    -- completed counts per item (via achievement type)
    completed AS (
      SELECT a.type, COUNT(DISTINCT a.admin_id) AS completed_count
      FROM getting_started_achievements a
      WHERE a.type IN (SELECT completion_type FROM item_data)
      GROUP BY a.type
    ),
    -- started: admins with ITEM_OPENED or STEP_VIEWED
    started AS (
      SELECT item_id, COUNT(DISTINCT admin_id) AS started_count
      FROM getting_started_events
      WHERE type IN ($1, $2)
      GROUP BY item_id
    ),
    -- finished: admins with FINISHED
    finished AS (
      SELECT item_id, COUNT(DISTINCT admin_id) AS finished_count
      FROM getting_started_events
      WHERE type = $3
      GROUP BY item_id
    ),
    -- skipped: admins with SKIPPED
    skipped AS (
      SELECT item_id, COUNT(DISTINCT admin_id) AS skipped_count
      FROM getting_started_events
      WHERE type = $4
      GROUP BY item_id
    ),
    -- first event time per admin per item (ITEM_OPENED or STEP_VIEWED)
    first_event AS (
      SELECT admin_id, item_id, MIN(created_at) AS first_at
      FROM getting_started_events
      WHERE type IN ($1, $2)
      GROUP BY admin_id, item_id
    ),
    -- achievement time per admin per item (via type join)
    achievement_time AS (
      SELECT a.admin_id, i.id AS item_id, a.first_completed_at AS achieved_at
      FROM getting_started_achievements a
      JOIN getting_started_items i ON a.type = i.completion_type
      WHERE i.is_active = true
    ),
    -- average days per item (from first_event to achievement)
    avg_days AS (
      SELECT fe.item_id,
             AVG(EXTRACT(EPOCH FROM (at.achieved_at - fe.first_at)) / 86400) AS avg_days
      FROM first_event fe
      JOIN achievement_time at ON fe.admin_id = at.admin_id AND fe.item_id = at.item_id
      GROUP BY fe.item_id
    ),
    -- abandoned: admins who started but neither finished nor achieved
    abandoned AS (
      SELECT fe.item_id, COUNT(DISTINCT fe.admin_id) AS abandoned_count
      FROM first_event fe
      LEFT JOIN finished f ON fe.admin_id = f.admin_id AND fe.item_id = f.item_id
      LEFT JOIN achievement_time at ON fe.admin_id = at.admin_id AND fe.item_id = at.item_id
      WHERE f.admin_id IS NULL AND at.admin_id IS NULL
      GROUP BY fe.item_id
    )
    SELECT
      i.id,
      i.completion_type,
      COALESCE(c.completed_count, 0) AS completed_count,
      COALESCE(s.started_count, 0) AS started_path_count,
      COALESCE(f.finished_count, 0) AS finished_path_count,
      COALESCE(sk.skipped_count, 0) AS skipped_count,
      COALESCE(a.abandoned_count, 0) AS abandoned_count,
      ad.avg_days AS average_days_to_complete
    FROM item_data i
    LEFT JOIN completed c ON i.completion_type = c.type
    LEFT JOIN started s ON i.id = s.item_id
    LEFT JOIN finished f ON i.id = f.item_id
    LEFT JOIN skipped sk ON i.id = sk.item_id
    LEFT JOIN abandoned a ON i.id = a.item_id
    LEFT JOIN avg_days ad ON i.id = ad.item_id
    ORDER BY i.sort_order
    `,
      [
        GettingStartedEventType.ITEM_OPENED,
        GettingStartedEventType.STEP_VIEWED,
        GettingStartedEventType.FINISHED,
        GettingStartedEventType.SKIPPED,
      ],
    );

    // 3. Build a map from item id to aggregate results
    const statsMap = new Map<string, any>();
    for (const row of statsRaw) {
      statsMap.set(row.id, row);
    }

    // 4. Combine with item details and compute the final response
    return items.map((item) => {
      const stats = statsMap.get(item.id) || {};
      const completedCount = Number(stats.completed_count ?? 0);
      const notCompletedCount = Math.max(0, totalAdmins - completedCount);
      const startedPathCount = Number(stats.started_path_count ?? 0);
      const finishedPathCount = Number(stats.finished_path_count ?? 0);
      const skippedCount = Number(stats.skipped_count ?? 0);
      const abandonedCount = Number(stats.abandoned_count ?? 0);
      const avgDays = stats.average_days_to_complete !== null
        ? this.round1(Number(stats.average_days_to_complete))
        : null;

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
        abandonedCount,
        averageDaysToComplete: avgDays,
      };
    });
  }
  // ---------- Per Checklist Item ----------

  async getStepStats(me: any) {
    this.ensureSuperAdmin(me);

    // 1. Fetch all active items with their steps (ordered)
    const items = await this.itemRepo.find({
      where: { isActive: true },
      order: { sortOrder: 'ASC' },
      relations: { steps: true },
    });

    if (items.length === 0) return [];

    // 2. Build the aggregate query for steps
    const stepStatsRaw = await this.itemRepo.manager.query(
      `
    WITH step_data AS (
      SELECT s.id, s.item_id, s.key, s.title, s.sort_order
      FROM getting_started_steps s
      JOIN getting_started_items i ON s.item_id = i.id
      WHERE i.is_active = true
    ),
    -- total views per step (including duplicates)
    view_counts AS (
      SELECT step_id, COUNT(*) AS total_views
      FROM getting_started_events
      WHERE type = $1 AND step_id IS NOT NULL
      GROUP BY step_id
    ),
    -- unique viewers per step
    unique_viewers AS (
      SELECT step_id, COUNT(DISTINCT admin_id) AS unique_viewers
      FROM getting_started_events
      WHERE type = $1 AND step_id IS NOT NULL
      GROUP BY step_id
    ),
    -- last viewed step per admin per item
    last_viewed AS (
      SELECT DISTINCT ON (admin_id, item_id)
             admin_id, item_id, step_id, created_at
      FROM getting_started_events
      WHERE type = $1 AND step_id IS NOT NULL
      ORDER BY admin_id, item_id, created_at DESC
    ),
    -- admins who finished the item (FINISHED event)
    finished AS (
      SELECT DISTINCT admin_id, item_id
      FROM getting_started_events
      WHERE type = $2
    ),
    -- admins who achieved the item (via achievement)
    achieved AS (
      SELECT a.admin_id, i.id AS item_id
      FROM getting_started_achievements a
      JOIN getting_started_items i ON a.type = i.completion_type
      WHERE i.is_active = true
    ),
    -- drop-off: last viewed step, but not finished and not achieved
    drop_off AS (
      SELECT lv.step_id, COUNT(*) AS drop_off_count
      FROM last_viewed lv
      LEFT JOIN finished f ON lv.admin_id = f.admin_id AND lv.item_id = f.item_id
      LEFT JOIN achieved ach ON lv.admin_id = ach.admin_id AND lv.item_id = ach.item_id
      WHERE f.admin_id IS NULL AND ach.admin_id IS NULL
      GROUP BY lv.step_id
    )
    SELECT
      s.id,
      s.key,
      s.title,
      s.item_id,
      s.sort_order,
      COALESCE(vc.total_views, 0) AS total_views,
      COALESCE(uv.unique_viewers, 0) AS unique_viewers,
      COALESCE(dof.drop_off_count, 0) AS drop_off_count
    FROM step_data s
    LEFT JOIN view_counts vc ON s.id = vc.step_id
    LEFT JOIN unique_viewers uv ON s.id = uv.step_id
    LEFT JOIN drop_off dof ON s.id = dof.step_id
    ORDER BY s.sort_order
    `,
      [
        GettingStartedEventType.STEP_VIEWED,
        GettingStartedEventType.FINISHED,
      ],
    );

    // 3. Build a map: stepId → stats
    const stepStatsMap = new Map<string, any>();
    for (const row of stepStatsRaw) {
      stepStatsMap.set(row.id, row);
    }

    // 4. Build response, adding item info and computed drop‑off percent
    const result = [];
    for (const item of items) {
      const itemSteps = (item.steps ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
      for (const step of itemSteps) {
        const stats = stepStatsMap.get(step.id) || {};
        const totalViews = Number(stats.total_views ?? 0);
        const uniqueViewers = Number(stats.unique_viewers ?? 0);
        const dropOffCount = Number(stats.drop_off_count ?? 0);

        result.push({
          id: step.id,
          key: step.key,
          title: step.title,
          itemId: item.id,
          itemKey: item.key,
          itemTitle: item.title,
          totalViews,
          uniqueViewers,
          dropOffCount,
          dropOffPercent: this.percent(dropOffCount, uniqueViewers),
        });
      }
    }

    return result;
  }
}