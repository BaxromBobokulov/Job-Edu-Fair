# Testing rules

- Run `npm run lint`, `npm run build` (the real typecheck — no separate `typecheck` script) and `npm test` before calling any feature done. A feature with a failing test is not done, even if the happy path works manually.
- The payment state machine needs a test for every transition, including the ones that must be *rejected*: `pending → refunded` directly (must fail), a webhook with a bad signature (must not change status), a webhook replayed twice (must be idempotent, not double-process).
- The 1200-participant cap needs a concurrency test, not just a single-request test — two simultaneous registration attempts at count 1199 must result in exactly one success and one rejection, never two successes.
- QR has a round-trip test: generate a token, encode it, decode a photo of it, resolve it back to the same participant. Add a case for a token from a different/old event and a token that doesn't decode at all.
- The retention job's date math is tested directly (given an `EVENT_DATE`, does it purge exactly at `+3 months`, not a day early/late) rather than only tested by eye against today's date.
- Sheets sync is tested against the processor function with a fake/mock Sheets client, not against the real Google API in CI — never let tests depend on live Sheets quota or credentials.
- A new problem area (a new scanf-like edge case, a new Click response shape, a new HR decision type) gets a test added alongside the fix, not just a manual check that it now works.