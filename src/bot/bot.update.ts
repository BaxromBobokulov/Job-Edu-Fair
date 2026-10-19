import {
  Action,
  Command,
  Ctx,
  Next,
  Start,
  Update,
  Use,
} from 'nestjs-telegraf';
import {
  LANGUAGE_CALLBACK_RE,
  LANGUAGE_FREE_COMMANDS,
  LANGUAGE_SCENE_ID,
} from './bot.constants';
import type { BotContext } from './bot.context';
import { commandName, isStartCommand } from './scenes/registration.helpers';

@Update()
export class BotUpdate {
  /**
   * Language gate — declared first so it runs before the handlers below.
   * Until a language is picked, any message other than /start re-opens the
   * picker instead of reaching a handler that would reply in no language.
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
    await ctx.scene.enter(LANGUAGE_SCENE_ID);
  }

  @Start()
  async onStart(@Ctx() ctx: BotContext): Promise<void> {
    ctx.session.startedAt = new Date().toISOString();
    await ctx.scene.enter(LANGUAGE_SCENE_ID);
  }

  /** A tap on an old picker message outside the language scene: just stop the spinner. */
  @Action(LANGUAGE_CALLBACK_RE)
  async onStaleLanguagePick(@Ctx() ctx: BotContext): Promise<void> {
    await ctx.answerCbQuery();
  }

  // Dev-only diagnostic from the scaffold; not part of the participant flow.
  @Command('session')
  async onSession(@Ctx() ctx: BotContext): Promise<void> {
    const { startedAt } = ctx.session;
    await ctx.reply(
      startedAt ? `session.startedAt = ${startedAt}` : 'session is empty',
    );
  }
}
