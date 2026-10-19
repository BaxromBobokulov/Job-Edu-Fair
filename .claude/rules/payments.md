# Payments rules (Click)

- Click is the only payment provider. No Payme, no generic Telegram Payments API, unless the user explicitly asks to add one later — don't add a second provider "for flexibility."
- Verify every Click webhook's signature (per Click's Prepare/Complete contract) before any code in `payments.service.ts` is allowed to touch `Payment.status`. An unverified webhook body is untrusted input, full stop.
- `merchant_trans_id` sent to Click is always `Payment.id` — never a participant-supplied value, and never reused across two different payments.
- The fee is fixed (50 000 so'm). Don't accept an amount from the client/bot side as if it were variable — validate the Click callback's amount against the expected constant and reject a mismatch instead of trusting it.
- Refunds default to **admin-approved**, not an automatic one-call API refund — confirm with the client whether their Click contract tier actually supports API refunds before building that path. Until confirmed, `requestRefund()` only moves `paid → refund_requested` and notifies an operator; `approveRefund()` is a separate, explicitly admin-triggered call.
- Every refund approval is logged with who approved it and when (`adminId`, timestamp) — never an anonymous status flip.
- QR issuance happens only as a direct side effect of the `paid` transition inside the payment service — never a separately polled "check if paid, then issue QR" job that could issue a QR for a payment that later turns out to have failed verification.
- Enforce the 1200-participant cap before creating a Click invoice, not only before issuing the QR — don't let someone pay for a slot that doesn't exist and then have to be refunded for a cap overrun.
- Never log `CLICK_SECRET_KEY`, the raw webhook body, or any field that could reconstruct the signature — not even in a debug/error log, not even temporarily "to see what Click sent."