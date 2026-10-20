import { Inject } from '@nestjs/common';
import { ScanDecision } from '@prisma/client';
import { Action, Ctx, Next, On, Update } from 'nestjs-telegraf';
import { Markup, Telegram } from 'telegraf';
import { Lang, t } from '../i18n/i18n';
import { DecisionNotAllowedError } from '../hr/hr.errors';
import {
  CurrentDecision,
  HrScannerService,
  ScanResult,
} from '../hr/hr-scanner.service';
import { DIRECTIONS, Direction } from '../participants/registration.rules';
import type { JobQueue } from '../queue/job-queue';
import { QR_DECODE_QUEUE } from '../queue/queue.module';
import {
  EVENT_TIME_ZONE,
  HR_DECISION_CALLBACK_PREFIX,
  HR_DECISION_CALLBACK_RE,
} from './bot.constants';
import type { BotContext } from './bot.context';
import type { HrScanJob } from './hr-scan.processor';
import { directionLabel, logUnexpected } from './scenes/registration.helpers';

const DECISIONS: readonly ScanDecision[] = [
  ScanDecision.interview,
  ScanDecision.internship,
  ScanDecision.reserve,
];

/** "14:05" in the event's time zone — scans all happen on the event day. */
export function formatScanTime(at: Date): string {
  return at.toLocaleTimeString('en-GB', {
    timeZone: EVENT_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
  });
}

function decisionText(current: CurrentDecision | null, lang: Lang): string {
  return current
    ? t('hr.decision.current', lang, {
        decision: t(`hr.decision.${current.decision}`, lang),
        time: formatScanTime(current.at),
      })
    : t('hr.decision.none', lang);
}

function decisionKeyboard(participantId: string, lang: Lang) {
  return Markup.inlineKeyboard(
    DECISIONS.map((d) => [
      Markup.button.callback(
        t(`hr.decision.${d}`, lang),
        `${HR_DECISION_CALLBACK_PREFIX}${d}:${participantId}`,
      ),
    ]),
  );
}

export interface ScanReply {
  text: string;
  extra?: Parameters<Telegram['sendMessage']>[2];
}

/** The message HR gets for a scan: the profile + buttons, or which error. */
export function scanReply(result: ScanResult, lang: Lang): ScanReply {
  switch (result.kind) {
    case 'invalid':
      return { text: t('hr.invalidCode', lang) };
    case 'other_event':
      return { text: t('hr.otherEvent', lang) };
    case 'not_paid':
      return { text: t('hr.noLongerValid', lang) };
    case 'download_failed':
      return { text: t('hr.photoFailed', lang) };
    case 'ok': {
      const { participant: p } = result;
      const direction = DIRECTIONS.includes(p.direction as Direction)
        ? directionLabel(p.direction as Direction, lang)
        : p.direction;
      const time = formatScanTime(result.checkedInAt);
      return {
        text: t('hr.profile', lang, {
          name: p.fullName,
          direction,
          track: t(`track.${p.track}`, lang),
          checkIn: result.firstCheckIn
            ? t('hr.checkIn.first', lang, { time })
            : t('hr.checkIn.already', lang, { time }),
          decision: decisionText(result.currentDecision, lang),
        }),
        extra: decisionKeyboard(p.id, lang),
      };
    }
  }
}

/**
 * HR scanner mode: an HR user sends a photo of a participant's QR, gets a
 * "processing" note at once, then the profile and three decision buttons
 * from the qr-decode job (HrScanProcessor) — the handler never waits on the
 * download or decode. Everything but presentation lives in HrScannerService.
 * Photos from non-HR users pass through untouched.
 */
@Update()
export class HrScannerUpdate {
  constructor(
    private readonly hr: HrScannerService,
    @Inject(QR_DECODE_QUEUE) private readonly scans: JobQueue<HrScanJob>,
  ) {}

  @On('photo')
  async onPhoto(
    @Ctx() ctx: BotContext,
    @Next() next: () => Promise<void>,
  ): Promise<void> {
    const msg = ctx.message;
    if (!ctx.from || !ctx.chat || !msg || !('photo' in msg)) return next();
    const hr = await this.hr.findHr(ctx.from.id);
    if (!hr) return next();
    const lang = hr.languageCode;
    await ctx.reply(t('hr.processing', lang));
    this.scans.add({
      hrTelegramId: ctx.from.id,
      chatId: ctx.chat.id,
      languageCode: lang,
      photo: msg.photo,
    });
  }

  @Action(HR_DECISION_CALLBACK_RE)
  async onDecision(@Ctx() ctx: BotContext): Promise<void> {
    await ctx.answerCbQuery();
    const data =
      ctx.callbackQuery && 'data' in ctx.callbackQuery
        ? ctx.callbackQuery.data
        : '';
    const match = HR_DECISION_CALLBACK_RE.exec(data);
    if (!ctx.from || !match) return;
    const hr = await this.hr.findHr(ctx.from.id);
    if (!hr) return;
    const lang = hr.languageCode;
    const [, decision, participantId] = match;
    try {
      const saved = await this.hr.decide(
        ctx.from.id,
        participantId,
        decision as ScanDecision,
      );
      await ctx.reply(
        t('hr.decisionSaved', lang, {
          name: saved.participantName,
          decision: t(`hr.decision.${saved.decision}`, lang),
        }),
      );
    } catch (err) {
      if (err instanceof DecisionNotAllowedError) {
        await ctx.reply(
          t(
            err.reason === 'not_scanned' ? 'hr.notScanned' : 'hr.noLongerValid',
            lang,
          ),
        );
        return;
      }
      logUnexpected('HR decision', err);
      await ctx.reply(t('error.tryAgainLater', lang));
    }
  }
}
