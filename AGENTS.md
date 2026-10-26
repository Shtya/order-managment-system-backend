# Backend Agent Instructions

## Project organization

- Backend feature modules live under `src/<module>/` and contain their controllers, services, module definition, and feature-specific helpers.
- Shared TypeORM entities live in the top-level `entities/` directory. Each domain/module has one entity file, such as `entities/cancel-cause.entity.ts`, and that file contains all closely related entities, enums, and relationships for the domain. Extend the existing domain entity file instead of creating scattered entity files inside controllers or services.
- Shared request/response DTOs live in the top-level `dto/` directory. Each domain/module has one DTO file, such as `dto/cancel-cause.dto.ts`, containing the create, update, query, action, and related DTOs for that domain. Reuse that file from the controller and service rather than defining inline DTO classes.
- Keep broadly reusable infrastructure in `common/`. Before creating mail, exception, socket, cache, translation, validation, CRUD, upload, or authorization infrastructure, inspect the existing shared implementation and reuse it.

## DTOs and localized validation

- Use `class-validator` decorators for DTO validation and `class-transformer` for input conversion where needed. Do not accept unvalidated `any` request bodies when a DTO can express the contract.
- Every user-facing validator message must use `i18nValidationMessage` from `nestjs-i18n`. Do not hard-code English or Arabic validation messages in DTO decorators.
- Reuse the generic keys already available in `messages/en/validation.json` and `messages/ar/validation.json`, such as `validation.is_string`, `validation.is_not_empty`, `validation.is_number`, `validation.is_int`, `validation.is_boolean`, `validation.is_array`, `validation.is_object`, `validation.is_uuid`, `validation.is_enum`, `validation.min`, `validation.max`, `validation.min_length`, and `validation.max_length`.
- The validation namespace is already extensive. Add a new validation key only when the required validation meaning is genuinely missing; add it to both locale files with the same key.
- For enum validation, include the allowed values in the translated constraint when the generic enum message requires them.

- Update DTOs must extend their matching create DTO with `PartialType(CreateSomethingDto)` from `@nestjs/mapped-types` so validation and fields remain consistent. Add update-only fields only when genuinely needed.
- Use `@IsOptional()` deliberately for optional create fields. Do not duplicate every create field manually in an update DTO.
- Keep query DTOs, action DTOs, nested DTOs, and domain-specific validation helpers in the same domain DTO file.

## Controller guards and endpoint permissions

- Every authenticated application controller must apply the standard guards at the controller level in this exact order: `JwtAuthGuard`, `PermissionsGuard`, then `SubscriptionGuard`.

- Do not repeat these three guards on every endpoint when the controller-level decorator can protect the whole controller.
- Every protected endpoint must declare its narrowest permission with `@Permissions(...)` next to the route decorator.

- Read, create, update, delete, export, settings, status-change, assignment, and other specialized operations must use the corresponding permission rather than sharing a broad permission merely for convenience.
- Keep permission names consistent across backend endpoints, frontend controls, sidebar entries, table actions, and settings access.
- Controllers or endpoints that are intentionally public, such as authentication callbacks, public campaign/order flows, or provider webhooks, are explicit exceptions. Keep their public status obvious through the project's established public-route/authentication pattern; never omit guards or `@Permissions` accidentally.
- When an operation requires additional ownership, role, tenant, or resource checks, enforce those checks in the service as well. `@Permissions` does not replace tenant-scoped authorization.

### Registering new permissions

- Before inventing a permission, inspect the seeded keys in `src/permissions/permissions.service.ts` and reuse an existing permission when it accurately represents the operation.
- Every genuinely new permission must be added to the `keys` array seeded by `PermissionsService.seed()` in `src/permissions/permissions.service.ts`. Adding only an `@Permissions("...")` decorator is incomplete because the permission will not be available for role assignment.
- Follow the existing domain/action naming convention, for example `domain.read`, `domain.create`, `domain.update`, `domain.delete`, or a specific capability such as `orders.assign`.
- After registering a permission, apply the exact same string to the endpoint and every corresponding frontend visibility control. Avoid near-duplicate singular/plural names and spelling variants.
- Permission registry changes are application data/seed changes handled by `PermissionsService`; do not create a schema migration for them.

## Entity conventions and tenant ownership

