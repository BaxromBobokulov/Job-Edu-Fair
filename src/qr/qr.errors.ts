/** The participant doesn't exist, has no track, or their current payment isn't `paid`. */
export class QrNotIssuableError extends Error {
  constructor(participantId: string) {
    super(`No QR for participant ${participantId}: not paid`);
    this.name = 'QrNotIssuableError';
  }
}
