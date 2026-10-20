import { Injectable, Logger } from '@nestjs/common';
import { LanguageCode, PaymentStatus, ScanDecision } from '@prisma/client';
import type { PhotoSize } from 'telegraf/types';
import { PrismaService } from '../prisma/prisma.service';
import { DecodeResult, QrService, ScannedParticipant } from '../qr/qr.service';
import { SheetsSyncService } from '../sheets/sheets-sync.service';
import {
  DecisionNotAllowedError,
  HrAlreadyBoundError,
  NotHrUserError,
} from './hr.errors';

/** An authenticated HR scanner and the one company it acts for. */
export interface HrIdentity {
  id: string;
  telegramId: bigint;
  companyId: string;
  companyName: string;
  languageCode: LanguageCode;
}

export interface CurrentDecision {
  decision: ScanDecision;
  at: Date;
}

export type ScanResult =
  | {
      kind: 'ok';
      participant: ScannedParticipant;
      /** The first check-in — this scan's, or an earlier one's. */
      checkedInAt: Date;
      /** True if this scan was the participant's check-in. */
      firstCheckIn: boolean;
      /** Latest decision of the scanning HR's own company, if any. */
      currentDecision: CurrentDecision | null;
    }
  | Exclude<DecodeResult, { kind: 'ok' }>
  | { kind: 'download_failed' };

export interface RecordedDecision {
  participantName: string;
  decision: ScanDecision;
  at: Date;
}

/** Trims and collapses whitespace: "  Acme   Corp " → "Acme Corp". */
export function normalizeCompanyName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/**
 * HR scanning: identity, check-in, and decisions. Every action resolves the
 * HR user from its Telegram id and acts for that user's bound company — no
 * method takes a company from the caller, so a decision can't be attributed
 * to a company the HR user doesn't belong to.
 */
@Injectable()
export class HrScannerService {
  private readonly logger = new Logger(HrScannerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly qr: QrService,
    private readonly sheets: SheetsSyncService,
  ) {}

  async findHr(telegramId: number): Promise<HrIdentity | null> {
    const hr = await this.prisma.hrUser.findUnique({
      where: { telegramId: BigInt(telegramId) },
      select: {
        id: true,
        telegramId: true,
        companyId: true,
        languageCode: true,
        company: { select: { name: true } },
      },
    });
    if (!hr) return null;
    const { company, ...rest } = hr;
    return { ...rest, companyName: company.name };
  }

  /** Downloads the largest size of an HR's photo and scans it. */
  async scanPhoto(
    hrTelegramId: number,
    sizes: readonly PhotoSize[],
  ): Promise<ScanResult> {
    const hr = await this.requireHr(hrTelegramId);
    let photo: Buffer;
    try {
      photo = await this.qr.downloadLargestPhoto(sizes);
    } catch (err) {
      this.logger.warn(
        `Photo download failed: ${err instanceof Error ? err.name : 'unknown'}`,
      );
      return { kind: 'download_failed' };
    }
    return this.scanAs(hr, photo);
  }

  /**
   * Decodes a QR photo; on success records the participant's check-in (once)
   * and returns the profile with this company's current decision.
   *
   * @throws NotHrUserError
   */
  async scan(hrTelegramId: number, photo: Buffer): Promise<ScanResult> {
    return this.scanAs(await this.requireHr(hrTelegramId), photo);
  }

