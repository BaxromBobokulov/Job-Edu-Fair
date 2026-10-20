/**
 * Decoding an HR's photo of a QR (Part 4) against real Postgres (own
 * `qrbot_test_qr_decode` schema). Photos are built the way a phone would
 * produce them: the issued PNG on a larger background, JPEG-compressed.
 */
import { PaymentStatus, Track } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { Telegraf } from 'telegraf';
import type { PhotoSize } from 'telegraf/types';
import { describeDb, setUpTestDatabase } from '../../test/test-db';
import { PrismaService } from '../prisma/prisma.service';
import { qrPayload, QrService, readQrText, renderQr } from './qr.service';

const TEST_SCHEMA = 'qrbot_test_qr_decode';

/** `png` pasted onto a grey 1280×960 "photo" and saved as JPEG, like Telegram does. */
async function asPhoto(png: Buffer): Promise<Buffer> {
  return sharp({
    create: { width: 1280, height: 960, channels: 3, background: '#cfcfcf' },
  })
    .composite([{ input: png, left: 420, top: 230 }])
    .jpeg({ quality: 80 })
    .toBuffer();
}

/** A photo of a plain (black) QR of arbitrary text. */
async function photoOfText(text: string): Promise<Buffer> {
  return asPhoto(
    await QRCode.toBuffer(text, { type: 'png', margin: 4, scale: 8 }),
  );
}

describeDb('QR decode from photo (Postgres)', () => {
  jest.setTimeout(60_000);

  let prisma: PrismaService;
  let qr: QrService;
  const fakeBot = { telegram: { getFileLink: jest.fn() } };

  beforeAll(async () => {
    prisma = await setUpTestDatabase(TEST_SCHEMA);
    qr = new QrService(prisma, fakeBot as unknown as Telegraf);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "Participant" CASCADE');
  });

  let nextTelegramId = 1;

  async function participantWith(
    status: PaymentStatus,
    track: Track = Track.JOB,
  ) {
    const telegramId = nextTelegramId++;
    return prisma.participant.create({
      data: {
        telegramId,
        languageCode: 'uz',
        phone: `+99890${String(telegramId).padStart(7, '0')}`,
        fullName: 'Aziz Karimov',
        birthYearOrCourse: '2003',
        direction: 'Backend',
        track,
        cvLink: track === Track.JOB ? 'https://github.com/aziz' : null,
        qrToken: randomBytes(32).toString('base64url'),
        payments: { create: { status, amount: 50_000 } },
      },
    });
  }

  describe('"not a valid code"', () => {
    it('a photo with no QR in it', async () => {
      const blank = await sharp({
        create: { width: 800, height: 600, channels: 3, background: '#888' },
      })
        .jpeg()
        .toBuffer();
      expect(await qr.decodeFromPhoto(blank)).toEqual({ kind: 'invalid' });
    });

    it('bytes that are not an image at all', async () => {
      expect(await qr.decodeFromPhoto(Buffer.from('not a jpeg'))).toEqual({
        kind: 'invalid',
      });
    });

    it('our prefix, but a token that is not in the database', async () => {
      await participantWith(PaymentStatus.paid); // someone else exists
      const photo = await photoOfText(
        qrPayload(randomBytes(32).toString('base64url')),
      );
      expect(await qr.decodeFromPhoto(photo)).toEqual({ kind: 'invalid' });
    });

    it('our prefix with no token after it', async () => {
      expect(await qr.decodeFromPhoto(await photoOfText('JEF26:'))).toEqual({
        kind: 'invalid',
      });
    });
  });

  describe('"not from this event"', () => {
    it.each(['JEF25:abc', 'https://example.com/ticket/1', 'jef26:lowercase'])(
      '%s',
      async (text) => {
        expect(await qr.decodeFromPhoto(await photoOfText(text))).toEqual({
          kind: 'other_event',
        });
      },
    );

    it('even when the token after another prefix is a real one', async () => {
      const p = await participantWith(PaymentStatus.paid);
      const photo = await photoOfText(`JEF25:${p.qrToken}`);
      expect(await qr.decodeFromPhoto(photo)).toEqual({ kind: 'other_event' });
    });
  });

  it.each([Track.JOB, Track.EDU])(
    'paid (%s): the issued QR, photographed, resolves to its participant',
    async (track) => {
      const p = await participantWith(PaymentStatus.paid, track);
      await participantWith(PaymentStatus.paid, track); // a decoy
      const photo = await asPhoto(await renderQr(p.qrToken, track));
      expect(await qr.decodeFromPhoto(photo)).toEqual({
        kind: 'ok',
        participant: {
          id: p.id,
          fullName: 'Aziz Karimov',
          direction: 'Backend',
          track,
        },
      });
    },
  );

  it.each([
    PaymentStatus.refunded,
    PaymentStatus.refund_requested,
    PaymentStatus.pending,
    PaymentStatus.expired,
  ])(
    'real participant whose payment is %s → "no longer valid", not a generic error',
    async (status) => {
      const p = await participantWith(status);
      const photo = await asPhoto(await renderQr(p.qrToken, Track.JOB));
      expect(await qr.decodeFromPhoto(photo)).toEqual({ kind: 'not_paid' });
    },
  );

  it('readQrText reads the exact payload from a JPEG photo', async () => {
    const token = randomBytes(32).toString('base64url');
    const photo = await asPhoto(await renderQr(token, Track.EDU));
    expect(await readQrText(photo)).toBe(`JEF26:${token}`);
  });

  it('downloads the largest photo size, whatever order Telegram lists them in', async () => {
    fakeBot.telegram.getFileLink.mockResolvedValue(
      new URL('https://api.telegram.org/file/botX/photo.jpg'),
    );
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    const sizes: PhotoSize[] = [
      { file_id: 'small', file_unique_id: 's', width: 90, height: 90 },
      { file_id: 'large', file_unique_id: 'l', width: 1280, height: 960 },
      { file_id: 'mid', file_unique_id: 'm', width: 320, height: 240 },
    ];
    expect(await qr.downloadLargestPhoto(sizes)).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(fakeBot.telegram.getFileLink).toHaveBeenCalledWith('large');
    fetchSpy.mockRestore();
  });
});
