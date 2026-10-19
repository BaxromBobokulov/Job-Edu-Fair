import { Logger } from '@nestjs/common';
import { Markup } from 'telegraf';
import { Lang, LANGUAGES, MessageKey, t } from '../../i18n/i18n';
import { ParticipantsService } from '../../participants/participants.service';
import { Direction, DIRECTIONS } from '../../participants/registration.rules';
import {
  LANGUAGE_CALLBACK_PREFIX,
  ONBOARDING_SCENE_ID,
} from '../bot.constants';
import type { BotContext, RegistrationDraft } from '../bot.context';

const logger = new Logger('Registration');

/**
 * The user's picked language. Registration scenes are only reachable after the
 * language scene sets it (both live in the same session object), so the
 * fallback is never hit in practice — it only keeps the type non-optional.
 */
export function langOf(ctx: BotContext): Lang {
  return ctx.session.language ?? 'uz';
}

/** Replies with the message `key` in the user's language. */
export function replyT(
  ctx: BotContext,
  key: MessageKey,
  extra?: Parameters<BotContext['reply']>[1],
  params?: Record<string, string>,
) {
  return ctx.reply(t(key, langOf(ctx), params), extra);
}

export function directionLabel(direction: Direction, lang: Lang): string {
  return t(`direction.${direction}`, lang);
}

/** Maps a tapped (translated) direction button back to its stored value. */
export function directionFromLabel(
  label: string,
  lang: Lang,
): Direction | null {
  const value = label.trim();
  return DIRECTIONS.find((d) => directionLabel(d, lang) === value) ?? null;
}

/** Shown before a language is known, so the prompt is in all three languages. */
export async function sendLanguagePicker(ctx: BotContext): Promise<void> {
  await ctx.reply(
    LANGUAGES.map((lang) => t('language.prompt', lang)).join('\n'),
    Markup.inlineKeyboard([
      LANGUAGES.map((lang) =>
        Markup.button.callback(
          t('language.name', lang),
          `${LANGUAGE_CALLBACK_PREFIX}${lang}`,
        ),
      ),
    ]),
  );
}

export function draftOf(ctx: BotContext): RegistrationDraft {
  return (ctx.session.registration ??= {});
}

/**
 * Wizard steps hand commands to `next()` so they reach the bot-level handlers
 * (`/start` restarts registration). A scene-level `@Start` would also fire on
 * the very `/start` update that enters the scene and re-enter it forever.
 */
export function isCommand(ctx: BotContext): boolean {
  const msg = ctx.message;
  return !!msg && 'text' in msg && msg.text.startsWith('/');
}

export function isStartCommand(ctx: BotContext): boolean {
  const msg = ctx.message;
  return !!msg && 'text' in msg && /^\/start(@\w+)?(\s|$)/.test(msg.text);
}

/** `/refund_approve@bot abc` → "refund_approve"; undefined if not a command. */
export function commandName(ctx: BotContext): string | undefined {
  const msg = ctx.message;
  if (!msg || !('text' in msg)) return undefined;
  return /^\/([a-z0-9_]+)(@\w+)?(\s|$)/i.exec(msg.text)?.[1].toLowerCase();
}

/** Text of the incoming message, or undefined for non-text messages and commands. */
export function textOf(ctx: BotContext): string | undefined {
  const msg = ctx.message;
  if (!msg || !('text' in msg) || msg.text.startsWith('/')) return undefined;
  return msg.text;
}

/** Logs an unexpected error without its message — Prisma messages can echo query args (PII). */
export function logUnexpected(where: string, err: unknown): void {
  const name = err instanceof Error ? err.name : typeof err;
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String(err.code)
      : '-';
  logger.error(`${where} failed: ${name} (code ${code})`);
}

/** Runs right after the language is picked: status check, then onboarding. */
export async function beginRegistration(
  ctx: BotContext,
  participants: ParticipantsService,
): Promise<void> {
  if (!ctx.from) return;
  ctx.session.registration = {};

  let status: Awaited<ReturnType<ParticipantsService['getRegistrationStatus']>>;
  try {
    status = await participants.getRegistrationStatus(ctx.from.id);
  } catch (err) {
    logUnexpected('getRegistrationStatus', err);
    await replyT(ctx, 'error.tryAgainLater');
    return;
  }

  if (status !== 'open') {
    if (ctx.scene.current) await ctx.scene.leave();
    await replyT(
      ctx,
      status === 'registered'
        ? 'registration.alreadyRegistered'
        : 'registration.closed',
      Markup.removeKeyboard(),
    );
    return;
  }

  await replyT(ctx, 'registration.welcome');
  await ctx.scene.enter(ONBOARDING_SCENE_ID);
}

export async function cancelRegistration(ctx: BotContext): Promise<void> {
  delete ctx.session.registration;
  await ctx.scene.leave();
  await replyT(ctx, 'registration.cancelled', Markup.removeKeyboard());
}
