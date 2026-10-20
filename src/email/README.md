# Email backend

Gmail OAuth and custom SMTP are supported providers. Campaigns use `EmailCampaignChannel` → `EmailService`; they do not import provider-specific code. Providers implement `EmailProvider` and are registered through `EMAIL_PROVIDERS` in `email.module.ts`.

## Setup

1. Run the normal TypeORM migration workflow against a reviewed development/staging database. The new migration is `1792195200000-EmailFoundation.ts`. It creates the email tables, adds recipient email identity, allows email-only recipients and preserves existing WhatsApp rows. Do not enable email on application instances before the migration is complete.
2. Enable Gmail API in the Google Cloud project used for Google login. On the existing web OAuth client, keep the login callback and add the exact Gmail callback URL below.
3. Put credentials in server configuration, never a frontend bundle or repository note. Rotate any client secret previously stored in plaintext notes before use.
4. Configure the following environment variables.

```dotenv
EMAIL_FEATURE_ENABLED=false
EMAIL_GMAIL_ENABLED=false
EMAIL_SMTP_ENABLED=false
# Optional; these secure submission ports are the default.
EMAIL_SMTP_ALLOWED_PORTS=465,587,2525
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
FRONTEND_URL=https://app.example.com
BACKEND_URL=https://api.example.com
EMAIL_UNSUBSCRIBE_SECRET=replace-with-at-least-32-random-characters
EMAIL_MARKETING_MIN_INTERVAL_HOURS=24
# Existing encryption configuration: exactly 32 UTF-8 bytes.
MASTER_ENCRYPTION_KEY=
```

Include a reverse-proxy/API prefix in `BACKEND_URL` if the deployment uses one. Use `NODE_ENV=development` when testing the OAuth cookie on localhost HTTP; production uses Secure cookies. Localhost may be used for the frontend and OAuth callback, but actual marketing unsubscribe URLs require HTTPS.

Use the existing `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `FRONTEND_URL` and `BACKEND_URL` settings. Keep `${BACKEND_URL}/auth/google/callback` registered for login and also register `${BACKEND_URL}/email/accounts/gmail/callback` for Gmail connection; trailing slashes and any API prefix must match exactly. Generate a long random `EMAIL_UNSUBSCRIBE_SECRET`. Keep the existing `MASTER_ENCRYPTION_KEY`; replacing it prevents decrypting existing integrations. `FRONTEND_URL` is only the frontend origin, with no path. `BACKEND_URL` is the publicly reachable backend base URL used for callbacks and unsubscribe links.

Email HTTP errors and unsubscribe UI use the existing translation service and `domains.email` entries in English/Arabic. Select language with the project's normal `x-lang`, query-language or Accept-Language handling. Stored retry/status reasons remain machine-readable codes.

5. Start with designated Google OAuth test users. External Testing authorizations can expire after seven days. Complete applicable Google verification before a public customer rollout.
6. Set both feature flags to `true` only after configuration and a controlled opt-in pilot. Disabling dispatch preserves work; the application never switches sender/provider automatically.

Keep `EMAIL_UNSUBSCRIBE_SECRET` stable. Changing it requires a token-migration strategy so new and historical unsubscribe links remain valid; do not rotate it as an ordinary client secret. Encryption-key rotation likewise requires migrating existing encrypted credentials.

## Frontend API flow

For a frontend API host that differs from `BACKEND_URL` (for example localhost API calls with an ngrok Google callback), send `browserRedirect: true` in the connect/reconnect body. Navigate to the returned `browserAuthorizationUrl` instead of `authorizationUrl`. This consumes a one-time ticket, sets the browser-binding cookie in a top-level visit on the callback host, then redirects to Google. `callbackUrl` is returned for configuration checks. Handoff URLs are short-lived credentials: never log or share them. The local utility at `http://localhost:3000/integrations/gmail-test.html` uses this flow and the user's existing app login. Its config route is development-only.

All account/content APIs use the existing bearer JWT. Accounts are private to the connecting user inside their tenant. Connecting a mailbox already owned by another user/tenant is rejected.

