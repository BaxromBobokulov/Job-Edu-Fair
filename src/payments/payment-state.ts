import { PaymentStatus } from '@prisma/client';
import { InvalidPaymentTransitionError } from './payments.errors';

/**
 * The only allowed Payment.status moves (AGENTS.md):
 * pending → paid → refund_requested → refunded, and pending → expired.
 * Changing this needs AGENTS.md and payment-state.spec.ts updated together.
 */
const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  [PaymentStatus.pending]: [PaymentStatus.paid, PaymentStatus.expired],
  [PaymentStatus.paid]: [PaymentStatus.refund_requested],
  [PaymentStatus.refund_requested]: [PaymentStatus.refunded],
  [PaymentStatus.refunded]: [],
  [PaymentStatus.expired]: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** @throws InvalidPaymentTransitionError */
export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidPaymentTransitionError(from, to);
  }
}
