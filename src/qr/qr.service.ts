import { Injectable, Logger } from '@nestjs/common';
import { LanguageCode, PaymentStatus, Track } from '@prisma/client';
import { InjectBot } from 'nestjs-telegraf';
import QRCode from 'qrcode';
import { Telegraf } from 'telegraf';
import { t } from '../i18n/i18n';
import { PrismaService } from '../prisma/prisma.service';
import { QrNotIssuableError } from './qr.errors';

/**
 * Module colour per track (AGENTS.md: Job Track → green VIP QR, Edu Track →
 * blue QR), on a white background. Both are dark enough for phone scanners,
 * which read luminance contrast — keep any replacement at least as dark.
 *   JOB: #006B3C (dark green)   EDU: #0047AB (cobalt blue)
 */
export const QR_COLORS: Record<Track, { dark: string; light: string }> = {
  JOB: { dark: '#006B3CFF', light: '#FFFFFFFF' },
  EDU: { dark: '#0047ABFF', light: '#FFFFFFFF' },
};

/**
 * Passed through to pngjs. A fixed "Up" filter (2) instead of pngjs's default
 * per-row search over all five: QR rows repeat vertically, so it stays small
 * (~13 KB at 600 px) and encodes ~5x faster (~20 ms) — HR scans and payment
 * bursts on event day all share one event loop. `filterType` is missing from
 * @types/qrcode, hence a named object rather than an inline literal.
 */
const PNG_RENDERER_OPTIONS = { deflateLevel: 9, filterType: 2 };

/** Margin 4 is the quiet zone the QR spec asks for; 600 px is plenty for a phone screen. */
export const QR_RENDER_OPTIONS = {
  errorCorrectionLevel: 'M',
  margin: 4,
  width: 600,
  rendererOpts: PNG_RENDERER_OPTIONS,
} as const;

/** A participant's QR image plus what's needed to send it to them. */
export interface IssuedQr {
  participantId: string;
  telegramId: bigint;
  languageCode: LanguageCode;
  track: Track;
  png: Buffer;
}

/** Renders the PNG for a token, tinted by track. The payload is the token itself. */
export function renderQr(qrToken: string, track: Track): Promise<Buffer> {
  return QRCode.toBuffer(qrToken, {
    ...QR_RENDER_OPTIONS,
    type: 'png',
    color: QR_COLORS[track],
  });
}

/**
 * QR generation and delivery. The image encodes `Participant.qrToken` (random,
 * non-guessable, created at registration) — never the row id — and is
 * rendered on demand rather than stored, so a resend is always identical.
 *
 * Decoding is a separate concern and lands with the HR scanner (Part 4):
 * a `decodeFromPhoto(photo)` here will download the largest Telegram photo
 * size, decode it server-side and resolve the token to a Participant, with
 * "not a valid code" / "not from this event" / "already checked in" as
 * distinct errors (see .claude/rules/qr-hr.md).
 */
@Injectable()
export class QrService {
  private readonly logger = new Logger(QrService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectBot() private readonly bot: Telegraf,
  ) {}

  /**
   * Generates the participant's QR. Only for a participant whose current
   * payment is `paid` — a refund request or refund revokes it.
   *
   * @throws QrNotIssuableError
   */
  async issueQr(participantId: string): Promise<IssuedQr> {
    const participant = await this.prisma.participant.findUnique({
      where: { id: participantId },
      select: {
        telegramId: true,
        languageCode: true,
        track: true,
        qrToken: true,
        payments: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { status: true },
        },
      },
    });
    if (
      !participant ||
      participant.track === null ||
      participant.payments[0]?.status !== PaymentStatus.paid
    ) {
      throw new QrNotIssuableError(participantId);
    }
    return {
      participantId,
      telegramId: participant.telegramId,
      languageCode: participant.languageCode,
      track: participant.track,
      png: await renderQr(participant.qrToken, participant.track),
    };
  }

  /**
   * Issues the QR and sends it to the participant in their stored language:
   * `issued` right after payment, `resend` for `/status`.
   *
   * @throws QrNotIssuableError, or whatever rendering / Telegram throws
   */
  async sendQr(
    participantId: string,
    reason: 'issued' | 'resend',
  ): Promise<void> {
    const qr = await this.issueQr(participantId);
    const lang = qr.languageCode;
    const caption =
      reason === 'issued'
        ? t(`qr.issued.${qr.track}`, lang)
        : t('qr.resend', lang, { track: t(`track.${qr.track}`, lang) });
    await this.bot.telegram.sendPhoto(
      Number(qr.telegramId),
      { source: qr.png, filename: 'qr.png' },
      { caption },
    );
    this.logger.log(`QR sent (${reason}) to participant ${participantId}`);
  }
}
