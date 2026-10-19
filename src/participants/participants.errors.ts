/** The MAX_PARTICIPANTS cap is reached — rejected inside the insert transaction. */
export class RegistrationClosedError extends Error {
  constructor() {
    super('Registration is closed: participant cap reached');
    this.name = 'RegistrationClosedError';
  }
}

/** This Telegram account already has a Participant row. */
export class AlreadyRegisteredError extends Error {
  constructor() {
    super('This Telegram account is already registered');
    this.name = 'AlreadyRegisteredError';
  }
}

/** A registration field failed validation (scenes validate first; this is the backstop). */
export class InvalidRegistrationError extends Error {
  constructor(field: string) {
    super(`Invalid registration field: ${field}`);
    this.name = 'InvalidRegistrationError';
  }
}
