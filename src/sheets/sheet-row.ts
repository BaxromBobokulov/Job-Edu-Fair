import { PaymentStatus, ScanDecision, Track } from '@prisma/client';
import { EVENT_TIME_ZONE } from '../bot/bot.constants';
import { t } from '../i18n/i18n';

/**
 * The column contract (AGENTS.md), A–I. Column J (14/30-day placement) is
 * filled in by hand and deliberately not in this list: nothing the sync
 * writes can reach it.
 *
 * Participant.qrToken is the admission credential and is never written to
 * the sheet: anyone who can read it could render a working QR. It isn't in
 * ParticipantSnapshot, so no column can carry it.
 */
export const SYNC_COLUMNS = [
  'A', // Participant.id — also the row key. Never the qrToken (see above).
  'B', // Full name
  'C', // Phone
  'D', // Direction (Frontend, Backend, …)
  'E', // Track (Job Track / Edu Track)
  'F', // CV / portfolio link
  'G', // Payment status
  'H', // Check-in
  'I', // HR shortlist status
] as const;
export type SyncColumn = (typeof SYNC_COLUMNS)[number];

/** Everything known at registration; H and I start empty. */
export const REGISTRATION_COLUMNS: readonly SyncColumn[] = [
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
];
export const PAYMENT_STATUS_COLUMN: SyncColumn = 'G';
export const CHECK_IN_COLUMN: SyncColumn = 'H';
export const HR_STATUS_COLUMN: SyncColumn = 'I';
/** Cleared by the retention purge: full name, phone, CV link. */
export const PII_COLUMNS: readonly SyncColumn[] = ['B', 'C', 'F'];

/** A sync job: which participant, which cells. Values are read at run time. */
export interface SheetsSyncJob {
  participantId: string;
  columns: SyncColumn[];
}

/** The Postgres state a row is built from. */
export interface ParticipantSnapshot {
  id: string;
  /** fullName, phone and cvLink are null after the retention purge. */
  fullName: string | null;
  phone: string | null;
  direction: string;
  track: Track | null;
  cvLink: string | null;
  /** Of the current (latest) payment; null if there is none. */
  paymentStatus: PaymentStatus | null;
  checkedInAt: Date | null;
  /** Set once the retention job purged this participant's PII. */
  piiPurgedAt: Date | null;
  /** Each company's latest decision. */
  decisions: Array<{ companyName: string; decision: ScanDecision }>;
}

/** One label per real Payment.status — no display-only states. */
export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending: 'Unpaid',
  paid: 'Paid',
  refund_requested: 'Refund requested',
  refunded: 'Refunded',
  expired: 'Expired',
};

/** "2026-11-15 14:05" in the event's time zone. */
function formatEventTime(at: Date): string {
  return at.toLocaleString('sv-SE', {
    timeZone: EVENT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Cell values A–I for a participant. Written RAW, so `=…` stays text. */
export function sheetRowValues(
  p: ParticipantSnapshot,
): Record<SyncColumn, string> {
  return {
    A: p.id,
    B: p.fullName ?? '',
    C: p.phone ?? '',
    D: p.direction,
    E: p.track ? t(`track.${p.track}`, 'en') : '',
    F: p.cvLink ?? '',
    G: PAYMENT_STATUS_LABELS[p.paymentStatus ?? PaymentStatus.pending],
    H: p.checkedInAt ? `Yes, ${formatEventTime(p.checkedInAt)}` : 'No',
    I: [...p.decisions]
      .sort((a, b) => a.companyName.localeCompare(b.companyName))
      .map((d) => `${d.companyName}: ${t(`hr.decision.${d.decision}`, 'en')}`)
      .join('; '),
  };
}