  /**
   * Appends a decision by the HR user's own company. Never updates an earlier
   * one: the latest row per company is the current decision.
   *
   * @throws NotHrUserError, DecisionNotAllowedError
   */
  async decide(
    hrTelegramId: number,
    participantId: string,
    decision: ScanDecision,
  ): Promise<RecordedDecision> {
    const hr = await this.requireHr(hrTelegramId);
    const participant = await this.prisma.participant.findUnique({
      where: { id: participantId },
      select: {
        fullName: true,
        piiPurgedAt: true,
        checkedInAt: true,
        payments: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { status: true },
        },
      },
    });
    if (!participant) throw new DecisionNotAllowedError('not_found');
    // A purged participant (retention job) is no longer a valid registration.
    if (
      participant.payments[0]?.status !== PaymentStatus.paid ||
      participant.fullName === null
    ) {
      throw new DecisionNotAllowedError('not_paid');
    }
    if (!participant.checkedInAt) {
      throw new DecisionNotAllowedError('not_scanned');
    }
    const event = await this.prisma.scanEvent.create({
      data: {
        participantId,
        companyId: hr.companyId,
        hrUserId: hr.id,
        decision,
      },
    });
    this.logger.log(
      `Decision ${decision} on participant ${participantId} by HR ${hr.id} (company ${hr.companyId})`,
    );
    this.sheets.decisionRecorded(participantId);
    return {
      participantName: participant.fullName,
      decision,
      at: event.createdAt,
    };
  }

  /**
   * Admin-only: binds a Telegram user to a company as its HR scanner,
   * creating the company on first use (matched case-insensitively). An HR
   * user belongs to exactly one company; re-adding to the same company only
   * updates the language.
   *
   * @throws HrAlreadyBoundError
   */
  async registerHr(input: {
    adminTelegramId: number;
    hrTelegramId: number;
    languageCode: LanguageCode;
    companyName: string;
  }): Promise<HrIdentity> {
    const name = normalizeCompanyName(input.companyName);
    const telegramId = BigInt(input.hrTelegramId);
    await this.prisma.$transaction(async (tx) => {
      const company =
        (await tx.company.findFirst({
          where: { name: { equals: name, mode: 'insensitive' } },
        })) ?? (await tx.company.create({ data: { name } }));
      const existing = await tx.hrUser.findUnique({
        where: { telegramId },
        include: { company: true },
      });
      if (existing && existing.companyId !== company.id) {
        throw new HrAlreadyBoundError(existing.company.name);
      }
      await tx.hrUser.upsert({
        where: { telegramId },
        create: {
          telegramId,
          companyId: company.id,
          languageCode: input.languageCode,
          addedBy: BigInt(input.adminTelegramId),
        },
        update: { languageCode: input.languageCode },
      });
    });
    this.logger.log(
      `HR ${input.hrTelegramId} bound to "${name}" by admin ${input.adminTelegramId}`,
    );
    return this.requireHr(input.hrTelegramId);
  }

  async listHr(): Promise<HrIdentity[]> {
    const rows = await this.prisma.hrUser.findMany({
      orderBy: [{ company: { name: 'asc' } }, { createdAt: 'asc' }],
      select: {
        id: true,
        telegramId: true,
        companyId: true,
        languageCode: true,
        company: { select: { name: true } },
      },
    });
    return rows.map(({ company, ...rest }) => ({
      ...rest,
      companyName: company.name,
    }));
  }

  private async requireHr(telegramId: number): Promise<HrIdentity> {
    const hr = await this.findHr(telegramId);
    if (!hr) throw new NotHrUserError();
    return hr;
  }

  private async scanAs(hr: HrIdentity, photo: Buffer): Promise<ScanResult> {
    const decoded = await this.qr.decodeFromPhoto(photo);
    if (decoded.kind !== 'ok') return decoded;
    const { participant } = decoded;
    const { checkedInAt, firstCheckIn } = await this.checkIn(
      participant.id,
      hr,
    );
    return {
      kind: 'ok',
      participant,
      checkedInAt,
      firstCheckIn,
      currentDecision: await this.currentDecision(participant.id, hr.companyId),
    };
  }

  /**
   * Sets checkedInAt only if it's still null — one conditional UPDATE, so of
   * two simultaneous first scans exactly one wins and neither overwrites.
   */
  private async checkIn(
    participantId: string,
    hr: HrIdentity,
  ): Promise<{ checkedInAt: Date; firstCheckIn: boolean }> {
    const now = new Date();
    const { count } = await this.prisma.participant.updateMany({
      where: { id: participantId, checkedInAt: null },
      data: { checkedInAt: now, checkedInById: hr.id },
    });
    if (count === 1) {
      this.sheets.checkedIn(participantId);
      return { checkedInAt: now, firstCheckIn: true };
    }
    const { checkedInAt } = await this.prisma.participant.findUniqueOrThrow({
      where: { id: participantId },
      select: { checkedInAt: true },
    });
    return { checkedInAt: checkedInAt!, firstCheckIn: false };
  }

  private async currentDecision(
    participantId: string,
    companyId: string,
  ): Promise<CurrentDecision | null> {
    const latest = await this.prisma.scanEvent.findFirst({
      where: { participantId, companyId },
      orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
      select: { decision: true, createdAt: true },
    });
    return latest && { decision: latest.decision, at: latest.createdAt };
  }
}
