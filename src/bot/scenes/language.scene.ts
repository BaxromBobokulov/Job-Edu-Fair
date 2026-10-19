import { Action, Ctx, On, Scene, SceneEnter } from 'nestjs-telegraf';
import { isLang } from '../../i18n/i18n';
import { ParticipantsService } from '../../participants/participants.service';
import {
  LANGUAGE_CALLBACK_PREFIX,
  LANGUAGE_CALLBACK_RE,
  LANGUAGE_SCENE_ID,
} from '../bot.constants';
import type { BotContext } from '../bot.context';
import {
  beginRegistration,
  logUnexpected,
  sendLanguagePicker,
} from './registration.helpers';

/** First registration step: pick UZ / RU / EN before anything else is asked. */
@Scene(LANGUAGE_SCENE_ID)
export class LanguageScene {
  constructor(private readonly participants: ParticipantsService) {}

  @SceneEnter()
  async onEnter(@Ctx() ctx: BotContext): Promise<void> {
    await sendLanguagePicker(ctx);
  }

  @Action(LANGUAGE_CALLBACK_RE)
  async onPick(@Ctx() ctx: BotContext): Promise<void> {
    const data =
      ctx.callbackQuery && 'data' in ctx.callbackQuery
        ? ctx.callbackQuery.data
        : '';
    const lang = data.slice(LANGUAGE_CALLBACK_PREFIX.length);
    if (!isLang(lang)) return;

    ctx.session.language = lang;
    await ctx.answerCbQuery();
    // Drop the buttons so the picker can't be tapped again mid-registration.
    await ctx.editMessageReplyMarkup(undefined).catch((err: unknown) => {
      logUnexpected('editMessageReplyMarkup', err);
    });
    await beginRegistration(ctx, this.participants);
  }

  /** Anything else (text, commands, contacts…) before a pick: ask again. */
  @On('message')
  async onOther(@Ctx() ctx: BotContext): Promise<void> {
    await sendLanguagePicker(ctx);
  }
}