1. `POST /email/accounts/gmail/connect` with `{ "returnTo": "/integrations/gmail-complete.html", "browserRedirect": true }`. Use `credentials: "include"` with the fetch request so the browser stores the OAuth binding cookie; the configured frontend origin is allowed credentialed CORS. Frontend/backend must be deployed so the browser accepts this first-party/same-site cookie; arbitrary cross-site third-party cookie deployments are not supported in this initial redirect flow.
2. Navigate the browser to response `authorizationUrl`. Do not open the callback using an AJAX request.
3. Google redirects to `GET /email/accounts/gmail/callback`. The backend checks single-use state, browser cookie, PKCE and Google identity before saving encrypted offline credentials.
4. The popup returns to the frontend completion page with `emailConnection=connected&accountId=...` or `emailConnection=cancelled`. That page notifies its same-origin opener and closes; the campaign page then reloads the account list and sending status. No OAuth tokens are exposed to the frontend.
5. `GET /email/accounts` lists safe metadata; select an account ID in the campaign Message step.
6. `POST /email/accounts/:id/reconnect` begins a normal Google connection flow. Choosing the same mailbox refreshes it, choosing a new mailbox creates a connection, and choosing another mailbox already owned by the same user returns that connection. `DELETE /email/accounts/:id` disables the account and attempts grant revocation.

Endpoints:

| Method/path | Purpose |
| --- | --- |
| `GET /email/accounts` | Current user's connections |
| `GET /email/accounts/:id` | Safe account metadata |
| `POST /email/accounts/smtp/test` | Verify custom SMTP settings without storing them |
| `POST /email/accounts/smtp` | Verify and create an encrypted custom SMTP connection |
| `PATCH /email/accounts/:id/smtp` | Verify and update an owned SMTP connection; omitted password is preserved |
| `POST /email/content/validate` | Check supported design and variable syntax |
| `POST /email/content/preview` | Render sample personalized subject/HTML/plain text |
| `POST /email/test-send` | Synchronous real test send to the supplied valid email address |
| `GET /email/messages/:id` | Current user's message outcome |
| `POST /email/consents` | Record consent evidence; requires campaign create/update permission |
| `GET /email/unsubscribe/:token` | Confirmation page; GET never mutates preferences |
| `POST /email/unsubscribe/:token` | Idempotent browser/RFC 8058 unsubscribe; no login needed |

The consent endpoint takes `{ "email": "mona@example.com", "evidence": "Opt-in form submission reference ..." }`. This records evidence supplied by an authorized operator; it does not independently prove consent. A prior unsubscribe cannot be overwritten through an import. Store real provenance and use an explicit separate re-subscription process when that is later implemented.

Preview example (`variables` are sample values only; actual campaign values are resolved server-side):

```json
{
  "subject": "{{customer.name}}, your offer is ready",
  "preheader": "A thank-you from our store",
  "businessIdentity": "Example Store · 12 Example Street, Cairo",
  "document": {
    "schemaVersion": 1,
    "blocks": [
      {
        "type": "text",
        "content": {
          "type": "doc",
          "content": [{ "type": "paragraph", "content": [
            { "type": "text", "text": "Hello {{customer.name}}", "marks": [{ "type": "bold" }] }
          ] }]
        }
      },
      { "type": "button", "label": "View offer", "url": "{{campaign.orderUrl}}" }
    ]
  },
  "variables": {
    "customer.name": "Mona",
    "campaign.orderUrl": "https://shop.example.com/preview"
  }
}
```

Test-send uses the same fields plus `accountId` and `to`. It performs one synchronous provider attempt and returns the durable final outcome; it is never placed in the background email queue. It does not create a marketing subscription or a real-recipient unsubscribe token. Preview HTML must be displayed in an isolated iframe by the frontend.

Text supports paragraphs, headings 1–3, bold, italic, underline, strike, hexadecimal text colors, HTTPS links, lists, blockquotes and line breaks. Text blocks accept structured Tiptap JSON, not arbitrary HTML. Other blocks: HTTPS image with alt text, button, divider, spacer (8–100px). Rendering uses MJML and a plain-text alternative. Remote image URLs are included in email HTML, never fetched by this backend; production media should be hosted on the application's existing media storage with a suitable lifetime.

## Creating an email campaign

A Gmail identity is permanently reserved to the tenant/user that first registered it. Disconnection, revocation, suspension, credential loss and reconnect-required states never permit another tenant or user to claim it. Historical messages and campaigns therefore remain bound to their original owner.

Use the existing campaign API, with:

