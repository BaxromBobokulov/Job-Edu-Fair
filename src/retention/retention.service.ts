import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EVENT_TIME_ZONE } from '../bot/bot.constants';
import { PrismaService } from '../prisma/prisma.service';
import { SheetsSyncService } from '../sheets/sheets-sync.service';

/** AGENTS.md: PII and payment records are purged EVENT_DATE + 3 months. */
export const RETENTION_MONTHS = 3;

/** A calendar date, as written in EVENT_DATE: `YYYY-MM-DD`. */
export interface CalendarDate {
  year: number;
  month: number; // 1–12
  day: number;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Parses `YYYY-MM-DD`; null for anything else, including impossible dates. */
export function parseEventDate(raw: string | undefined): CalendarDate | null {
  const m = DATE_RE.exec(raw?.trim() ?? '');
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function formatCalendarDate(d: CalendarDate): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`;
}

/**
 * EVENT_DATE + 3 calendar months. A day the target month doesn't have is
 * clamped to its last day (Nov 30 → Feb 28/29), never rolled into the month
 * after.
 */
export function computePurgeDate(eventDate: CalendarDate): CalendarDate {
  const zeroBased = eventDate.month - 1 + RETENTION_MONTHS;
  const year = eventDate.year + Math.floor(zeroBased / 12);
  const month = (zeroBased % 12) + 1;
  return {
    year,
    month,
    day: Math.min(eventDate.day, daysInMonth(year, month)),
  };
}

/** Today's date on the event's clock (Asia/Tashkent), `YYYY-MM-DD`. */
export function eventToday(now: Date): string {
  // sv-SE formats dates as YYYY-MM-DD.
  return now.toLocaleDateString('sv-SE', { timeZone: EVENT_TIME_ZONE });
}

/** Due from 00:00 event time on the purge date onwards. */
export function isPurgeDue(purgeDate: CalendarDate, now: Date): boolean {
  return eventToday(now) >= formatCalendarDate(purgeDate);
}

export type RetentionRunResult =
  /** EVENT_DATE missing or malformed: nothing was touched. */
  | { kind: 'refused'; reason: string }
  | { kind: 'not_due'; purgeDate: string; today: string }
  /** Ran; counts are 0 when everything was already purged. */
  | {
      kind: 'purged';
      purgeDate: string;
      participants: number;
      payments: number;
    };

/**
 * The 3-month retention purge (see .claude/rules/database.md). Rows are kept
 * for aggregate stats (track, direction, payment status, HR decisions);
 * what identifies a person is nulled in one transaction:
 *
 * - Participant: fullName, phone, cvLink, telegramId; piiPurgedAt is set.
 * - Payment: clickTransId (links the row to the payer's Click transaction).
 *   amount, status and the timestamps stay, as do the refund admins' ids
 *   (the refund audit trail of staff, not participant data).
 *
 * Only rows with piiPurgedAt still null are touched, so a re-run is a no-op.
 * The sheet's B, C and F cells are cleared through the sheets-sync queue
 * after commit; column J is never part of it.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly sheets: SheetsSyncService,
  ) {}

  async run(now = new Date()): Promise<RetentionRunResult> {
    const raw = this.config.get<string>('EVENT_DATE');
    const eventDate = parseEventDate(raw);
    if (!eventDate) {
      const reason =
        raw === undefined || raw.trim() === ''
          ? 'EVENT_DATE is not set'
          : 'EVENT_DATE is not a valid YYYY-MM-DD date';
      this.logger.error(
        `RETENTION PURGE REFUSED: ${reason}. No data was purged — set EVENT_DATE (YYYY-MM-DD) so participant PII is deleted at EVENT_DATE + ${RETENTION_MONTHS} months.`,
      );
      return { kind: 'refused', reason };
    }

    const purgeDate = formatCalendarDate(computePurgeDate(eventDate));
    const today = eventToday(now);
    if (!isPurgeDue(computePurgeDate(eventDate), now)) {
      this.logger.log(
        `Retention purge not due: purge date ${purgeDate} (EVENT_DATE ${formatCalendarDate(eventDate)} + ${RETENTION_MONTHS} months), today ${today} (${EVENT_TIME_ZONE}). Nothing purged.`,
      );
      return { kind: 'not_due', purgeDate, today };
    }

    const { ids, payments } = await this.prisma.$transaction(async (tx) => {
      const purged = await tx.participant.updateManyAndReturn({
        where: { piiPurgedAt: null },
        data: {
          fullName: null,
          phone: null,
          cvLink: null,
          telegramId: null,
          piiPurgedAt: now,
        },
        select: { id: true },
      });
      const payment = await tx.payment.updateMany({
        where: {
          clickTransId: { not: null },
          participant: { piiPurgedAt: { not: null } },
        },
        data: { clickTransId: null },
      });
      return { ids: purged.map((p) => p.id), payments: payment.count };
    });

    for (const id of ids) this.sheets.piiPurged(id);
    this.logger.log(
      `Retention purge ran (scheduled job) at ${now.toISOString()}: purge date ${purgeDate}, ${ids.length} participant(s) and ${payments} payment(s) anonymized${ids.length === 0 ? ' — already purged, no-op' : `; ${ids.length} sheet row clear(s) enqueued`}.`,
    );
    return {
      kind: 'purged',
      purgeDate,
      participants: ids.length,
      payments,
    };
  }
}
