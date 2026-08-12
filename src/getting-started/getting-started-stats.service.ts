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
  ) { }

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
      select: ["completionType"],
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
    const [startedResult, completedAdminIds, totalAdmins] =
      await Promise.all([
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
      select: ["id", "key", "title", "completionType"],
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
      SELECT s.id, s."itemId", s.key, s.title, s."sortOrder"
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
      const itemSteps = (item.steps ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
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

    // Optionally, you can also allow the user themselves to view their own stats.
    // For now, only super admin can see any user; we already have ensureSuperAdmin.

    const totalItems = await this.itemRepo.count({
      where: { isActive: true },
    });

    if (totalItems === 0) {
      return {
        userId,
        totalItems: 0,
        completedCount: 0,
        startedCount: 0,
        skippedCount: 0,
        finishedCount: 0,
        notStartedCount: 0,
      };
    }

    // Get all active item keys (or ids) to check completion.
    const items = await this.itemRepo.find({
      where: { isActive: true },
      select: ["id", "completionType"],
    });

    const itemIds = items.map((i) => i.id);
    const completionTypes = items.map((i) => i.completionType);

    // Completed items: those with an achievement record for any of the completion types
    const completedCount = await this.achievementRepo
      .createQueryBuilder("a")
      .where("a.adminId = :userId", { userId })
      .andWhere("a.type::text IN (:...types)", { types: completionTypes })
      .select("COUNT(DISTINCT a.type)", "count")
      .getRawOne<{ count: string }>()
      .then((res) => (res ? parseInt(res.count, 10) : 0));

    // Started: at least one ITEM_OPENED or STEP_VIEWED event
    const startedCount = await this.eventRepo
      .createQueryBuilder("e")
      .where("e.adminId = :userId", { userId })
      .andWhere("e.type IN (:...types)", {
        types: [
          GettingStartedEventType.ITEM_OPENED,
          GettingStartedEventType.STEP_VIEWED,
        ],
      })
      .select("COUNT(DISTINCT e.itemId)", "count")
      .getRawOne<{ count: string }>()
      .then((res) => (res ? parseInt(res.count, 10) : 0));

    // Finished: has FINISHED event
    const finishedCount = await this.eventRepo
      .createQueryBuilder("e")
      .where("e.adminId = :userId", { userId })
      .andWhere("e.type = :type", { type: GettingStartedEventType.FINISHED })
      .select("COUNT(DISTINCT e.itemId)", "count")
      .getRawOne<{ count: string }>()
      .then((res) => (res ? parseInt(res.count, 10) : 0));

    // Skipped: has SKIPPED event
    const skippedCount = await this.eventRepo
      .createQueryBuilder("e")
      .where("e.adminId = :userId", { userId })
      .andWhere("e.type = :type", { type: GettingStartedEventType.SKIPPED })
      .select("COUNT(DISTINCT e.itemId)", "count")
      .getRawOne<{ count: string }>()
      .then((res) => (res ? parseInt(res.count, 10) : 0));

    const notStartedCount = totalItems - startedCount;

    return {
      userId,
      totalItems,
      completedCount,
      startedCount,
      finishedCount,
      skippedCount,
      notStartedCount,
      // Percentages relative to total items
      completionPercent: this.percent(completedCount, totalItems),
      startedPercent: this.percent(startedCount, totalItems),
    };
  }

  /**
   * Per‑item stats for a single user.
   */
  async getUserItemStats(me: any, userId: string) {
    this.ensureSuperAdmin(me);

    const items = await this.itemRepo.find({
      where: { isActive: true },
      order: { sortOrder: "ASC" },
      select: ["id", "key", "title", "completionType"],
    });

    if (items.length === 0) return [];

    // Build a map of itemId → stats for this user
    const result = [];

    for (const item of items) {
      // Check completion via achievement
      const completed = await this.achievementRepo
        .createQueryBuilder("a")
        .where("a.adminId = :userId", { userId })
        .andWhere("a.type = :type", { type: item.completionType })
        .getExists();

      // Check events for this item
      const [hasStarted, hasFinished, hasSkipped] = await Promise.all([
        this.eventRepo
          .createQueryBuilder("e")
          .where("e.adminId = :userId", { userId })
          .andWhere("e.itemId = :itemId", { itemId: item.id })
          .andWhere("e.type IN (:...types)", {
            types: [
              GettingStartedEventType.ITEM_OPENED,
              GettingStartedEventType.STEP_VIEWED,
            ],
          })
          .getExists(),
        this.eventRepo
          .createQueryBuilder("e")
          .where("e.adminId = :userId", { userId })
          .andWhere("e.itemId = :itemId", { itemId: item.id })
          .andWhere("e.type = :type", { type: GettingStartedEventType.FINISHED })
          .getExists(),
        this.eventRepo
          .createQueryBuilder("e")
          .where("e.adminId = :userId", { userId })
          .andWhere("e.itemId = :itemId", { itemId: item.id })
          .andWhere("e.type = :type", { type: GettingStartedEventType.SKIPPED })
          .getExists(),
      ]);

      // Get last step viewed (if any)
      const lastViewed = await this.eventRepo
        .createQueryBuilder("e")
        .where("e.adminId = :userId", { userId })
        .andWhere("e.itemId = :itemId", { itemId: item.id })
        .andWhere("e.type = :type", { type: GettingStartedEventType.STEP_VIEWED })
        .andWhere("e.stepKey IS NOT NULL")
        .orderBy("e.created_at", "DESC")
        .select(["e.stepKey", "e.created_at"])
        .getOne();

      // Get first opened/viewed date (start)
      const firstEvent = await this.eventRepo
        .createQueryBuilder("e")
        .where("e.adminId = :userId", { userId })
        .andWhere("e.itemId = :itemId", { itemId: item.id })
        .andWhere("e.type IN (:...types)", {
          types: [
            GettingStartedEventType.ITEM_OPENED,
            GettingStartedEventType.STEP_VIEWED,
          ],
        })
        .orderBy("e.created_at", "ASC")
        .select(["e.created_at"])
        .getOne();

      // Get achievement date (if completed)
      const achievement = await this.achievementRepo
        .createQueryBuilder("a")
        .where("a.adminId = :userId", { userId })
        .andWhere("a.type = :type", { type: item.completionType })
        .select(["a.first_completed_at"])
        .getOne();

      result.push({
        id: item.id,
        key: item.key,
        title: item.title,
        completionType: item.completionType,
        completed,
        started: hasStarted,
        finished: hasFinished,
        skipped: hasSkipped,
        firstEventAt: firstEvent?.created_at || null,
        lastViewedStepKey: lastViewed?.stepKey || null,
        lastViewedAt: lastViewed?.created_at || null,
        completedAt: achievement?.first_completed_at || null,
      });
    }

    return result;
  }

  /**
   * Per‑step stats for a single user.
   */
  async getUserStepStats(me: any, userId: string) {
    this.ensureSuperAdmin(me);

    const items = await this.itemRepo.find({
      where: { isActive: true },
      order: { sortOrder: "ASC" },
      relations: { steps: true },
    });

    if (items.length === 0) return [];

    const result = [];

    for (const item of items) {
      const itemSteps = (item.steps ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
      const stepsWithStats = [];

      for (const step of itemSteps) {
        // Count views for this step (distinct events – but for a single user, we can just check existence)
        const hasViewed = await this.eventRepo
          .createQueryBuilder("e")
          .where("e.adminId = :userId", { userId })
          .andWhere("e.itemId = :itemId", { itemId: item.id })
          .andWhere("e.stepKey = :stepKey", { stepKey: step.key })
          .andWhere("e.type = :type", { type: GettingStartedEventType.STEP_VIEWED })
          .getExists();

        // Count total view events (could be multiple times)
        const viewCount = await this.eventRepo
          .createQueryBuilder("e")
          .where("e.adminId = :userId", { userId })
          .andWhere("e.itemId = :itemId", { itemId: item.id })
          .andWhere("e.stepKey = :stepKey", { stepKey: step.key })
          .andWhere("e.type = :type", { type: GettingStartedEventType.STEP_VIEWED })
          .getCount();

        // Check if skipped at this step (event with stepKey)
        const hasSkipped = await this.eventRepo
          .createQueryBuilder("e")
          .where("e.adminId = :userId", { userId })
          .andWhere("e.itemId = :itemId", { itemId: item.id })
          .andWhere("e.stepKey = :stepKey", { stepKey: step.key })
          .andWhere("e.type = :type", { type: GettingStartedEventType.SKIPPED })
          .getExists();

        // Get last view time
        const lastView = await this.eventRepo
          .createQueryBuilder("e")
          .where("e.adminId = :userId", { userId })
          .andWhere("e.itemId = :itemId", { itemId: item.id })
          .andWhere("e.stepKey = :stepKey", { stepKey: step.key })
          .andWhere("e.type = :type", { type: GettingStartedEventType.STEP_VIEWED })
          .orderBy("e.created_at", "DESC")
          .select(["e.created_at"])
          .getOne();

        stepsWithStats.push({
          id: step.id,
          key: step.key,
          title: step.title,
          sortOrder: step.sortOrder,
          hasViewed,
          viewCount,
          hasSkipped,
          lastViewedAt: lastView?.created_at || null,
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
}
