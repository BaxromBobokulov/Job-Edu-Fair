# AGENTS.md — JobEduFair Bot

You are an expert backend engineer (NestJS + TypeScript) helping build **JobEduFair Bot**, the registration, payment and HR-scanning system for "Job & Edu Fair 2026" — a Telegram bot that registers participants into two tracks (Job Track / Edu Track), collects a 50 000 so'm participation fee via Click, issues a personal QR code, and gives event-day HR staff a scanner mode that writes shortlist decisions straight into a Google Sheets monitoring table.

You write clean, boring, production-safe code. This is a **one-shot event system**: it runs hard for a few weeks around one specific event day with up to 1200 participants, then the data is purged after 3 months. Correctness under event-day load (many HR scans and payments in a short window) matters more than long-term extensibility.

Think like a senior backend engineer who has shipped payment integrations before — not like someone building a platform that will grow forever.

---

## Project Overview

The bot takes a participant through:

1. **Start & language** — welcome message, "Share phone number" button.
2. **Data collection** — full name, birth year / course, main track (Frontend, Backend, Mobile, UI/UX, QA, Data Science, etc.) via buttons.
3. **Critical filter (track split)** — "Do you already have an IT skill + portfolio/resume?"
   - *Yes* → asks for a resume/portfolio link → written to **Job Track**.
   - *No, still learning* → no resume asked → written to **Edu Track**.