- Use TypeORM decorators and define related domain entities together in the domain's file under `entities/`.
- Every new primary entity ID uses `@PrimaryGeneratedColumn("uuid")`. Every tenant entity has indexed UUID `adminId` plus `@ManyToOne(() => User, { onDelete: "CASCADE" })` and `@JoinColumn({ name: "adminId" })`.

- Scope every tenant-owned read, update, delete, uniqueness check, aggregate, export, socket payload lookup, and background operation by `adminId`. Never trust a record ID alone as proof that the current tenant owns the record.
- Add compound indexes beginning with `adminId` for frequent tenant-scoped filters and uniqueness patterns, while retaining the basic `@Index(["adminId"])`.
- Every persistent primary domain entity has `created_at` and `updated_at` using `@CreateDateColumn`/`@UpdateDateColumn({ type: "timestamptz" })`.

- Use explicit database column types, lengths, nullability, defaults, delete behavior, and join-column names. Keep TypeScript optional/null types aligned with the database definition.

## Backend localization

- All backend user-facing text must be localized. Translation files live in `messages/ar` and `messages/en`; every key must exist in both locales with the same structure.
- Each locale contains five JSON namespaces:
  - `auth.json` for authentication and permission-related messages.
  - `common.json` for shared messages and common database errors.
  - `emails.json` for email subjects and bodies.
  - `validation.json` for DTO and reusable validation messages.
  - `domains.json` for module/domain business messages.
- In `domains.json`, give each module its own top-level key and keep its not-found, conflict, action, notification, and other business messages together.
- Inject `TranslationService` for request-context translations and use typed dot-path keys. Throw Nest exceptions with translated messages rather than hard-coded strings.

- `TranslationModule` is global. Do not import it into individual feature modules merely to inject `TranslationService` or `RequestTranslationService`.
- Use `RequestTranslationService.tAsync(key, userId, options)` when text must follow a target user's saved language rather than only the current request language. This is required for persisted or asynchronously delivered user-facing content such as notifications.

## Notifications

- Use the existing `NotificationService` from `src/notifications/notification.service.ts`; do not insert notification rows directly or create another notification implementation.
- `NotificationModule` is global. Inject `NotificationService` directly and do not add `NotificationModule` to a feature module solely for this injection.
- Use a specific `NotificationType`, the target user's ID, localized title and message, and related entity metadata when applicable.
- Translate notifications with `RequestTranslationService.tAsync` and the recipient/admin ID so the persisted notification uses that user's saved language. Pass interpolation values through `args`.

- Add notification title/message keys to both `messages/ar/domains.json` and `messages/en/domains.json` under the relevant module key.
- Create notifications only after the related business mutation succeeds. When the mutation uses a transaction and notification consistency matters, use the existing transaction-aware capabilities rather than producing a notification for rolled-back work.

## Socket events

- All Socket.IO connection handling, rooms, and application event emits belong in `common/app.gateway.ts` through `AppGateway`. Do not call raw Socket.IO servers or construct separate gateways inside feature services for ordinary application events.
- Add a clearly named, typed `AppGateway` emit method for every new event. The gateway method owns the wire event name, target room selection, payload shape, access routing, and timestamp behavior.
- Inject `AppGateway` into the feature service and call its method only after the associated database/business operation succeeds.
- `WebSocketModule` is global. Do not import it into feature modules solely to inject `AppGateway`.
- Preserve the established room model (`user_<id>`, WhatsApp owner/account rooms, and other gateway-owned routing). Tenant-wide events must target the correct admin/tenant room and must never leak data across tenants.
- Coordinate every new backend event with the frontend `SocketContext`: the frontend context must listen to the exact wire event, publish a stable application event name, and remove the listener during cleanup.

## Redis

- Use the ready `RedisService` at `common/redis/RedisService.ts` for application caching, TTLs, existence checks, deletion, locks, and shared transient state. Do not create an ad hoc Redis client in feature modules.
- `RedisModule` is global. Inject `RedisService` directly without importing the module into each feature module.
- Use descriptive, namespaced keys that include the tenant or entity identity where applicable. Always set a justified TTL for cached or lock-like data unless permanence is explicitly required.
- Reuse `set`, `get`, `del`, `exists`, `expire`, `ttl`, `setNx`, and `setNxWithTtl` rather than duplicating serialization, error handling, or lock behavior.
- Invalidate or update related cache entries after mutations. Cache misses and Redis availability must not cause tenant data leakage or silently change authorization behavior.

