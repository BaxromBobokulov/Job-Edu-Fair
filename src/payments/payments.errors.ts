import type { PaymentStatus } from '@prisma/client';

export class PaymentNotFoundError extends Error {
  constructor() {
    super('Payment not found');
    this.name = 'PaymentNotFoundError';
  }
}

/** A status change the state machine in payment-state.ts doesn't allow. */
export class InvalidPaymentTransitionError extends Error {
  constructor(
    readonly from: PaymentStatus,
    readonly to: PaymentStatus,
  ) {
    super(`Payment cannot move from ${from} to ${to}`);
    this.name = 'InvalidPaymentTransitionError';
  }
}

/** The participant doesn't exist or holds no capped place (no track). */
export class PaymentNotAllowedError extends Error {
  constructor() {
    super('This participant cannot be invoiced');
    this.name = 'PaymentNotAllowedError';
  }
}

/** Lists the missing/invalid env names — never their values. */
export class ClickNotConfiguredError extends Error {
  constructor(invalid: string[]) {
    super(`Click is not configured: ${invalid.join(', ')}`);
    this.name = 'ClickNotConfiguredError';
  }
}
