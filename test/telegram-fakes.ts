import { DynamicModule, ForwardReference, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { getBotToken, TelegrafModule } from 'nestjs-telegraf';
import { Telegraf, Telegram } from 'telegraf';
import type { Update } from 'telegraf/types';
import { createTelegrafOptions } from '../src/config/telegraf.config';

/** A message the bot sent, with the reply-keyboard button labels if any. */
export interface SentMessage {
  chatId: number;
  text: string;
  buttons?: string[];
  /** URLs of inline URL buttons (e.g. the Click pay link), if any. */
  urls?: string[];
}

const fakeTelegrafConfig = {
  getOrThrow: () => '123:fake-token',
  get: (_key: string, fallback: unknown) => fallback,
} as unknown as ConfigService;

let updateId = 0;

function baseMessage(fromId: number) {
  ++updateId;
  return {
    message_id: updateId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: fromId, type: 'private' as const, first_name: 'Test' },
    from: { id: fromId, is_bot: false, first_name: 'Test' },
  };
}

export function textUpdate(fromId: number, text: string): Update {
  const message = baseMessage(fromId);
  return {
    update_id: updateId,
    message: {
      ...message,
      text,
      ...(text.startsWith('/') && {
        entities: [
          { type: 'bot_command', offset: 0, length: text.split(' ')[0].length },
        ],
      }),
    },
  };
}

export function contactUpdate(
  fromId: number,
  phone: string,
  contactUserId: number = fromId,
): Update {
  const message = baseMessage(fromId);
  return {
    update_id: updateId,
    message: {
      ...message,
      contact: {
        phone_number: phone,
        first_name: 'Test',
        user_id: contactUserId,
      },
    },
  };
}

/** A tap on an inline button with the given callback data. */
export function callbackUpdate(fromId: number, data: string): Update {
  const message = baseMessage(fromId);
  return {
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: message.from,
      chat_instance: '1',
      data,
      message: { ...message, text: 'picker' },
    },
  };
}

/**
 * Boots TelegrafModule (no polling) plus the given modules, stubs the Telegram
 * API, and returns the bot together with the list of messages it sends.
 */
export async function createTestBot(
  imports: Array<
    Type | DynamicModule | Promise<DynamicModule> | ForwardReference
  >,
  customize: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
) {
  const moduleRef = await customize(
    Test.createTestingModule({
      imports: [
        TelegrafModule.forRootAsync({
          useFactory: () => ({
            ...createTelegrafOptions(fakeTelegrafConfig),
            launchOptions: false,
          }),
        }),
        ...imports,
      ],
    }),
  ).compile();
  await moduleRef.init();

  const bot = moduleRef.get<Telegraf>(getBotToken());
  bot.botInfo = {
    id: 1,
    is_bot: true,
    first_name: 'QRbot',
    username: 'qrbot_test',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };

  const sent: SentMessage[] = [];
  // Telegraf creates a fresh Telegram client per update, so stub the prototype.
  jest
    .spyOn(Telegram.prototype, 'callApi')
    .mockImplementation((method, payload) => {
      if (method === 'sendMessage') {
        const { chat_id, text, reply_markup } = payload as {
          chat_id: number;
          text: string;
          reply_markup?: {
            keyboard?: Array<Array<string | { text: string }>>;
            inline_keyboard?: Array<Array<{ text: string; url?: string }>>;
          };
        };
        const buttons = (
          reply_markup?.keyboard ?? reply_markup?.inline_keyboard
        )
          ?.flat()
          .map((b) => (typeof b === 'string' ? b : b.text));
        const urls = reply_markup?.inline_keyboard
          ?.flat()
          .flatMap((b) => (b.url ? [b.url] : []));
        sent.push({
          chatId: chat_id,
          text,
          ...(buttons && { buttons }),
          ...(urls && urls.length > 0 && { urls }),
        });
      }
      return Promise.resolve({} as never);
    });

  return { moduleRef, bot, sent };
}