## Staged and multiple file uploads

- When a create/edit workflow can upload multiple files, upload files separately, one at a time, through the existing `src/orphan-files` module. Do not require the final create/update endpoint to receive every file in one large multipart request.
- Use the product create/update flow in `src/products/products.service.ts` as the reference. The frontend first uploads each file, receives an orphan `{ id, url }`, and later sends the collected orphan IDs in the feature DTO when saving the domain record.
- Use the existing orphan upload endpoints according to file type:
  - `POST /orphan-files` for the established product-image upload flow.
  - `POST /orphan-files/any` for the established general-file upload flow.
- Extend the orphan-files module deliberately when a new domain needs a different storage destination, MIME allowlist, or size limit. Do not create a disconnected temporary-upload table, cleanup cron, or ad hoc upload lifecycle in the feature module.

### Orphan lifecycle

- Every staged upload has a physical file and an `OrphanFileEntity` row scoped by `adminId`. Treat the returned orphan ID—not a client-provided path—as proof of a staged upload.
- Unclaimed orphan rows are cleaned by `OrphanFilesCleanupCronService`. The cleanup runs hourly and removes rows with an expired `expiresAt`, or rows with no explicit expiry that are older than two hours. It deletes the physical file and then the database row.
- A failed or abandoned create/edit operation should leave its orphan row in place. The cleanup job will remove the unused physical file after the expiration window.
- Once a business record successfully adopts a staged file, promote/confirm the orphan by deleting only its orphan tracking row. Removing that row prevents the cleanup job from finding and deleting the now-durable physical file.
- Use `OrphanFilesService.promote(...)` or the established `deleteOrphansByIds(...)` helper to remove claimed orphan rows. Do not delete the physical file when claiming it.
- `deleteOne(...)`, `promote(...)`, and `deleteOrphansByIds(...)` remove tracking rows; physical deletion of abandoned files belongs to the cleanup lifecycle. Permanent domain files are deleted separately only when the owning entity intentionally removes or replaces them.

### Attaching staged files safely

- Import `OrphanFilesModule` into a feature module that injects `OrphanFilesService`; it is exported for reuse but is not a global module.
- Add explicit DTO fields such as `mainImageOrphanId`, `imagesOrphanIds`, or a domain-appropriate `orphanFileIds`. Validate IDs as UUIDs/arrays with localized DTO messages.
- Resolve orphan IDs through `OrphanFilesService.resolveOrphanUrlsOrThrow(manager, adminId, ids)`. Never accept a URL alone as ownership proof and never resolve orphan rows without the current tenant's `adminId`.
- Reject the request if any requested orphan ID is missing, expired/cleaned, or owned by another tenant. Do not partially attach only the IDs that were found.
- Validate the final combined file count, file roles, and domain rules before saving. Existing durable files plus newly resolved orphan files must respect the feature's total limits.
- Save the business entity and promote claimed orphan rows in one TypeORM transaction when practical, resolving with that manager and tenant. Claim IDs only after saving the owner.

- For edit flows, preserve existing durable files unless the request explicitly removes or replaces them. When replacing a durable file, claim the new orphan transactionally, then delete the old physical file only after the database change succeeds or through the established safe cleanup helper.
- If a client needs more time before final submission, use `OrphanFilesService.renew(...)` with a justified expiration instead of bypassing cleanup or creating permanent unowned files.
- Keep upload errors, missing-file errors, ownership errors, type/size validation, and limit errors localized in both backend locales. Never expose server filesystem paths in API responses.

## Email

- Use the existing `MailService` in `common/nodemailer.ts` for application emails. Do not configure new Nodemailer transports inside feature services.
- Add reusable email methods to `MailService` when introducing a new application email. Keep sender construction, transport configuration, HTML shell, RTL/LTR support, and recipient-language resolution centralized there.
- Put every email subject and user-facing body string in both locale `emails.json` files and render them through `TranslationService` with interpolation arguments.
- Determine the target language from the recipient's settings when a user ID is available. Preserve LTR rendering for OTPs, tokens, codes, and other machine-readable values inside RTL emails.
- Never log email bodies, credentials, OTPs, access tokens, unsubscribe tokens, or other sensitive email data.

## Exception handling

