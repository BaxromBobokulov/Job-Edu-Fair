import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LanguageCode, Participant, Prisma, Track } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PAYMENT_AMOUNT_UZS } from '../payments/payments.constants';
import { PrismaService } from '../prisma/prisma.service';
import { SheetsSyncService } from '../sheets/sheets-sync.service';
import {
  countActiveHolds,
  lockCap,
  readMaxParticipants,
} from './participant-cap';
import {
  AlreadyRegisteredError,
  InvalidRegistrationError,
  RegistrationClosedError,
} from './participants.errors';
import {
  assignTrack,
  parseBirthYearOrCourse,
  parseCvLink,
  parseDirection,
  parseFullName,
  parsePhone,
} from './registration.rules';

export interface RegistrationInput {
  telegramId: number;
  /** Bot language picked as the first registration step. */
  languageCode: string;
  phone: string;
  fullName: string;
  birthYearOrCourse: string;
  direction: string;
  hasSkillAndPortfolio: boolean;
  /** Required when hasSkillAndPortfolio (Job Track), ignored otherwise. */
  cvLink?: string | null;
}

export type RegistrationStatus = 'open' | 'closed' | 'registered';

function isLanguageCode(value: string): value is LanguageCode {
  return (Object.values(LanguageCode) as string[]).includes(value);
}

@Injectable()
export class ParticipantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly sheets: SheetsSyncService,
  ) {}

  private get maxParticipants(): number {
    return readMaxParticipants(this.config);
  }

  /**
   * Advisory status for the bot's opening message only. It is NOT the cap
   * enforcement — `register()` re-checks atomically inside its transaction.
   */
  async getRegistrationStatus(telegramId: number): Promise<RegistrationStatus> {
    const existing = await this.prisma.participant.findUnique({
      where: { telegramId: BigInt(telegramId) },
      select: { id: true },
    });
    if (existing) return 'registered';
    const count = await countActiveHolds(this.prisma, new Date());
    return count >= this.maxParticipants ? 'closed' : 'open';
  }

  /**
   * Creates the Participant, assigning its track, together with its pending
   * Payment — the 2-hour hold on a place. The hold count and both inserts run
   * in one transaction holding the cap advisory lock, so concurrent
   * registrations at count = cap - 1 yield exactly one success. The Sheets
   * row is enqueued once committed.
   *
   * @throws RegistrationClosedError | AlreadyRegisteredError | InvalidRegistrationError
   */
  async register(input: RegistrationInput): Promise<Participant> {
    const data = this.validate(input);
    const cap = this.maxParticipants;

    let participant: Participant;
    try {
      participant = await this.prisma.$transaction(async (tx) => {
        await lockCap(tx);
        if ((await countActiveHolds(tx, new Date())) >= cap) {
          throw new RegistrationClosedError();
        }
        return tx.participant.create({
          data: {
            ...data,
            payments: { create: { amount: PAYMENT_AMOUNT_UZS } },
          },
        });
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // Unique violation: telegramId (qrToken collisions are 2^-256).
        throw new AlreadyRegisteredError();
      }
      throw err;
    }
    this.sheets.registered(participant.id);
    return participant;
  }

  private validate(input: RegistrationInput): Prisma.ParticipantCreateInput {
    const phone = parsePhone(input.phone);
    const fullName = parseFullName(input.fullName);
    const birthYearOrCourse = parseBirthYearOrCourse(input.birthYearOrCourse);
    const direction = parseDirection(input.direction);
    if (!Number.isSafeInteger(input.telegramId) || input.telegramId <= 0) {
      throw new InvalidRegistrationError('telegramId');
    }
    if (!isLanguageCode(input.languageCode)) {
      throw new InvalidRegistrationError('languageCode');
    }
    if (!phone) throw new InvalidRegistrationError('phone');
    if (!fullName) throw new InvalidRegistrationError('fullName');
    if (!birthYearOrCourse)
      throw new InvalidRegistrationError('birthYearOrCourse');
    if (!direction) throw new InvalidRegistrationError('direction');

    const track = assignTrack(input.hasSkillAndPortfolio);
    let cvLink: string | null = null;
    if (track === Track.JOB) {
      cvLink = input.cvLink ? parseCvLink(input.cvLink) : null;
      if (!cvLink) throw new InvalidRegistrationError('cvLink');
    }

    return {
      telegramId: BigInt(input.telegramId),
      languageCode: input.languageCode,
      phone,
      fullName,
      birthYearOrCourse,
      direction,
      track,
      cvLink,
      qrToken: randomBytes(32).toString('base64url'),
    };
  }
}
