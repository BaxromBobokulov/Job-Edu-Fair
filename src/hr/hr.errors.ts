/** The Telegram user isn't a registered HR scanner. */
export class NotHrUserError extends Error {
  constructor() {
    super('Not an HR user');
    this.name = 'NotHrUserError';
  }
}

/** The Telegram user is already an HR scanner for another company. */
export class HrAlreadyBoundError extends Error {
  constructor(readonly companyName: string) {
    super(`HR user is already bound to ${companyName}`);
    this.name = 'HrAlreadyBoundError';
  }
}

/**
 * A decision can't be recorded: the participant is unknown, no longer paid,
 * or was never scanned (checked in).
 */
export class DecisionNotAllowedError extends Error {
  constructor(readonly reason: 'not_found' | 'not_paid' | 'not_scanned') {
    super(`Decision not allowed: ${reason}`);
    this.name = 'DecisionNotAllowedError';
  }
}
