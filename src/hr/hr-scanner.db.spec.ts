/**
 * HR scanning (Part 4) against real Postgres (own `qrbot_test_hr` schema) and
 * the real bot + admin modules with a faked Telegram API: check-in once,
 * append-only decisions, and company isolation.
 */
import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TestingModule } from '@nestjs/testing';
import { PaymentStatus, ScanDecision, Track } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { Telegraf } from 'telegraf';
import { describeDb, setUpTestDatabase } from '../../test/test-db';
import {
  callbackUpdate,
  createTestBot,
  photoUpdate,
  SentMessage,
  textUpdate,
} from '../../test/telegram-fakes';
import { AdminModule } from '../admin/admin.module';
import { BotModule } from '../bot/bot.module';
import { t } from '../i18n/i18n';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { QrService, renderQr } from '../qr/qr.service';
import { InlineJobQueue } from '../queue/job-queue';
import { QR_DECODE_QUEUE } from '../queue/queue.module';
import { DecisionNotAllowedError, NotHrUserError } from './hr.errors';
import { HrScannerService } from './hr-scanner.service';

const TEST_SCHEMA = 'qrbot_test_hr';
const ADMIN = 4242;
const HR_A = 9001; // Acme
const HR_B = 9002; // Globex
const STRANGER = 777;

async function photoOf(qrToken: string, track: Track): Promise<Buffer> {
  return sharp({
    create: { width: 1280, height: 960, channels: 3, background: '#cfcfcf' },
  })
    .composite([{ input: await renderQr(qrToken, track), left: 400, top: 200 }])
    .jpeg({ quality: 80 })
    .toBuffer();
}