- Reuse the centralized filters in `common/GlobalExceptionFilter.ts`. Do not add feature-level catch-all filters or manually recreate the global error response shape.
- Throw appropriate Nest exceptions (`NotFoundException`, `BadRequestException`, `ConflictException`, `ForbiddenException`, and similar) with localized messages for expected business failures.
- Let unexpected and TypeORM query failures reach the global filters so database-code mapping, system error recording, tracing, file cleanup, development diagnostics, and sensitive-data redaction remain consistent.
- Do not expose stack traces, SQL internals, credentials, request secrets, or sensitive payloads in production responses or logs.
- Extend the centralized Postgres error mapping only when a new database error code needs a consistent global response; local business conflicts should be detected and translated before the database throws when practical.

## Tenant isolation

- Resolve the tenant with `tenantId(me)`; never treat a request/body/query/route/upload/queue `adminId` as authorization.
- Every read, count, existence check, update, delete, aggregate, raw SQL statement, subquery, and relation lookup for tenant-owned data must include `adminId`. Scope joined tenant entities too when a join could otherwise cross tenants.
- Ownership checks use both the record ID and `adminId` and return the localized not-found/forbidden result. Validate that referenced category, store, user, warehouse, file, and similar IDs belong to the same tenant before linking them.
- Keep `adminId` in tenant-created rows, unique constraints/indexes where uniqueness is tenant-local, cache keys, queue payloads, billing records, notifications, and socket targeting.
- Super-admin access is an explicit, existing code path only. Do not remove tenant predicates or invent a bypass because a caller has an elevated-looking role.

## Transactions and concurrency

- Use `DataSource.transaction` when one business action changes multiple rows/tables, consumes staged files, adjusts stock/balances, or must not leave partial state. Obtain every repository used inside from the transaction `EntityManager`; do not mix injected repositories with transactional repositories.
- Reusable methods may accept an optional `EntityManager`: use it when supplied, otherwise open one transaction at the outer service boundary. Do not create independent nested transactions.
- Lock rows with `pessimistic_write` (or use an atomic conditional update) before read-modify-write operations that can race, including wallet, allowance, stock, assignment, counters, and state transitions. Lock rows in a consistent order to reduce deadlocks.
- Back concurrency rules with database constraints and idempotency keys. Treat unique-conflict races deliberately; never rely only on a preceding `findOne` check.
- Keep transactions short; do not hold locks across email, sockets, remote APIs, or long computation. Run post-commit work only after success unless it must be atomic.
- On any error, throw so TypeORM rolls back. Never swallow an error and return success from a partially completed transaction.

## List endpoints, filters, sorting, and pagination

- Follow `ProductsService.list` in `src/products/products.service.ts`. Start with `adminId = tenantId(me)`, build a parameterized query, apply tenant scope and base status first, then optional filters and search.
- Normalize query values before use: trim search text, ignore established sentinels such as `"none"`, parse numeric/date ranges safely, and validate IDs/enums. Use `FilterUtil.likeContains` plus parameterized `Brackets` for multi-column `ILIKE` search; never interpolate user input into SQL.
- Sorting must use an allowlist that maps public `sortBy` values to real columns. Fall back to the module's default column and normalize direction strictly to `ASC` or `DESC`; never pass a client column/expression directly to `orderBy`.
- Apply bounded `page` and `limit` values with `skip((page - 1) * limit)` and `take(limit)`, then use `getManyAndCount()`. Add a stable secondary order (normally ID) when the primary sort can tie so pages do not shuffle.
- Return the established shape: `{ records, total_records, current_page, per_page }`. Enrich only the current page, batch enrichment queries, keep them tenant-scoped, and avoid N+1 queries.
- Export endpoints must reuse the same tenant scope, search, filters, and sorting as the list endpoint, changing only the bounded pagination/export strategy.

## Logging and observability

- Use Nest `Logger` with the owning class context; do not add `console.log`. Log actionable lifecycle events and failures with safe identifiers such as `adminId`, entity/job/authorization ID, operation, and provider.
- Use appropriate levels (`debug`, `log`, `warn`, `error`) and include the original error stack for unexpected failures. Never log passwords, tokens, API keys, OTPs, cookies, authorization headers, raw files, full request bodies, or unnecessary personal data.
- Let unexpected failures reach `GlobalExceptionFilter` so tracing and system-error recording stay centralized. Do not swallow errors; if recovery is intentional, log the failure and resulting state clearly.

## API compatibility

