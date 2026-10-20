# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npm run start:dev       # Nest + bot in watch mode (requires postgres + redis running)
npm run build            # Production build — also the full typecheck (tsc)
npm run lint              # ESLint

npx prisma generate       # Regenerate the Prisma client after any schema.prisma change
npx prisma migrate dev    # Create + apply a migration from schema.prisma — commit the emitted SQL
npx prisma studio          # Inspect the local DB

npm test                   # Jest — payment state machine, QR round-trip, cap check, retention date math
npm run test:e2e           # Supertest against a running Nest app (webhook signature paths included)

docker compose up -d       # postgres + redis for local dev
npm run queue:dashboard     # Bull Board, if configured — inspect the Sheets/QR-decode queues
```

No separate `typecheck` script — `tsc`'s `noEmit` check runs as part of `npm run build`, so a feature isn't done until build passes, not just lint.

## Architecture

NestJS (strict TypeScript), Telegraf via `nestjs-telegraf` for the bot layer, Prisma over PostgreSQL as the only source of truth, BullMQ/Redis for anything that must not block a bot handler, Click Merchant API for payment, `googleapis` for the Sheets mirror. Full project rationale, the one-shot-event framing, and the hard numbers (1200 cap, 3-month retention, Click-only) are in `AGENTS.md` — this section is the concrete file-level map.

**Data layer.** `src/prisma/prisma.service.ts` wraps a single `PrismaClient` as a Nest injectable, connected in `onModuleInit`. `prisma/schema.prisma` is the single schema file — `Participant`, `Payment`, `ScanEvent`, `Company`, `HrUser`. Every application id is `@id @default(uuid())`; the QR token is a **separate signed field** (`Participant.qrToken`), never the raw `id` — the token is what gets encoded into the QR image, so a photo of someone's code can't be used to enumerate other participants by incrementing an id.

**Participant cap.** Enforced with a Postgres-level check, not an application-level count-then-insert: a `BEFORE INSERT` trigger (or a `SELECT ... FOR UPDATE` inside the same transaction that creates the `Payment`) rejects a new `Participant` once the count of **active holds** reaches 1200 — participants whose payment is paid, or pending and under 2 hours old (refund_requested frees the place immediately — there is no transition back to paid) (`src/participants/participant-cap.ts`; registration creates the pending `Payment` in the same transaction). `src/bot/payment-expiry.cron.ts` expires invoices unpaid after 2 hours; a retry re-checks the cap under the same lock. The bot handler catches that rejection and tells the user registration is closed — it does not pre-check-then-insert as two separate statements, which races under concurrent event-day traffic.

**Payment (Click).** `Payment.status` is an enum: `pending → paid → refund_requested → refunded`, plus `pending → expired`. `src/payments/click.controller.ts` is the only place Click webhooks land; every request is verified against `CLICK_SECRET_KEY` (MD5/SHA signature per Click's Prepare/Complete contract) before `src/payments/payments.service.ts` is allowed to touch `Payment.status`. Click's `merchant_trans_id` is `Payment.id` — never a participant-supplied value. QR issuance (`src/qr/qr.service.ts`) is triggered only by the `paid` transition, as a side effect inside the same service call, not polled separately.

**Refunds.** `requestRefund()` moves `paid → refund_requested` and notifies `src/admin/`; the move to `refunded` is a separate, explicitly admin-triggered call (`approveRefund(paymentId, adminId)`), logged with who approved it and when. Treat an automatic API refund call as something to confirm with the client before building — see `rules/payments.md`.

**Bot layer.** `src/bot/scenes/` holds one Telegraf scene per conversational phase (`onboarding.scene.ts`, `track-split.scene.ts`, `payment.scene.ts`, `hr-scanner.scene.ts`). Scenes call into `participants/`, `payments/`, `qr/`, `hr/` services for anything that isn't presentation — a scene file should read as "ask this, show that, call this service," never contain track-assignment logic, Click signature checks, or direct Prisma calls.

**QR + HR scanning.** `src/qr/qr.service.ts` generates (`qrcode`) and decodes (`jsQR` over a `sharp`-decoded buffer from the largest Telegram photo size). Decode resolves `qrToken → Participant` and distinguishes "not a valid token," "token from a stale/different event," and "already checked in" as separate error branches surfaced to HR verbatim — a generic "invalid QR" message is treated as a bug. `src/hr/hr-scanner.service.ts` records each decision as a `ScanEvent` row (`companyId`, `hrUserId`, `decision`, `timestamp`) and enqueues a Sheets write; it never infers `companyId` from anything but the authenticated HR user's own binding.

**Sheets sync.** `src/sheets/sheets.processor.ts` is a BullMQ worker — the only code path in the repo allowed to call the Sheets API. Every write carries a column letter (A–J, contract fixed in `AGENTS.md`) and a row key (`Participant.qrToken` or similar stable lookup); the processor upserts by that key rather than assuming row order. Column J (14/30-day placement) is written only by the admin-facing manual-entry path — the sync processor must never touch it.

**Retention.** `src/retention/retention.cron.ts` runs daily, computed off `EVENT_DATE` (env) + 3 months. On the purge date it deletes PII columns from `Participant`/`Payment` in a transaction and enqueues a Sheets-side archive/clear job through the same queue the sync processor uses — it does not call the Sheets API directly either.

**Env.** Copy `.env.example` → `.env`. `DATABASE_URL`, `REDIS_URL`, `TELEGRAM_BOT_TOKEN`, `CLICK_SERVICE_ID`, `CLICK_MERCHANT_ID`, `CLICK_SECRET_KEY`, `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `EVENT_DATE`, `MAX_PARTICIPANTS=1200`. `src/payments/click.config.ts` and `src/sheets/sheets.config.ts` validate their own env on first use (not at module import) so the bot still boots for local onboarding/QR work without Click or Sheets credentials configured.