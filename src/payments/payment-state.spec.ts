import { PaymentStatus } from '@prisma/client';
import { assertTransition, canTransition } from './payment-state';
import { InvalidPaymentTransitionError } from './payments.errors';

const ALL = Object.values(PaymentStatus);
const ALLOWED: Array<[PaymentStatus, PaymentStatus]> = [
  ['pending', 'paid'],
  ['pending', 'expired'],
  ['paid', 'refund_requested'],
  ['refund_requested', 'refunded'],
];

describe('payment state machine', () => {
  it.each(ALLOWED)('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  const rejected = ALL.flatMap((from) =>
    ALL.filter((to) => !ALLOWED.some(([f, t]) => f === from && t === to)).map(
      (to) => [from, to] as [PaymentStatus, PaymentStatus],
    ),
  );

  it.each(rejected)('rejects %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(
      InvalidPaymentTransitionError,
    );
  });

  it('explicitly rejects the skip-transitions', () => {
    for (const [from, to] of [
      ['pending', 'refunded'],
      ['pending', 'refund_requested'],
      ['paid', 'refunded'],
      ['expired', 'paid'],
      ['refunded', 'paid'],
    ] as const) {
      expect(canTransition(from, to)).toBe(false);
    }
  });
});