- Treat routes, DTO fields, response shapes, enum values, pagination keys, socket events, queue payloads, MCP contracts, and export columns as public contracts. Do not rename/remove/change semantics silently.
- Prefer additive optional changes with safe defaults. For breaking changes, provide an explicit migration/versioning plan and update frontend consumers, MCP schemas, translations, permissions, tests, and documentation together.
- Keep error status/code behavior stable. Never expose entity internals merely because a new field exists; map deliberate response shapes and preserve existing clients when new stored fields are absent.

## Performance and query safety

- Avoid N+1 queries: join intentionally or batch related reads by IDs, and enrich only the current page. Select only required fields for large relations and never run unbounded list/export queries.
- Parameterize every query, including raw SQL. Allowlist sort columns, cap pagination/export limits, validate range filters, and never interpolate client input into SQL identifiers or expressions.
- Add tenant-first indexes for frequent filters and uniqueness patterns. Inspect query plans for new reports, aggregates, large joins, or slow queries; do not trade tenant correctness for speed.
- Parallelize independent bounded reads with `Promise.all`, but limit concurrency for external calls and large batches. Move genuinely long work to the queue infrastructure.

## Excel exports

- Follow `AutomationService.export` for list-query reuse and `ProductsService.exportProducts` for ExcelJS row shape/style. Add a guarded, permitted `GET("export")` endpoint receiving `req.user` and the full query.
- Export the same tenant-scoped, searched, filtered, and sorted dataset as `list`; reuse `list` with a bounded export limit or extract a shared query helper. Never use an unbounded query.
- Map records to a deliberate flat shape; exclude secrets, internal metadata, arbitrary JSON, and entity graphs. Format relations, dates, booleans, enums, money, and missing values for users.
- Localize worksheet name, headers, statuses, and fallback text in both locale domain files. Keep column keys aligned with row keys and give columns intentional widths.
- Use the established bold white header with project-purple `FF6C5CE7`, then return the workbook buffer with XLSX content type and a safe domain `.xlsx` filename.
- Keep exports memory-bounded; use approved batching, streaming, or queued generation for larger datasets.

## Billing and wallet deductions

- Use `src/billing/billing.service.ts` for every metered or billable operation that can deduct money from a tenant wallet. Do not decrement wallet balances directly, create wallet transactions manually, or call `WalletHoldService` from feature code.
- Follow `src/ai/media/media-understanding.service.ts` as the reference integration. Billing is an authorization lifecycle, not a single deduction:
  1. Estimate the operation's maximum usage.
  2. Call `BillingService.authorize(...)` before invoking the paid provider or doing billable work. This reserves the applicable free allowance and wallet amount.
  3. If authorization is denied, stop immediately and return/throw the feature's insufficient-balance result. Do not call the provider.
  4. If the authorization is an idempotent replay and contains a saved result, return that result instead of repeating the paid operation.
  5. After success, call `BillingService.finalize(...)` with the actual measured usage, not the estimate. Finalization calculates the real charge, captures the hold, returns unused reserved value, and commits allowance use.
  6. If the operation fails before the provider has charged, call `BillingService.release(...)` so the wallet hold and reserved allowance are returned.
- Inject the service normally and import `BillingModule` in the consuming feature module. `BillingModule` exports `BillingService` but is not global. Do not redeclare `BillingService` in the consumer's `providers`.

### Billing inputs and idempotency

- Use the typed `BillingServiceKey`, `BillingOperationKey`, and `BillingWalletPool` enums from `entities/billing.entity.ts`; do not pass arbitrary strings.
- Choose the wallet pool deliberately. `BillingWalletPool.AI` uses the AI wallet policy, while omission defaults to the current/main wallet. Follow the product's billing policy rather than assuming a pool.
- The `idempotencyKey` must identify one logical billable request and remain stable across retries. Never generate a new key merely because the same request was retried.
- Include a deterministic `requestHash` in `context` based on the inputs that affect billing or the provider result. Reusing an idempotency key with different request content is a conflict, not a new charge.
- Context should contain useful, non-secret audit metadata such as the feature, localized wallet-note key, related record IDs, and media/operation kind. Do not put credentials, raw files, or sensitive payloads in billing context.
- `estimatedUsage` must be conservative enough to reserve the maximum plausible cost. `finalize().usage` must use trustworthy actual provider usage.
- Use `saveDecisionReplay` when retrying the operation must not repeat paid external work. Save the result after the provider succeeds and before finalization, as the media-understanding reference does.

