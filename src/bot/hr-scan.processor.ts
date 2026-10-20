import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { LanguageCode } from '@prisma/client';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import type { PhotoSize } from 'telegraf/types';
import { HrScannerService } from '../hr/hr-scanner.service';
import { t } from '../i18n/i18n';
import type { JobQueue } from '../queue/job-queue';
import { QR_DECODE_QUEUE } from '../queue/queue.module';
import { ScanReply, scanReply } from './hr-scanner.update';
import { logUnexpected } from './scenes/registration.helpers';

/** One HR photo to decode; the reply goes to `chatId`. */
export interface HrScanJob {
  hrTelegramId: number;
  chatId: number;
  /** The HR's language when the photo arrived, for the reply. */
  languageCode: LanguageCode;
  photo: PhotoSize[];
}

/**
 * The qr-decode worker: download, decode (in a worker thread), check-in and
 * profile lookup for one HR photo, then the result message to the HR user.
 * Every outcome — including an unexpected error — ends in a reply.
 */
@Injectable()
export class HrScanProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger(HrScanProcessor.name);

  constructor(
    private readonly hr: HrScannerService,
    @InjectBot() private readonly bot: Telegraf,
    @Inject(QR_DECODE_QUEUE) private readonly queue: JobQueue<HrScanJob>,
  ) {}

  onApplicationBootstrap(): void {
    this.queue.process((job) => this.handle(job));
  }

  async handle(job: HrScanJob): Promise<void> {
    const lang = job.languageCode;
    let reply: ScanReply;
    try {
      reply = scanReply(
        await this.hr.scanPhoto(job.hrTelegramId, job.photo),
        lang,
      );
    } catch (err) {
      logUnexpected('HR scan', err);
      reply = { text: t('error.tryAgainLater', lang) };
    }
    await this.bot.telegram.sendMessage(job.chatId, reply.text, reply.extra);
    this.logger.debug(`Scan result sent to HR ${job.hrTelegramId}`);
  }
}
