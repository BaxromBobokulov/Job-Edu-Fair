import { ConfigService } from '@nestjs/config';
import { PaymentStatus, Prisma } from '@prisma/client';

/** How long an unpaid invoice holds a place before it stops counting (and gets expired). */
export const PAYMENT_HOLD_MS = 2 * 60 * 60 * 1000;

/**
 * Arbitrary constant key for the transaction-scoped advisory lock that
 * serializes "count holds, then take a place" — registration and the
 * invoice retry after expiry both take it.
 */
const PARTICIPANT_CAP_LOCK_KEY = 0x51520001n;

export function readMaxParticipants(config: ConfigService): number {
  const raw = config.get<string | number>('MAX_PARTICIPANTS', 1200);
  const cap = Number(raw);
  if (!Number.isInteger(cap) || cap < 0) {
    throw new Error('MAX_PARTICIPANTS must be a non-negative integer');
  }
  return cap;
}

/** Held until the transaction ends. */
export async function lockCap(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PARTICIPANT_CAP_LOCK_KEY})`;
}

/** A pending invoice created at or before this instant no longer holds a place. */
export function holdCutoff(now: Date): Date {
  return new Date(now.getTime() - PAYMENT_HOLD_MS);
}

/**
 * Participants holding a place: a payment that is `paid`, or `pending` inside
 * the 2-hour window. `refund_requested` frees the place immediately (as do
 * `refunded` and `expired`) — safe because the state machine has no way back
 * from refund_requested to paid (payment-state.ts), so a freed place can't be
 * re-claimed by the refunding participant.
 *
 * Only meaningful as a cap check when run after `lockCap` in the same transaction.
 */
export function countActiveHolds(
  client: Prisma.TransactionClient,
  now: Date,
): Promise<number> {
  return client.participant.count({
    where: {
      track: { not: null },
      payments: {
        some: {
          OR: [
            { status: PaymentStatus.paid },
            {
              status: PaymentStatus.pending,
              createdAt: { gt: holdCutoff(now) },
            },
          ],
        },
      },
    },
  });
}
