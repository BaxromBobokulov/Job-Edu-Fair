import { ConfigService } from '@nestjs/config';
import { TelegrafModuleOptions } from 'nestjs-telegraf';
import { session } from 'telegraf';

export type BotMode = 'polling' | 'webhook';

export function createTelegrafOptions(
  config: ConfigService,
): TelegrafModuleOptions {
  const token = config.getOrThrow<string>('BOT_TOKEN');
  const mode = config.get<BotMode>('BOT_MODE', 'polling');

  if (mode === 'webhook') {
    // TODO: build out webhook mode once a public domain is available
    // (launchOptions.webhook = { domain, path } or launchOptions: false + app.use(bot.webhookCallback(path))).
    throw new Error('BOT_MODE=webhook is not implemented yet; use polling.');
  }
  if (mode !== 'polling') {
    throw new Error(`Unknown BOT_MODE "${String(mode)}"`);
  }

  return {
    token,
    // In-memory session store: persists across messages for the process lifetime.
    // TODO(before production): move to a persistent session store (Redis/Postgres).
    // A restart or deploy mid-registration currently drops every in-progress
    // onboarding draft, and sessions don't survive running more than one instance.
    middlewares: [session()],
    launchOptions: {},
  };
}
