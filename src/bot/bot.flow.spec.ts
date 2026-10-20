import { Participant } from '@prisma/client';
import { Telegraf } from 'telegraf';
import type { Update } from 'telegraf/types';
import {
  callbackUpdate,
  contactUpdate,
  createTestBot,
  SentMessage,
  textUpdate,
} from '../../test/telegram-fakes';
import { HrScannerService } from '../hr/hr-scanner.service';
import { Lang, LANGUAGES, t } from '../i18n/i18n';
import { RegistrationClosedError } from '../participants/participants.errors';
import {
  ParticipantsService,
  RegistrationInput,
} from '../participants/participants.service';
import { assignTrack, DIRECTIONS } from '../participants/registration.rules';
import { ClickConfig } from '../payments/click.config';
import { Invoice, PaymentsService } from '../payments/payments.service';
import { QrService } from '../qr/qr.service';
import { BotModule } from './bot.module';

const PICKER_TEXT = LANGUAGES.map((l) => t('language.prompt', l)).join('\n');
const PICKER_BUTTONS = ["O'zbekcha", 'Русский', 'English'];
const PAY_URL = 'https://my.click.uz/services/pay?transaction_param=pay-1';
const PENDING_INVOICE: Invoice = {
  paymentId: 'pay-1',
  status: 'pending',
  amount: 50_000,
  payUrl: PAY_URL,
};

/** The message with the Click button that follows a successful registration. */
function paymentOffer(chatId: number, lang: Lang): SentMessage {
  return {
    chatId,
    text: t('payment.offer', lang, { amount: '50 000' }),
    buttons: [t('payment.button', lang, { amount: '50 000' })],
    urls: [PAY_URL],
  };
}