### Failure settlement and accounting

- Distinguish “provider failed without charging” from “provider charged and then returned/raised an error.” Release only when no billable provider usage occurred.
- If the provider already charged, finalize with the usage carried by the error instead of releasing the authorization. `MediaProviderChargedError` and `settleAfterProviderError` in the media-understanding service are the reference pattern.
- Put settlement in explicit error handling so every successful authorization reaches exactly one terminal path: finalized, released, or handled by the billing expiry/reconciliation process. Log settlement failures with the authorization ID; never silently abandon a hold.
- Finalization is idempotent only for the same actual usage. Do not finalize an authorization again with different usage, and do not attempt to finalize one that feature code already released.
- Store the returned authorization ID, charge ID, payable/captured amount, and actual usage in the feature's usage/audit record when that module has one. Keep business success and billing settlement visibility explicit; follow the reference service's logging and usage-ledger pattern.
- When adding a genuinely new billable service or operation, add its enum values and a `BillingOperationStrategy` under `src/billing/operations`, register that strategy in `billing-operation.registry.ts`, and add the required pricing/allowance settings and localization. Do not emulate billing calculations in the feature service.

## Client settings

- Put every tenant-configurable setting on `ClientSettingsEntity` in `entities/clientSettings.entity.ts`; read it through injected `ClientSettingsService` with `await this.clientSettings.getCachedSettings(adminId)`.

- `ClientSettingsModule` is global. Inject its service directly; do not import the module or redeclare the provider in feature modules.
- Use the owning `adminId`. New fields require typed defaults and DTO/API support and must tolerate absence for existing clients.

## Background jobs and queues

- Slow, retryable, or rate-limited work must use BullMQ under `src/queue`; follow `src/queue/queues/order-sync.queue.ts`.
- Each queue needs both a producer service with typed enqueue methods and a processor/worker using `@Processor(...)`, `WorkerHost`, and `process()`.
- Define queue names, job/handler names, and queue display metadata centrally in `src/queue/common/queue.constants.ts`. Use `QueueNames` and the feature's `*Jobs` constants everywhere; never repeat raw queue or job-name strings.
- Tenant jobs include `adminId`; payloads must be minimal and serializable, preferably IDs. Use deterministic `jobId` values for deduplication and safe retry/backoff/concurrency settings.
- Register the queue, Bull Board metadata, producer, and worker in global `QueueModule`; export the producer, but do not import `QueueModule` in features.
- Workers validate data, log job context, and call idempotent domain methods. Never hide long work in unawaited promises or controllers.

## MCP tools and unit tests

- Before adding, renaming, merging, or changing MCP tools, read `MCP-TOOL-DESIGN.md` and `MCP-TOOL-RULES.md` completely and follow them as the source of truth; `orders.tool.ts` is the canonical implementation.
- Before adding or changing unit tests, read `test-roles.md` completely and follow its contract-focused testing policy.

## Nest module exports

- A Nest feature module must export its service/provider when another module needs to inject it. Follow `ProductsModule`, which declares `ProductsService` in `providers` and `exports`.

```ts
@Module({
  providers: [FeatureService],
  controllers: [FeatureController],
  exports: [FeatureService],
})
export class FeatureModule {}
```

- Export only the providers that form the module's intended public API. The consuming module must import the owning feature module; do not duplicate the provider in the consumer's `providers` array.
- Do not mark a feature module global merely to avoid explicit imports. Reserve global modules for the established cross-cutting infrastructure documented in this file.

## Database migrations

- Migration files live in `src/migrations` and follow the existing timestamp-prefixed TypeORM naming pattern.
- Do not create migrations for entity/schema changes. This project already synchronizes entity schema changes automatically in development and production.
- Create a migration only when existing data must be inserted, updated, normalized, backfilled, merged, or otherwise transformed. `src/migrations/1780000000000-BackfillHandoffForOpenIssues.ts` is the reference for a data-only backfill.
- Keep data migrations deterministic, tenant-safe, idempotent where practical, and narrowly scoped. Use explicit SQL and predicates that avoid changing unrelated rows.
- Implement a safe `down` migration when the data transformation is genuinely reversible. If it is not reversible, leave `down` empty only with that consequence understood; never invent destructive rollback data.
- Do not combine unrelated data corrections in one migration and do not use a migration as a substitute for fixing ongoing application logic.