```json
{
  "channel": "email",
  "name": "Customer appreciation",
  "category": "promotional",
  "audienceType": "manual",
  "manualRecipients": [{ "email": "mona@example.com", "name": "Mona" }],
  "enablePurchasePage": false,
  "email": {
    "accountId": "connected-account-uuid",
    "subject": "Hello {{customer.name}}",
    "businessIdentity": "Example Store · Cairo",
    "document": { "schemaVersion": 1, "blocks": [
      { "type": "text", "content": { "type": "doc", "content": [
        { "type": "paragraph", "content": [{ "type": "text", "text": "Thank you, {{customer.name}}!" }] }
      ] } }
    ] }
  }
}
```

Other existing campaign fields/rules still apply. Email-only contacts work for manual, file, customer filters and segments. Download the email upload template using `GET /campaigns/audience-file-template?channel=email`; email uploads require an `email` column, with optional name/phone.

Consent must exist before audience materialization. `estimatedRecipientsCount` is still a raw candidate estimate. Actual materialization records excluded reason totals in `audienceDiagnostics` and rechecks consent/suppression before every send. A completely ineligible audience fails without sending.

Supported variables: `customer.name`, `customer.number`, `customer.email`, `campaign.orderUrl`, `campaign.orderToken`. Missing name falls back to `there`; missing phone to `-`. Order variables require enabling the purchase page. The existing offer/product validation still applies. Email checkout returns `requiresPhoneNumber` when a shipping phone is missing; frontend must collect `phoneNumber` and submit it to the existing order endpoint.

Start/resume require the sender owner. Email campaigns do not use WhatsApp quick-reply followups. Unknown send outcomes pause the campaign and block resume until reviewed; the generic retry-failed endpoint does not resend email messages. For an intentional new send, create a new reviewed campaign, understanding the duplicate risk.

## Reuse outside campaigns

Inject `EmailService` from `EmailModule`:

```ts
await emailService.send(
  { adminId, actorId },
  {
    accountId,
    to: 'recipient@example.com',
    content: { subject, document, businessIdentity },
    variables,
    purpose: 'transactional',
    idempotencyKey: `order-receipt:${orderId}`,
    source: { type: 'order-receipt', id: orderId },
  },
);
```

Only trusted backend callers can select transactional purpose. Do not expose arbitrary purpose/content forwarding from a public request. For asynchronous non-campaign work, use `enqueue()` with the same request. There is no unrestricted external send endpoint.

## Dispatch and durability

The first implementation deliberately reuses the existing BullMQ campaign send loop. `EmailService.send()` durably records the message then dispatches it inline within that job. Thus scheduling, working hours, pause and cancellation have one owner, and Gmail acceptance can be projected using a guarded campaign-recipient transition.

For other callers, `enqueue()` writes the durable PostgreSQL queue. `EmailQueueWorker` polls non-campaign messages every ten seconds; the message table itself is the outbox, avoiding a database-to-Redis enqueue gap. Campaign messages are never picked up by this second worker. This is simpler than introducing a second asynchronous campaign pipeline/result-event bridge immediately.

PostgreSQL session advisory locks serialize per mailbox and per marketing recipient across instances. The deployment needs session-affine database connections; do not use PgBouncer transaction pooling for this lock scheme. Marketing frequency caps apply across the tenant's sender accounts. Reserve adequate database pool capacity for dispatch workers.

Gmail quota rejection cools down the mailbox and delays work. Revoked authorization requires reconnect. Every dispatch cycle is bounded to five attempts; retryable conditions use exponential backoff with jitter and successful reconnection wakes eligible messages immediately. An interrupted in-flight request, timeout or uncertain server error becomes `unknown`, never automatically resent. Internal idempotency plus a request hash prevents duplicate submissions; Gmail itself does not offer a general exactly-once send guarantee.

`accepted` means Gmail API acceptance, not verified delivery or inbox placement. No delivered/open/reply/bounce telemetry is fabricated. Subscribe/footer/authentication checks do not guarantee avoidance of spam. Inspect actual delivered MIME, DKIM coverage of one-click headers and Workspace SPF/DKIM/DMARC during the real-account pilot.

## Before production

- Validate migration/backfill against a disposable PostgreSQL database and staging data.
- Complete Google consent/verification requirements and test actual Gmail connection, revocation and sending.
- Add production retention/deletion operations for stored message requests and consent evidence; message content is private storage, not log data.
- Verify received authentication and unsubscribe headers across supported senders.
- Build the frontend against these actual endpoints; the existing standalone mockup remains a simulation.

Saved template CRUD, attachments, aliases, raw HTML imports, automatic bounce/reply reading and additional real providers are not included in this initial backend. Campaigns save their full immutable design snapshot directly.
