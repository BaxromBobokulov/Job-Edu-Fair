import { Injectable, Logger } from '@nestjs/common';
import { LanguageCode, PaymentStatus, Track } from '@prisma/client';
import { InjectBot } from 'nestjs-telegraf';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { Telegraf } from 'telegraf';
import type { PhotoSize } from 'telegraf/types';
import { t } from '../i18n/i18n';
import { PrismaService } from '../prisma/prisma.service';
import { decodeQrPixels } from './qr-decode.thread';
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

/**
 * Marks a code as this event's: the QR text is `JEF26:<qrToken>`. Decoding
 * (Part 4) checks it before any token lookup, so "code from another event"
 * stays distinct from "not a valid code". Change it for a new event.
 */
export const EVENT_QR_PREFIX = 'JEF26:';

/** The text encoded into a participant's QR. */
export function qrPayload(qrToken: string): string {
  return `${EVENT_QR_PREFIX}${qrToken}`;
}

/** Renders the PNG for a token, tinted by track. */
export function renderQr(qrToken: string, track: Track): Promise<Buffer> {
  return QRCode.toBuffer(qrPayload(qrToken), {
    ...QR_RENDER_OPTIONS,
    type: 'png',
    color: QR_COLORS[track],
  });
}

/**
 * Longest side a photo is decoded at. Telegram's largest photo size is at most
 * 2560 px; bigger is only slower.
 */
const DECODE_MAX_SIDE = 2000;

/**
 * The QR text in a photo, or null if there is none / the image is unreadable.
 * Pixels come from sharp (Telegram photos are JPEG; libuv thread pool); jsQR
 * finds the code in a worker thread. Neither runs on the event loop.
 */
export async function readQrText(image: Buffer): Promise<string | null> {
  let raw: { data: Buffer; info: sharp.OutputInfo };
  try {
    raw = await sharp(image)
      .resize(DECODE_MAX_SIDE, DECODE_MAX_SIDE, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    return null; // not an image sharp can read
  }
  const { data, info } = raw;
  // A copy: sharp's buffer can't be transferred to the decode thread.
  const text = await decodeQrPixels(
    new Uint8ClampedArray(data),
    info.width,
    info.height,
  );
  return text || null;
}

/** What a scanned participant's profile shows to HR. */
export interface ScannedParticipant {
  id: string;
  fullName: string;
  direction: string;
  track: Track;
}

/**
 * Outcome of decoding an HR photo (see .claude/rules/qr-hr.md). `invalid`
 * covers both "no readable QR" and "our prefix, unknown token": a token that
 * isn't ours is garbage either way.
 */
export type DecodeResult =
  | { kind: 'ok'; participant: ScannedParticipant }
  | { kind: 'invalid' }
  | { kind: 'other_event' }
  /** Real participant, but the current payment isn't `paid` (refund, expiry…). */
  | { kind: 'not_paid' };

/**
 * QR generation, delivery and decoding. The image encodes `Participant.qrToken`
 * (random, non-guessable, created at registration) behind EVENT_QR_PREFIX —
 * never the row id — and is rendered on demand rather than stored, so a resend
 * is always identical. Decoding resolves an HR's photo back to the participant;
 * check-in and decisions are the HR scanner's (src/hr/).
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
      participant.telegramId === null || // PII purged by the retention job
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

  /**
   * Downloads the largest size of a Telegram photo (Telegram sends several
   * resolutions; the biggest decodes best).
   */
  async downloadLargestPhoto(sizes: readonly PhotoSize[]): Promise<Buffer> {
    if (sizes.length === 0) throw new Error('photo has no sizes');
    const largest = sizes.reduce((a, b) =>
      b.width * b.height > a.width * a.height ? b : a,
    );
    // The link embeds the bot token: never log it.
    const url = await this.bot.telegram.getFileLink(largest.file_id);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`photo download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Decodes a photo of a QR and resolves it to a participant. */
  async decodeFromPhoto(photo: Buffer): Promise<DecodeResult> {
    const text = await readQrText(photo);
    if (text === null) return { kind: 'invalid' };
    if (!text.startsWith(EVENT_QR_PREFIX)) return { kind: 'other_event' };
    return this.resolveToken(text.slice(EVENT_QR_PREFIX.length));
  }

  /** Looks a decoded token up; only a `paid` current payment admits the participant. */
  async resolveToken(qrToken: string): Promise<DecodeResult> {
    if (qrToken === '') return { kind: 'invalid' };
    const participant = await this.prisma.participant.findUnique({
      where: { qrToken },
      select: {
        id: true,
        fullName: true,
        direction: true,
        track: true,
        payments: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { status: true },
        },
      },
    });
    if (!participant) return { kind: 'invalid' };
    const { payments, track, fullName, ...profile } = participant;
    // fullName is null only after the retention purge: no longer a valid registration.
    if (
      payments[0]?.status !== PaymentStatus.paid ||
      track === null ||
      fullName === null
    ) {
      return { kind: 'not_paid' };
    }
    return { kind: 'ok', participant: { ...profile, fullName, track } };
  }
}