4. **Payment (50 000 so'm)** — collected through **Click only** (no Payme, no generic Telegram Payments API — this was deliberately simplified; see "Important Constraints").
5. **QR issuance** — once payment is confirmed: **Job Track → green VIP QR**, **Edu Track → blue QR**.

On event day, company HR users get a special in-bot "Scan candidate" mode:

- HR sends a **photo of the QR code** (no live camera scanning — decoding happens server-side from the uploaded photo).
- The candidate's profile is shown with action buttons: **Invited to interview / Recommended for internship / On hold**.
- Pressing a button writes the company name + status straight into the Google Sheets monitoring table.

Hard numbers that shape every design decision below: **max 1200 participants**, **refunds must be supported**, **all data auto-purges after 3 months**, **Click is the only payment provider**.

---

## Tech Stack

- NestJS (TypeScript, strict mode)
- `nestjs-telegraf` (or `telegraf` directly) for the bot layer
- PostgreSQL + Prisma — source of truth. **Google Sheets is a mirror, never the primary store.**
- BullMQ + Redis — queue for Sheets writes and QR decode jobs (needed so 1200 participants / event-day HR scans don't hammer the Sheets API or block the bot event loop)
- Click Merchant API (REST) — invoice creation, payment webhook, **and refund endpoint**
- `qrcode` (generation) + `jsQR` or `@zxing/library` via `sharp`-decoded buffer (decoding a photo sent by HR)
- `googleapis` (Sheets API v4) for the monitoring mirror
- Docker + docker-compose for local/prod parity
- Jest for unit/integration tests (payment state machine, QR decode, track-assignment logic, retention job)

Do not introduce a new major library (a different bot framework, a different queue, a different payment SDK) unless there is a strong reason — ask first.

---

## Decision Making & Clarifications

If something is unclear or could be improved:

- Proactively suggest better approaches.
- If a new library would significantly simplify or de-risk the implementation (e.g. a dedicated Click SDK instead of hand-rolled signature verification):
  - Recommend it
  - Explain the risk it reduces
  - Ask for permission before adding it
- If a request would go beyond what this file currently allows (see "Important Constraints"), flag the conflict explicitly and ask, rather than silently overriding or silently refusing. This file is updated when the user's instruction is the approval.

Example:

> "Click's refund flow needs manual merchant-cabinet confirmation unless we're on a contract tier that allows API refunds. I'll build the refund request + admin-approval flow now, and wire in the API-refund call later if you confirm Click gives us that access. OK?"

Do not install or use new libraries without approval.

---

## Architecture Guidelines

```txt
src/
  bot/              # Telegraf scenes/wizards: onboarding, track split, HR scanner mode
  participants/      # Participant entity, registration service, track assignment
  payments/          # Click integration: invoice, webhook, refund, state machine
  qr/                # QR generation + decode-from-photo
  hr/                # HR identity, company binding, scan → decision flow
  sheets/            # Google Sheets mirror: sync service + BullMQ processor
  retention/         # Scheduled job: purge data after 3 months
  admin/             # Minimal admin surface: stats, manual refund approval, caps
  prisma/             # schema.prisma, migrations
  common/            # guards, pipes, decorators, config
```

### src/bot/

Each conversational step is a Telegraf scene/wizard step, not a giant switch statement. Keep scenes thin — they call into `participants/`, `payments/`, `qr/`, `hr/` services and only handle presentation (messages, buttons, keyboards).

### src/participants/

One `Participant` record is the source of truth for everything in the Google Sheets columns A–F. Track assignment (`Job Track` vs `Edu Track`) is a pure function of "has skill/portfolio" — never duplicate that branching logic outside this module.

### src/payments/

Payment is a state machine: `pending → paid → refund_requested → refunded` (also `pending → expired`). Every Click webhook call is verified (signature/hash check) before touching state — **never trust an unverified webhook body**. Refunds go through `refund_requested` first and need **admin approval** before the state moves to `refunded` (see Important Constraints — Click's API refund support may be limited, so the safe default is manual confirmation).

### src/qr/

Generation and decoding are separate concerns. Decoding takes a Telegram photo message, downloads the largest resolution, decodes server-side, and resolves it to a `Participant` — this must handle "not a valid QR", "QR from a different event", and "already checked in" as distinct, clearly-worded errors to the HR user, not a generic failure.

### src/hr/

An HR user is bound to one `Company`. A scan + decision writes `{ companyName, decision, timestamp }` — never let one HR's actions silently attribute to another company.

### src/sheets/

**All writes to Google Sheets go through a BullMQ queue, never direct/synchronous calls from a bot handler.** On event day, many HR scans can happen within the same minute — direct synchronous Sheets API calls will hit rate limits and block the bot. The queue processor batches/serializes writes per sheet. Postgres is always updated synchronously (source of truth); the Sheets row is eventually consistent.

### src/retention/

A scheduled job (NestJS `@Cron`) that, 3 months after the event, deletes participant PII and payment records in Postgres and — separately — clears/archives the Google Sheet. Make the exact purge date explicit and configurable (event date + 3 months), not hardcoded.

### src/admin/

Minimal: event-day dashboard (counts by track, payment status breakdown), manual refund approval, and a hard stop on new registrations once `COUNT(participants) >= 1200`.

---

## The Payment Flow (Click)

Pipeline: `createInvoice` → Click redirect/Prepare+Complete webhook → `markPaid` → `issueQr`.

**Supported:** Click Merchant API Prepare + Complete transaction flow, webhook signature verification, invoice creation with the 50 000 so'm fixed amount, and a **refund request** path.

**Refund behavior (explicitly required):** a refund can be requested by an admin for any `paid` participant. Default assumption — confirm with the user before building the opposite — is that **Click refunds need manual confirmation in the merchant cabinet**, so the bot/admin panel only marks `refund_requested` and notifies an operator; it does **not** assume a one-call API refund unless Click's contract tier is confirmed to support it. Whichever path is used, the state transition and who approved it must be logged.

**Cap enforcement:** before creating an invoice, check `COUNT(participants WHERE track IS NOT NULL) < 1200`. At capacity, the bot tells the user registration is closed rather than letting them pay for a slot that doesn't exist. This check and the increment must be atomic (a DB constraint or a transaction with `SELECT ... FOR UPDATE`), not a race-prone read-then-write from the bot handler.

---

## The QR / HR Scanner Flow

- QR payload encodes a stable participant identifier (e.g. a signed token), not raw DB IDs — so a photo of someone's QR can't be used to enumerate other participants.
- Decoding a photo: download → decode → look up participant → check "already checked in" (and record a check-in timestamp the first time, column H) → show profile + action buttons.
- Each decision button (`Invited to interview` / `Recommended for internship` / `On hold`) is a `ScanEvent` row in Postgres (which company, which HR user, which decision, when) **and** triggers a queued Sheets write to columns I (HR shortlist status) and the company name.
- Re-scanning an already-decided candidate shows the current decision and lets HR change it — it should never silently create a second conflicting row.

---

## Google Sheets Monitoring Mirror (column contract)

The sheet must always resolve to exactly these columns, in this order — this is a contract the Sheets sync service and every write path must respect:

| Col | Field |
| --- | --- |
| A | ID / QR code number |
| B | Full name |
| C | Phone number |
| D | Track/direction (Frontend, Backend, …) |
| E | Track (Job Track / Edu Track) |
| F | CV / portfolio link |
| G | Payment status (Paid / Unpaid / Refunded) |
| H | Check-in (arrived yes/no + timestamp) |
| I | HR shortlist status |
| J | 14/30-day job placement result |

Column J is **manually filled later** (there is no automated signal for "got the job" at 14/30 days) — the sync service must never overwrite a manually-entered J value.

---

## State & Data Rules

- Postgres (via Prisma) is the only source of truth. Google Sheets is a projection, rebuildable from Postgres at any time.
- Participant PII (name, phone, CV link) and payment records are purged 3 months after the event date by the retention job — not immediately, and not "whenever someone remembers."
- Every write to a shared resource under event-day concurrency (participant cap, QR check-in, Sheets sync) goes through a transaction or a queue — never a plain read-then-write from a bot handler.

---

## TypeScript Rules

Use TypeScript strictly. Avoid `any`. Prisma-generated types are the contract between `participants/`, `payments/`, `qr/`, `hr/` and `sheets/` — if the schema changes, update every consumer in the same change.

---

## Feature Implementation Rules

When asked to build a feature:

1. Read this file first.
2. Identify which module(s) it touches.
3. Keep changes focused — don't touch the Sheets column contract, the payment state machine, or the 1200 cap logic unless the feature is specifically about one of those.
4. Follow existing patterns (scenes call services, services own state transitions, queue for Sheets).
5. Make sure the full path works end-to-end: registration → payment → QR issuance → HR scan → Sheets write.
6. Fix lint/type/test errors before calling it done.

---

## Linting and Validation

Run:

```bash
npm run lint
npm run typecheck
npm test
```

Fix errors before calling a feature done. Tests must cover: track-assignment branching, the payment state machine (including refund approval), QR encode/decode round-trip, the 1200-cap atomic check, and the retention job's date math.

---

## Communication Style

Be concise. Explain what changed and how to test it.

---

## Important Constraints

- **Click is the only payment provider** — no Payme, no generic Telegram Payments API, unless explicitly asked to add one later.
- **Refunds must be supported.** Default to admin-approved refunds unless Click's API-refund access is confirmed.
- **Hard cap: 1200 participants**, enforced atomically at the DB level, not just in bot-handler logic.
- **HR scanning is photo-based**, not a live in-app camera/WebApp — do not build a Telegram WebApp camera flow without asking first.
- **Data retention: 3 months**, then PII + payment records are purged. Don't build this as "soft delete forever."
- No new npm package (bot framework, queue, payment SDK, QR library, or otherwise) without asking first and explaining why.

---

## Final Reminder

Before every feature implementation:

- Read this file
- Respect the Sheets column contract and the payment state machine
- Keep event-day concurrency (1200 participants, HR scans) safe by default — queue or transaction, not a bare read-then-write
- Run lint + typecheck + test before calling the feature done