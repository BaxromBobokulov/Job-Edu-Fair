/**
 * The QR decode runs off the event loop: several full-size HR photos decoded
 * at once must not stall the bot (jsQR alone takes ~100–200 ms per photo on
 * the main thread).
 */
import QRCode from 'qrcode';
import sharp from 'sharp';
import { readQrText } from './qr.service';

describe('QR decode thread', () => {
  jest.setTimeout(30_000);

  it('decodes 4 photos at once while the event loop keeps ticking', async () => {
    const photos = await Promise.all(
      ['JEF26:a', 'JEF26:b', 'JEF26:c', 'JEF26:d'].map(async (text) =>
        sharp({
          // Telegram's largest size; decoded at 2000×1500.
          create: {
            width: 2560,
            height: 1920,
            channels: 3,
            background: '#ccc',
          },
        })
          .composite([
            {
              input: await QRCode.toBuffer(text, { type: 'png', scale: 8 }),
              left: 900,
              top: 600,
            },
          ])
          .jpeg()
          .toBuffer(),
      ),
    );

    let maxGap = 0;
    let last = performance.now();
    const ticker = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 2);
    try {
      const texts = await Promise.all(photos.map((p) => readQrText(p)));
      expect(texts).toEqual(['JEF26:a', 'JEF26:b', 'JEF26:c', 'JEF26:d']);
    } finally {
      clearInterval(ticker);
    }
    // On the main thread this would be one ~100+ ms stall per photo.
    expect(maxGap).toBeLessThan(100);
  });
});
