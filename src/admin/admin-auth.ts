import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Admin allow-list from ADMIN_TELEGRAM_IDS (comma-separated Telegram user ids).
 * Read on first use; empty or unset means nobody is an admin.
 */
@Injectable()
export class AdminAuth {
  private ids?: ReadonlySet<number>;

  constructor(private readonly config: ConfigService) {}

  isAdmin(telegramId: number | undefined): telegramId is number {
    if (telegramId === undefined) return false;
    this.ids ??= new Set(
      String(this.config.get<string | number>('ADMIN_TELEGRAM_IDS') ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => /^\d+$/.test(id))
        .map(Number),
    );
    return this.ids.has(telegramId);
  }
}
