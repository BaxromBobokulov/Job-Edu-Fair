/**
 * Runs against a real Postgres (DATABASE_URL, from the env or .env), in an
 * isolated `qrbot_test` schema that this file migrates and truncates itself.
 * The cap is a database-concurrency property, so it can't be tested with mocks.
 * Set SKIP_DB_TESTS=1 to skip on a machine without Postgres.
 */
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PaymentStatus, Track } from '@prisma/client';
import { Telegraf } from 'telegraf';
import { describeDb, setUpTestDatabase } from '../../test/test-db';
import {
  callbackUpdate,
  contactUpdate,
  createTestBot,
  SentMessage,
  textUpdate,
} from '../../test/telegram-fakes';
import { BotModule } from '../bot/bot.module';
import { Lang, t } from '../i18n/i18n';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import {
  AlreadyRegisteredError,
  InvalidRegistrationError,
  RegistrationClosedError,
} from './participants.errors';
import { ParticipantsService, RegistrationInput } from './participants.service';

const TEST_SCHEMA = 'qrbot_test';

let nextTelegramId = 1000;
function input(overrides: Partial<RegistrationInput> = {}): RegistrationInput {
  const telegramId = nextTelegramId++;
  return {
    telegramId,
    languageCode: 'en',
    phone: `99890${String(telegramId).padStart(7, '0')}`,
    fullName: 'Aziz Karimov',
    birthYearOrCourse: '2003',
    direction: 'Backend',
    hasSkillAndPortfolio: false,
    ...overrides,
  };
}

