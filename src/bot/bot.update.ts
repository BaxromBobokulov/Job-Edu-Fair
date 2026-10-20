import { Action, Ctx, Next, Start, Update, Use } from 'nestjs-telegraf';
import { HrScannerService } from '../hr/hr-scanner.service';
import {
  LANGUAGE_CALLBACK_RE,
  LANGUAGE_FREE_COMMANDS,
  LANGUAGE_SCENE_ID,
} from './bot.constants';
import type { BotContext } from './bot.context';
import {
  commandName,
  isStartCommand,
  logUnexpected,
} from './scenes/registration.helpers';

@Update()
export class BotUpdate {
  constructor(private readonly hr: HrScannerService) {}

  /**
   * Language gate — declared first so it runs before the handlers below.
   * Until a language is picked, any message other than /start re-opens the
   * picker instead of reaching a handler that would reply in no language.
   * HR scanners pass: their language is stored with their HR binding.
   */
  @Use()
  async requireLanguage(
    @Ctx() ctx: BotContext,
    @Next() next: () => Promise<void>,
  ): Promise<void> {
    if (
      ctx.session.language ||
      !ctx.message ||
      isStartCommand(ctx) ||
      LANGUAGE_FREE_COMMANDS.includes(commandName(ctx) ?? '')
    ) {
      return next();
    }
    if (ctx.from && (await this.isHr(ctx.from.id))) return next();
    await ctx.scene.enter(LANGUAGE_SCENE_ID);
  }

  private async isHr(telegramId: number): Promise<boolean> {
    try {
      return (await this.hr.findHr(telegramId)) !== null;
    } catch (err) {
      logUnexpected('HR lookup', err);
      return false;
    }
  }

  @Start()
  async onStart(@Ctx() ctx: BotContext): Promise<void> {
    await ctx.scene.enter(LANGUAGE_SCENE_ID);
  }

  /** A tap on an old picker message outside the language scene: just stop the spinner. */
  @Action(LANGUAGE_CALLBACK_RE)
  async onStaleLanguagePick(@Ctx() ctx: BotContext): Promise<void> {
    await ctx.answerCbQuery();
  }
}