describeDb('HR scanner (Postgres + bot)', () => {
  jest.setTimeout(60_000);

  let prisma: PrismaService;
  let moduleRef: TestingModule;
  let bot: Telegraf;
  let sent: SentMessage[];
  let hr: HrScannerService;
  /** What the faked Telegram download returns for the next photo. */
  let nextPhoto: Buffer;
  let download: jest.SpyInstance;
  let scans: InlineJobQueue<object>;

  beforeAll(async () => {
    prisma = await setUpTestDatabase(TEST_SCHEMA);
    ({ moduleRef, bot, sent } = await createTestBot([
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ ADMIN_TELEGRAM_IDS: String(ADMIN) })],
      }),
      PrismaModule,
      BotModule,
      AdminModule,
    ]));
    hr = moduleRef.get(HrScannerService);
    scans = moduleRef.get(QR_DECODE_QUEUE);
    download = jest
      .spyOn(moduleRef.get(QrService), 'downloadLargestPhoto')
      .mockImplementation(() => Promise.resolve(nextPhoto));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    await moduleRef?.get(PrismaService).$disconnect();
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await scans.idle();
    download.mockImplementation(() => Promise.resolve(nextPhoto));
    await prisma.$executeRawUnsafe('TRUNCATE "Participant", "Company" CASCADE');
    sent.length = 0;
    await hr.registerHr({
      adminTelegramId: ADMIN,
      hrTelegramId: HR_A,
      languageCode: 'uz',
      companyName: 'Acme',
    });
    await hr.registerHr({
      adminTelegramId: ADMIN,
      hrTelegramId: HR_B,
      languageCode: 'ru',
      companyName: 'Globex',
    });
  });

  let nextTelegramId = 1;

  async function participantWith(status: PaymentStatus = PaymentStatus.paid) {
    const telegramId = nextTelegramId++;
    const p = await prisma.participant.create({
      data: {
        telegramId,
        languageCode: 'en',
        phone: `+99890${String(telegramId).padStart(7, '0')}`,
        fullName: 'Aziz Karimov',
        birthYearOrCourse: '2003',
        direction: 'Data Science',
        track: Track.JOB,
        cvLink: 'https://github.com/aziz',
        qrToken: randomBytes(32).toString('base64url'),
        payments: { create: { status, amount: 50_000 } },
      },
    });
    return { ...p, photo: await photoOf(p.qrToken, Track.JOB) };
  }

  /**
   * Makes the next photo download hang until released; `reached` resolves
   * once the qr-decode job is actually waiting on it.
   */
  function blockNextDownload() {
    let release!: (photo: Buffer) => void;
    let reached!: () => void;
    const reachedP = new Promise<void>((r) => (reached = r));
    download.mockImplementationOnce(() => {
      reached();
      return new Promise<Buffer>((resolve) => (release = resolve));
    });
    return { reached: reachedP, release: (photo: Buffer) => release(photo) };
  }

  const companyIdOf = async (telegramId: number) =>
    (await hr.findHr(telegramId))!.companyId;
  const events = (participantId: string) =>
    prisma.scanEvent.findMany({
      where: { participantId },
      orderBy: { seq: 'asc' },
    });

  describe('check-in', () => {
    it('is recorded on the first scan and never overwritten by a later one', async () => {
      const p = await participantWith();

      const first = await hr.scan(HR_A, p.photo);
      expect(first).toMatchObject({ kind: 'ok', firstCheckIn: true });
      const row = await prisma.participant.findUniqueOrThrow({
        where: { id: p.id },
      });
      expect(row.checkedInAt).toEqual(first.kind === 'ok' && first.checkedInAt);

      await new Promise((r) => setTimeout(r, 20));
      const again = await hr.scan(HR_B, p.photo);
      expect(again).toMatchObject({
        kind: 'ok',
        firstCheckIn: false,
        checkedInAt: row.checkedInAt,
      });

      const after = await prisma.participant.findUniqueOrThrow({
        where: { id: p.id },
      });
      expect(after.checkedInAt).toEqual(row.checkedInAt);
      expect(after.checkedInById).toBe((await hr.findHr(HR_A))!.id);
    });

    it('of simultaneous first scans, exactly one is the check-in', async () => {
      const p = await participantWith();
      const results = await Promise.all(
        [HR_A, HR_B, HR_A, HR_B, HR_A].map((id) => hr.scan(id, p.photo)),
      );
      const ok = results.flatMap((r) => (r.kind === 'ok' ? [r] : []));
      expect(ok).toHaveLength(5);
      expect(ok.filter((r) => r.firstCheckIn)).toHaveLength(1);
      expect(new Set(ok.map((r) => r.checkedInAt.getTime())).size).toBe(1);
    });

    it('is not recorded for a code that does not resolve to a paid participant', async () => {
      const p = await participantWith(PaymentStatus.refunded);
      expect(await hr.scan(HR_A, p.photo)).toEqual({ kind: 'not_paid' });
      const row = await prisma.participant.findUniqueOrThrow({
        where: { id: p.id },
      });
      expect(row.checkedInAt).toBeNull();
    });
  });

  describe('decisions', () => {
    it('append a new ScanEvent per press; a re-scan shows the latest', async () => {
      const p = await participantWith();
      await hr.scan(HR_A, p.photo);
      await hr.decide(HR_A, p.id, ScanDecision.interview);

      const rescan = await hr.scan(HR_A, p.photo);
      expect(rescan).toMatchObject({
        kind: 'ok',
        firstCheckIn: false,
        currentDecision: { decision: ScanDecision.interview },
      });

      await hr.decide(HR_A, p.id, ScanDecision.reserve);
      const rows = await events(p.id);
      expect(rows.map((e) => e.decision)).toEqual([
        ScanDecision.interview,
        ScanDecision.reserve,
      ]);
      expect(await hr.scan(HR_A, p.photo)).toMatchObject({
        currentDecision: { decision: ScanDecision.reserve },
      });
    });

    it('the same decision twice is still two rows (history, not upsert)', async () => {
      const p = await participantWith();
      await hr.scan(HR_A, p.photo);
      await hr.decide(HR_A, p.id, ScanDecision.internship);
      await hr.decide(HR_A, p.id, ScanDecision.internship);
      expect(await events(p.id)).toHaveLength(2);
    });

    it('needs a scan first, and a still-paid participant', async () => {
      const p = await participantWith();
      await expect(
        hr.decide(HR_A, p.id, ScanDecision.interview),
      ).rejects.toEqual(new DecisionNotAllowedError('not_scanned'));

      await hr.scan(HR_A, p.photo);
      await prisma.payment.updateMany({
        where: { participantId: p.id },
        data: { status: PaymentStatus.refund_requested },
      });
      await expect(
        hr.decide(HR_A, p.id, ScanDecision.interview),
      ).rejects.toEqual(new DecisionNotAllowedError('not_paid'));
      expect(await events(p.id)).toHaveLength(0);
    });
  });

  describe('company isolation', () => {
    it('each HR’s ScanEvents carry its own company, and each company sees only its own decision', async () => {
      const p = await participantWith();
      await hr.scan(HR_A, p.photo);
      await hr.decide(HR_A, p.id, ScanDecision.interview);

      // Globex scans after Acme decided: Acme's decision is not shown to it.
      expect(await hr.scan(HR_B, p.photo)).toMatchObject({
        kind: 'ok',
        currentDecision: null,
      });
      await hr.decide(HR_B, p.id, ScanDecision.reserve);

      const rows = await events(p.id);
      expect(rows.map((e) => [e.companyId, e.decision])).toEqual([
        [await companyIdOf(HR_A), ScanDecision.interview],
        [await companyIdOf(HR_B), ScanDecision.reserve],
      ]);
      // Every row's company is its HR user's own binding.
      for (const e of rows) {
        const author = await prisma.hrUser.findUniqueOrThrow({
          where: { id: e.hrUserId },
        });
        expect(e.companyId).toBe(author.companyId);
      }
      // Globex's later decision didn't change what Acme sees.
      expect(await hr.scan(HR_A, p.photo)).toMatchObject({
        currentDecision: { decision: ScanDecision.interview },
      });
    });

    it('a button press is attributed to the presser’s company, whoever’s screen it came from', async () => {
      const p = await participantWith();
      await hr.scan(HR_A, p.photo);
      // Same callback data Acme's HR got; pressed by Globex's HR.
      await bot.handleUpdate(callbackUpdate(HR_B, `hr:internship:${p.id}`));
      const [row] = await events(p.id);
      expect(row.companyId).toBe(await companyIdOf(HR_B));
      expect(row.hrUserId).toBe((await hr.findHr(HR_B))!.id);
    });

    it('a non-HR user can neither scan nor decide', async () => {
      const p = await participantWith();
      await expect(hr.scan(STRANGER, p.photo)).rejects.toBeInstanceOf(
        NotHrUserError,
      );
      await expect(
        hr.decide(STRANGER, p.id, ScanDecision.interview),
      ).rejects.toBeInstanceOf(NotHrUserError);

      await hr.scan(HR_A, p.photo);
      await bot.handleUpdate(callbackUpdate(STRANGER, `hr:interview:${p.id}`));
      nextPhoto = p.photo;
      await bot.handleUpdate(photoUpdate(STRANGER));
      await scans.idle();
      expect(await events(p.id)).toHaveLength(0);
      expect(sent.some((m) => m.text.includes('Aziz Karimov'))).toBe(false);
    });

    it('an HR user stays bound to one company', async () => {
      await expect(
        hr.registerHr({
          adminTelegramId: ADMIN,
          hrTelegramId: HR_A,
          languageCode: 'uz',
          companyName: 'Globex',
        }),
      ).rejects.toMatchObject({ companyName: 'Acme' });
      expect((await hr.findHr(HR_A))!.companyName).toBe('Acme');
    });
  });

  describe('bot flow', () => {
    const lastTo = (chatId: number) =>
      sent.filter((m) => m.chatId === chatId).at(-1);

    it('photo → profile in HR’s language with three buttons → press → saved', async () => {
      const p = await participantWith();
      nextPhoto = p.photo;
      // HR never picked a language in this session: the gate lets them through.
      await bot.handleUpdate(photoUpdate(HR_A));
      expect(lastTo(HR_A)!.text).toBe(t('hr.processing', 'uz'));
      await scans.idle();
      const profile = lastTo(HR_A)!;
      expect(profile.text).toContain('👤 Aziz Karimov');
      expect(profile.text).toContain("Yo'nalish: Data Science");
      expect(profile.text).toContain('Trek: Job Track');
      expect(profile.text).toContain('✅ Hozir kirish qayd etildi');
      expect(profile.text).toContain(t('hr.decision.none', 'uz'));
      expect(profile.buttons).toEqual([
        'Suhbatga chaqirildi',
        'Stajirovkaga tavsiya',
        'Zaxirada',
      ]);

      await bot.handleUpdate(callbackUpdate(HR_A, `hr:interview:${p.id}`));
      expect(lastTo(HR_A)!.text).toBe(
        '✅ Aziz Karimov uchun saqlandi: Suhbatga chaqirildi.',
      );

      // Re-scan: already checked in, current decision shown, buttons still there.
      await bot.handleUpdate(photoUpdate(HR_A));
      await scans.idle();
      const rescan = lastTo(HR_A)!;
      expect(rescan.text).toContain('ℹ️ Kirish allaqachon');
      expect(rescan.text).toContain(
        'Kompaniyangiz qarori: Suhbatga chaqirildi',
      );
      expect(rescan.buttons).toHaveLength(3);
    });

    it('each failed decode outcome gets its own message', async () => {
      const refunded = await participantWith(PaymentStatus.refunded);
      const cases: Array<[Buffer, string]> = [
        [Buffer.from('garbage'), t('hr.invalidCode', 'ru')],
        [
          await sharp({
            create: {
              width: 400,
              height: 400,
              channels: 3,
              background: '#fff',
            },
          })
            .composite([
              {
                input: await QRCode.toBuffer('OTHER:x', { type: 'png' }),
              },
            ])
            .jpeg()
            .toBuffer(),
          t('hr.otherEvent', 'ru'),
        ],
        [refunded.photo, t('hr.noLongerValid', 'ru')],
      ];
      for (const [photo, expected] of cases) {
        nextPhoto = photo;
        await bot.handleUpdate(photoUpdate(HR_B));
        await scans.idle();
        expect(lastTo(HR_B)!.text).toBe(expected);
      }
      expect(new Set(cases.map(([, text]) => text)).size).toBe(3);
    });

    it('a photo gets an instant ack; the scan runs in the qr-decode job, not the handler', async () => {
      const p = await participantWith();
      const blocked = blockNextDownload();

      // The handler returns while the download/decode is still pending.
      await bot.handleUpdate(photoUpdate(HR_A));
      await blocked.reached;
      expect(sent.filter((m) => m.chatId === HR_A).map((m) => m.text)).toEqual([
        t('hr.processing', 'uz'),
      ]);

      blocked.release(p.photo);
      await scans.idle();
      expect(lastTo(HR_A)!.text).toContain('👤 Aziz Karimov');
    });

    it('concurrent HR scans don’t block each other: a slow scan doesn’t hold up a fast one', async () => {
      const slow = await participantWith();
      const fast = await participantWith();
      const slowScan = blockNextDownload();
      download.mockImplementationOnce(() => Promise.resolve(fast.photo));

      // HR_A's scan is stuck downloading when HR_B's photo arrives.
      await bot.handleUpdate(photoUpdate(HR_A));
      await slowScan.reached;
      await bot.handleUpdate(photoUpdate(HR_B));
      expect(lastTo(HR_A)!.text).toBe(t('hr.processing', 'uz'));
      expect(lastTo(HR_B)!.text).toBe(t('hr.processing', 'ru'));

      // HR_B's scan completes while HR_A's is still pending.
      const deadline = Date.now() + 10_000;
      while (!lastTo(HR_B)!.text.includes('👤') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(lastTo(HR_B)!.buttons).toHaveLength(3);
      expect(lastTo(HR_A)!.text).toBe(t('hr.processing', 'uz'));
      const fastRow = await prisma.participant.findUniqueOrThrow({
        where: { id: fast.id },
      });
      expect(fastRow.checkedInAt).not.toBeNull();

      slowScan.release(slow.photo);
      await scans.idle();
      expect(lastTo(HR_A)!.text).toContain('👤 Aziz Karimov');
    });

    it('admin /hr_add binds a user; non-admins cannot', async () => {
      await bot.handleUpdate(textUpdate(STRANGER, '/hr_add 5555 en Initech'));
      expect(await hr.findHr(5555)).toBeNull();

      await bot.handleUpdate(textUpdate(ADMIN, '/hr_add 5555 en  initech  '));
      expect(await hr.findHr(5555)).toMatchObject({
        companyName: 'initech',
        languageCode: 'en',
      });
      const row = await prisma.hrUser.findUniqueOrThrow({
        where: { telegramId: 5555n },
      });
      expect(row.addedBy).toBe(BigInt(ADMIN));
      expect(lastTo(5555)!.text).toContain('initech');

      // Company names match case-insensitively; a second company is refused.
      await bot.handleUpdate(textUpdate(ADMIN, '/hr_add 5556 ru ACME'));
      expect((await hr.findHr(5556))!.companyId).toBe(await companyIdOf(HR_A));
      await bot.handleUpdate(textUpdate(ADMIN, '/hr_add 5555 en Globex'));
      expect(lastTo(ADMIN)!.text).toBe(
        'Not allowed: that user is already HR for "initech".',
      );
      await bot.handleUpdate(textUpdate(ADMIN, '/hr_add 5555'));
      expect(lastTo(ADMIN)!.text).toBe(
        'Usage: /hr_add <telegramId> <uz|ru|en> <company name>',
      );
    });
  });
});
