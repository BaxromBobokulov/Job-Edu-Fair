import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LanguageCode, Participant, Prisma, Track } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
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

/**
 * Arbitrary constant key for the transaction-scoped advisory lock that
 * serializes "count, then insert" across concurrent registrations.
 */
const PARTICIPANT_CAP_LOCK_KEY = 0x51520001n;

function isLanguageCode(value: string): value is LanguageCode {
  return (Object.values(LanguageCode) as string[]).includes(value);
}

@Injectable()
export class ParticipantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get maxParticipants(): number {
    const raw = this.config.get<string | number>('MAX_PARTICIPANTS', 1200);
    const cap = Number(raw);
    if (!Number.isInteger(cap) || cap < 0) {
      throw new Error('MAX_PARTICIPANTS must be a non-negative integer');
    }
    return cap;
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
    const count = await this.countCapped(this.prisma);
    return count >= this.maxParticipants ? 'closed' : 'open';
  }

  /**
   * Creates the Participant, assigning its track. The cap check and the insert
   * run in one transaction holding a Postgres advisory lock, so concurrent
   * registrations at count = cap - 1 yield exactly one success.
   *
   * @throws RegistrationClosedError | AlreadyRegisteredError | InvalidRegistrationError
   */
  async register(input: RegistrationInput): Promise<Participant> {
    const data = this.validate(input);
    const cap = this.maxParticipants;

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PARTICIPANT_CAP_LOCK_KEY})`;
        if ((await this.countCapped(tx)) >= cap) {
          throw new RegistrationClosedError();
        }
        return tx.participant.create({ data });
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
  }

  private countCapped(client: Prisma.TransactionClient): Promise<number> {
    return client.participant.count({ where: { track: { not: null } } });
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