describe('registration bot flow', () => {
  let bot: Telegraf;
  let sent: SentMessage[];
  const participants = {
    getRegistrationStatus: jest.fn(),
    register: jest.fn(),
  };
  const payments = {
    createInvoice: jest.fn(),
    getStatusByTelegramId: jest.fn(),
  };
  const qr = { sendQr: jest.fn() };

  const send = (update: Update) => bot.handleUpdate(update);
  const textsTo = (chatId: number) =>
    sent.filter((m) => m.chatId === chatId).map((m) => m.text);
  const last = () => sent[sent.length - 1];

  async function startAndPick(userId: number, lang: Lang): Promise<void> {
    await send(textUpdate(userId, '/start'));
    await send(callbackUpdate(userId, `lang:${lang}`));
  }

  async function walkToFilterQuestion(userId: number, lang: Lang) {
    await startAndPick(userId, lang);
    await send(contactUpdate(userId, '998901234567'));
    await send(textUpdate(userId, 'Aziz Karimov'));
    await send(textUpdate(userId, '2003'));
    await send(textUpdate(userId, t('direction.Backend', lang)));
  }

  beforeAll(async () => {
    const testBot = await createTestBot([BotModule], (b) =>
      b
        .overrideProvider(ParticipantsService)
        .useValue(participants)
        .overrideProvider(PaymentsService)
        .useValue(payments)
        .overrideProvider(ClickConfig)
        .useValue({})
        .overrideProvider(QrService)
        .useValue(qr)
        .overrideProvider(HrScannerService)
        .useValue({ findHr: () => Promise.resolve(null) }),
    );
    bot = testBot.bot;
    sent = testBot.sent;
  });

  beforeEach(() => {
    sent.length = 0;
    participants.getRegistrationStatus.mockReset().mockResolvedValue('open');
    participants.register
      .mockReset()
      .mockImplementation((input: RegistrationInput) =>
        Promise.resolve({
          id: `participant-${input.telegramId}`,
          fullName: input.fullName,
          track: assignTrack(input.hasSkillAndPortfolio),
        } as Participant),
      );
    payments.createInvoice.mockReset().mockResolvedValue(PENDING_INVOICE);
    payments.getStatusByTelegramId.mockReset().mockResolvedValue(null);
    qr.sendQr.mockReset().mockResolvedValue(undefined);
  });

  describe.each(LANGUAGES.map((lang, i) => [lang, 100 + i * 10] as const))(
    'in %s',
    (lang, userId) => {
      it('renders every message and button of the Job branch, errors included', async () => {
        await send(textUpdate(userId, '/start'));
        await send(textUpdate(userId, 'hello')); // no language yet → picker again
        await send(callbackUpdate(userId, `lang:${lang}`));
        await send(textUpdate(userId, 'my number is 123'));
        await send(contactUpdate(userId, '998900000000', 999)); // someone else's
        await send(contactUpdate(userId, '998901234567'));
        await send(textUpdate(userId, 'Aziz'));
        await send(textUpdate(userId, 'Aziz Karimov'));
        await send(textUpdate(userId, '2003'));
        await send(textUpdate(userId, 'Blockchain'));
        await send(textUpdate(userId, t('direction.Other', lang)));
        await send(textUpdate(userId, 'maybe'));
        await send(textUpdate(userId, t('filter.yes', lang)));
        await send(textUpdate(userId, 'not a link'));
        await send(textUpdate(userId, 'https://github.com/aziz'));

        const phoneButton = t('phone.button', lang);
        const directionButtons = DIRECTIONS.map((d) =>
          t(`direction.${d}`, lang),
        );
        const filterButtons = [t('filter.yes', lang), t('filter.no', lang)];
        expect(sent.filter((m) => m.chatId === userId)).toEqual([
          { chatId: userId, text: PICKER_TEXT, buttons: PICKER_BUTTONS },
          { chatId: userId, text: PICKER_TEXT, buttons: PICKER_BUTTONS },
          { chatId: userId, text: t('registration.welcome', lang) },
          {
            chatId: userId,
            text: t('phone.prompt', lang),
            buttons: [phoneButton],
          },
          {
            chatId: userId,
            text: t('phone.useButton', lang, { button: phoneButton }),
            buttons: [phoneButton],
          },
          {
            chatId: userId,
            text: t('phone.notOwn', lang),
            buttons: [phoneButton],
          },
          { chatId: userId, text: t('fullName.prompt', lang) },
          { chatId: userId, text: t('fullName.invalid', lang) },
          { chatId: userId, text: t('birthYearOrCourse.prompt', lang) },
          {
            chatId: userId,
            text: t('direction.prompt', lang),
            buttons: directionButtons,
          },
          {
            chatId: userId,
            text: t('common.pickButton', lang),
            buttons: directionButtons,
          },
          {
            chatId: userId,
            text: t('filter.prompt', lang),
            buttons: filterButtons,
          },
          {
            chatId: userId,
            text: t('common.pickButton', lang),
            buttons: filterButtons,
          },
          { chatId: userId, text: t('cvLink.prompt', lang) },
          { chatId: userId, text: t('cvLink.invalid', lang) },
          {
            chatId: userId,
            text: t('registration.success', lang, {
              name: 'Aziz Karimov',
              track: t('track.JOB', lang),
            }),
          },
          paymentOffer(userId, lang),
        ]);
        expect(payments.createInvoice).toHaveBeenCalledWith(
          `participant-${userId}`,
        );

        // Stored values are the untranslated ones, plus the picked language.
        expect(participants.register).toHaveBeenCalledWith({
          telegramId: userId,
          languageCode: lang,
          phone: '+998901234567',
          fullName: 'Aziz Karimov',
          birthYearOrCourse: '2003',
          direction: 'Other',
          hasSkillAndPortfolio: true,
          cvLink: 'https://github.com/aziz',
        });
      });

      it('registers the Edu branch without asking for a CV', async () => {
        const id = userId + 1;
        await walkToFilterQuestion(id, lang);
        await send(textUpdate(id, t('filter.no', lang)));

        expect(participants.register).toHaveBeenCalledWith(
          expect.objectContaining({
            telegramId: id,
            languageCode: lang,
            direction: 'Backend',
            hasSkillAndPortfolio: false,
            cvLink: null,
          }),
        );
        expect(textsTo(id)).not.toContain(t('cvLink.prompt', lang));
        expect(textsTo(id).at(-2)).toBe(
          t('registration.success', lang, {
            name: 'Aziz Karimov',
            track: t('track.EDU', lang),
          }),
        );
        expect(last()).toEqual(paymentOffer(id, lang));
      });

      it('/status shows each payment state in the stored language, even with no session', async () => {
        const id = userId + 5; // never picked a language in this session
        payments.getStatusByTelegramId.mockResolvedValueOnce({
          participantId: 'participant-1',
          languageCode: lang,
          invoice: PENDING_INVOICE,
        });
        await send(textUpdate(id, '/status'));
        expect(last()).toEqual({
          chatId: id,
          text: t('status.pending', lang, { amount: '50 000' }),
          buttons: [t('payment.button', lang, { amount: '50 000' })],
          urls: [PAY_URL],
        });

        // Paid: the QR image is resent (rendered + sent by QrService).
        payments.getStatusByTelegramId.mockResolvedValueOnce({
          participantId: 'participant-1',
          languageCode: lang,
          invoice: { ...PENDING_INVOICE, status: 'paid', payUrl: null },
        });
        const before = sent.length;
        await send(textUpdate(id, '/status'));
        expect(qr.sendQr).toHaveBeenCalledWith('participant-1', 'resend');
        expect(sent.length).toBe(before);

        for (const status of [
          'refund_requested',
          'refunded',
          'expired',
        ] as const) {
          payments.getStatusByTelegramId.mockResolvedValueOnce({
            participantId: 'participant-1',
            languageCode: lang,
            invoice: { ...PENDING_INVOICE, status, payUrl: null },
          });
          await send(textUpdate(id, '/status'));
          expect(last()).toEqual({
            chatId: id,
            text: t(`status.${status}`, lang),
          });
        }
        expect(payments.getStatusByTelegramId).toHaveBeenCalledWith(id);
      });

      it('says payment is unavailable when no Click link can be made', async () => {
        const id = userId + 6;
        payments.createInvoice.mockResolvedValueOnce({
          ...PENDING_INVOICE,
          payUrl: null,
        });
        await walkToFilterQuestion(id, lang);
        await send(textUpdate(id, t('filter.no', lang)));
        expect(last()).toEqual({
          chatId: id,
          text: t('payment.unavailable', lang),
        });

        // An invoice failure after a saved registration doesn't undo it.
        payments.createInvoice.mockRejectedValueOnce(new Error('db down'));
        await walkToFilterQuestion(id + 100, lang);
        await send(textUpdate(id + 100, t('filter.no', lang)));
        expect(textsTo(id + 100).slice(-2)).toEqual([
          t('registration.success', lang, {
            name: 'Aziz Karimov',
            track: t('track.EDU', lang),
          }),
          t('payment.unavailable', lang),
        ]);
      });

      it('says "closed" and "already registered" in the picked language', async () => {
        participants.getRegistrationStatus.mockResolvedValueOnce('closed');
        await startAndPick(userId + 2, lang);
        expect(last().text).toBe(t('registration.closed', lang));

        participants.getRegistrationStatus.mockResolvedValueOnce('registered');
        await startAndPick(userId + 3, lang);
        expect(last().text).toBe(t('registration.alreadyRegistered', lang));
      });

      it('/cancel replies in the picked language', async () => {
        await startAndPick(userId + 4, lang);
        await send(textUpdate(userId + 4, '/cancel'));
        expect(last().text).toBe(t('registration.cancelled', lang));
      });
    },
  );

  describe('language gate (no language picked yet)', () => {
    it.each([
      ['a command', 201, (id: number) => textUpdate(id, '/help')],
      ['/cancel', 202, (id: number) => textUpdate(id, '/cancel')],
      ['plain text', 203, (id: number) => textUpdate(id, 'hi')],
      ['a contact', 204, (id: number) => contactUpdate(id, '998901234567')],
    ])('re-prompts the picker on %s', async (_label, chatId, update) => {
      await send(update(chatId));
      expect(sent).toEqual([
        { chatId, text: PICKER_TEXT, buttons: PICKER_BUTTONS },
      ]);
    });

    it('re-prompts on any command while the picker is open', async () => {
      await send(textUpdate(205, '/start'));
      await send(textUpdate(205, '/help'));
      expect(textsTo(205)).toEqual([PICKER_TEXT, PICKER_TEXT]);
    });
  });

  it('keeps the language for the whole registration and re-asks it on /start', async () => {
    await walkToFilterQuestion(300, 'ru');
    expect(textsTo(300).every((x) => x !== t('filter.prompt', 'en'))).toBe(
      true,
    );
    expect(last().text).toBe(t('filter.prompt', 'ru'));

    // Mid-flow /start goes back to the picker; a new pick switches language.
    await send(textUpdate(300, '/start'));
    expect(last().text).toBe(PICKER_TEXT);
    await send(callbackUpdate(300, 'lang:uz'));
    expect(last().text).toBe(t('phone.prompt', 'uz'));
  });

  it('reports a cap rejection from the service in the picked language', async () => {
    participants.register.mockRejectedValue(new RegistrationClosedError());
    await walkToFilterQuestion(400, 'uz');
    await send(textUpdate(400, t('filter.no', 'uz')));
    expect(last().text).toBe(t('registration.closed', 'uz'));

    sent.length = 0;
    await send(textUpdate(400, t('filter.no', 'uz'))); // scene was left
    expect(sent).toEqual([]);
  });

  it('/status for an unregistered user: hint with a language, picker without one', async () => {
    await startAndPick(700, 'ru');
    await send(textUpdate(700, '/cancel'));
    await send(textUpdate(700, '/status'));
    expect(last().text).toBe(t('status.notRegistered', 'ru'));

    await send(textUpdate(701, '/status'));
    expect(last().text).toBe(PICKER_TEXT);
  });

  it('ignores a stale picker tap outside the language scene', async () => {
    await send(callbackUpdate(500, 'lang:en'));
    expect(sent).toEqual([]);
  });

  it('/session is gone: no reply mid-registration or outside any scene', async () => {
    await startAndPick(600, 'en');
    sent.length = 0;
    await send(textUpdate(600, '/session')); // inside onboarding
    await send(textUpdate(600, '/cancel'));
    await send(textUpdate(600, '/session')); // no scene
    expect(textsTo(600)).toEqual([t('registration.cancelled', 'en')]);
    expect(sent.some((m) => /startedAt|session is empty/.test(m.text))).toBe(
      false,
    );
  });

  it('the expiry notice’s retry button re-invoices, or says closed when no place is free', async () => {
    payments.getStatusByTelegramId.mockResolvedValueOnce({
      participantId: 'participant-800',
      languageCode: 'uz',
      invoice: { ...PENDING_INVOICE, paymentId: 'pay-2' },
    });
    await send(callbackUpdate(800, 'pay:retry'));
    expect(last()).toEqual({
      chatId: 800,
      text: t('status.pending', 'uz', { amount: '50 000' }),
      buttons: [t('payment.button', 'uz', { amount: '50 000' })],
      urls: [PAY_URL],
    });

    payments.getStatusByTelegramId.mockResolvedValueOnce({
      participantId: 'participant-801',
      languageCode: 'ru',
      invoice: null,
    });
    await send(callbackUpdate(801, 'pay:retry'));
    expect(last()).toEqual({
      chatId: 801,
      text: t('registration.closed', 'ru'),
    });
  });
});
