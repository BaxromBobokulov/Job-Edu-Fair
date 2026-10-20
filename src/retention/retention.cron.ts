import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EVENT_TIME_ZONE } from '../bot/bot.constants';
import { RetentionService } from './retention.service';

/**
 * Daily at 03:00 event time: purges PII once EVENT_DATE + 3 months has
 * arrived (a no-op before, and on every later day). The only trigger — there
 * is no manual "purge now".
 */
@Injectable()
export class RetentionCron {
  private readonly logger = new Logger(RetentionCron.name);

  constructor(private readonly retention: RetentionService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, {
    name: 'retention-purge',
    timeZone: EVENT_TIME_ZONE,
  })
  async run(): Promise<void> {
    try {
      await this.retention.run();
    } catch (err) {
      // The transaction rolled back; tomorrow's run retries.
      this.logger.error(
        `Retention purge FAILED, nothing purged: ${err instanceof Error ? err.name : typeof err}`,
      );
    }
  }
}
