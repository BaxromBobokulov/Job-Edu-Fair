# Security rules

- Never commit `.env` or any real secret value — `CLICK_SERVICE_ID`, `CLICK_SECRET_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `TELEGRAM_BOT_TOKEN` all stay out of version control and out of logs.
- Never print a secret's value in a log line, error message, or stack trace — including "just for debugging locally." If a bug needs the value to diagnose, redact it and log a hash/prefix instead.
- Every Click webhook is signature-verified before it's allowed to change any `Payment` row. Treat the webhook body as hostile input, not as a trusted internal message, even though it only ever "should" come from Click.
- The QR token is a signed/non-guessable value, not a raw sequential id — a participant must not be able to construct another participant's QR by guessing or incrementing.
- An HR user is bound to exactly one company (or an explicit, audited multi-company assignment) — never let a scan action attribute a decision to a company the HR user wasn't actually authenticated as.
- PII (name, phone, CV link) is deleted by the retention job at `EVENT_DATE + 3 months`. Don't add any export, backup, or logging path that keeps a second untracked copy of participant PII past that date.
- Admin actions that matter for audit — refund approval, manual check-in override, retention job runs — are logged with who did it and when, not just that it happened.
- Rate-limit or otherwise guard the bot's registration flow against obvious abuse (e.g. spamming phone-number submissions) — the 1200 cap limits total damage, but a flood can still exhaust the cap with junk entries before real participants register.