describeDb('ParticipantsService (Postgres)', () => {
  jest.setTimeout(60_000);

  let prisma: PrismaService;
  const serviceWithCap = (cap: number) =>
    new ParticipantsService(
      prisma,
      new ConfigService({ MAX_PARTICIPANTS: cap }),
    );

  beforeAll(async () => {
    prisma = await setUpTestDatabase(TEST_SCHEMA);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "Participant" CASCADE');
  });

  it('stores an Edu Track participant with no CV link and a random qrToken', async () => {
    const p = await serviceWithCap(10).register(
      input({ cvLink: 'https://ignored.example.com' }),
    );
    expect(p).toMatchObject({
      track: Track.EDU,
      cvLink: null,
      phone: expect.stringMatching(/^\+99890/) as string,
    });
    expect(p.qrToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.qrToken).not.toBe(p.id);
  });

  it('stores a Job Track participant with its CV link', async () => {
    const p = await serviceWithCap(10).register(
      input({ hasSkillAndPortfolio: true, cvLink: 'https://github.com/aziz' }),
    );
    expect(p.track).toBe(Track.JOB);
    expect(p.cvLink).toBe('https://github.com/aziz');
  });

  it('rejects an unsupported language code', async () => {
    await expect(
      serviceWithCap(10).register(input({ languageCode: 'de' })),
    ).rejects.toBeInstanceOf(InvalidRegistrationError);
  });

  it('rejects a second registration from the same Telegram account', async () => {
    const service = serviceWithCap(10);
    const first = input();
    await service.register(first);
    await expect(service.register({ ...first })).rejects.toBeInstanceOf(
      AlreadyRegisteredError,
    );
  });

  it('rejects registration once the cap is reached', async () => {
    const service = serviceWithCap(1);
    await service.register(input());
    await expect(service.register(input())).rejects.toBeInstanceOf(
      RegistrationClosedError,
    );
    expect(await prisma.participant.count()).toBe(1);
  });

  it('two simultaneous registrations at cap - 1 → exactly one succeeds', async () => {
    const service = serviceWithCap(3);
    await service.register(input());
    await service.register(input());

    const results = await Promise.allSettled([
      service.register(input()),
      service.register(input()),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(RegistrationClosedError);
    expect(await prisma.participant.count()).toBe(3);
  });

  it('a burst of 25 concurrent registrations never exceeds the cap', async () => {
    const service = serviceWithCap(5);
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () => service.register(input())),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(RegistrationClosedError);
      }
    }
    expect(await prisma.participant.count()).toBe(5);
  });

  describe('full bot walk-through writing to Postgres', () => {
    let bot: Telegraf;
    let sent: SentMessage[];
    const cap = 2;

    beforeAll(async () => {
      const testBot = await createTestBot([
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              MAX_PARTICIPANTS: cap,
              CLICK_SERVICE_ID: '111',
              CLICK_MERCHANT_ID: '222',
              CLICK_SECRET_KEY: 'test-secret',
            }),
          ],
        }),
        PrismaModule,
        BotModule,
      ]);
      bot = testBot.bot;
      sent = testBot.sent;
    });

    async function walkToFilterQuestion(userId: number, lang: Lang) {
      await bot.handleUpdate(textUpdate(userId, '/start'));
      await bot.handleUpdate(callbackUpdate(userId, `lang:${lang}`));
      await bot.handleUpdate(contactUpdate(userId, `99891000000${userId}`));
      await bot.handleUpdate(textUpdate(userId, 'Dilnoza Yusupova'));
      await bot.handleUpdate(textUpdate(userId, '3rd year'));
      // Translated label ("Boshqa", "Другое", "Other") → stored as "Other".
      await bot.handleUpdate(textUpdate(userId, t('direction.Other', lang)));
    }

    async function answer(userId: number, lang: Lang, answer: 'yes' | 'no') {
      if (answer === 'yes') {
        await bot.handleUpdate(textUpdate(userId, t('filter.yes', lang)));
        await bot.handleUpdate(
          textUpdate(userId, 'https://behance.net/dilnoza'),
        );
      } else {
        await bot.handleUpdate(textUpdate(userId, t('filter.no', lang)));
      }
    }

    it('Job (uz) and Edu (ru) rows land with their languageCode; the participant past the cap is rejected', async () => {
      await walkToFilterQuestion(1, 'uz');
      await answer(1, 'uz', 'yes');
      // User 3 starts while a place is still free…
      await walkToFilterQuestion(3, 'en');
      // …but user 2 takes the last place first.
      await walkToFilterQuestion(2, 'ru');
      await answer(2, 'ru', 'no');
      // User 3's insert is rejected inside the cap transaction.
      await answer(3, 'en', 'no');
      // User 4 is turned away right after picking a language.
      await bot.handleUpdate(textUpdate(4, '/start'));
      await bot.handleUpdate(callbackUpdate(4, 'lang:ru'));

      const rows = await prisma.participant.findMany({
        orderBy: { telegramId: 'asc' },
      });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        telegramId: 1n,
        languageCode: 'uz',
        phone: '+998910000001',
        fullName: 'Dilnoza Yusupova',
        birthYearOrCourse: '3rd year',
        direction: 'Other',
        track: Track.JOB,
        cvLink: 'https://behance.net/dilnoza',
      });
      expect(rows[1]).toMatchObject({
        telegramId: 2n,
        languageCode: 'ru',
        direction: 'Other',
        track: Track.EDU,
        cvLink: null,
      });

      const textsTo = (chatId: number) =>
        sent.filter((m) => m.chatId === chatId).map((m) => m.text);
      expect(textsTo(1).at(-2)).toBe(
        t('registration.success', 'uz', {
          name: 'Dilnoza Yusupova',
          track: t('track.JOB', 'uz'),
        }),
      );
      expect(textsTo(2).at(-2)).toBe(
        t('registration.success', 'ru', {
          name: 'Dilnoza Yusupova',
          track: t('track.EDU', 'ru'),
        }),
      );

      // Each registered participant gets one pending 50 000 so'm invoice and
      // a Click button pointing at it; the rejected ones get none.
      const payments = await prisma.payment.findMany();
      expect(payments).toHaveLength(2);
      for (const [chatId, lang, row] of [
        [1, 'uz', rows[0]],
        [2, 'ru', rows[1]],
      ] as const) {
        const payment = payments.find((p) => p.participantId === row.id);
        expect(payment).toMatchObject({
          status: PaymentStatus.pending,
          amount: 50_000,
        });
        const offer = sent.filter((m) => m.chatId === chatId).at(-1);
        expect(offer?.text).toBe(
          t('payment.offer', lang, { amount: '50 000' }),
        );
        expect(offer?.urls?.[0]).toBe(
          `https://my.click.uz/services/pay?service_id=111&merchant_id=222&amount=50000&transaction_param=${payment?.id}`,
        );
      }
      expect(textsTo(3).at(-1)).toBe(t('registration.closed', 'en'));
      expect(textsTo(4).at(-1)).toBe(t('registration.closed', 'ru'));
    });
  });
});
