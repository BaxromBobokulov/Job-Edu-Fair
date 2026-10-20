import { Worker } from 'node:worker_threads';

/**
 * jsQR is synchronous and CPU-bound (~100+ ms on a full-size photo): on the
 * main thread every concurrent HR scan would stall the whole bot. The thread
 * is plain JS by eval, so the same code runs from dist/ and under ts-jest;
 * jsQR is passed as an absolute path, so cwd doesn't matter.
 */
const THREAD_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const jsQR = require(workerData.jsqrPath);
const code = jsQR(workerData.pixels, workerData.width, workerData.height);
parentPort.postMessage(code && code.data ? code.data : null);
`;

const JSQR_PATH = require.resolve('jsqr');

/**
 * The QR text in RGBA pixels, or null, decoded in a short-lived worker
 * thread. `pixels`' buffer is transferred to the thread (not copied) and is
 * unusable afterwards.
 */
export function decodeQrPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(THREAD_SOURCE, {
      eval: true,
      workerData: { jsqrPath: JSQR_PATH, pixels, width, height },
      transferList: [pixels.buffer as ArrayBuffer],
    });
    worker.once('message', (text: string | null) => resolve(text));
    worker.once('error', reject);
    // No-op once resolved; otherwise the thread died without an answer.
    worker.once('exit', (code) =>
      reject(new Error(`QR decode thread exited (code ${code})`)),
    );
  });
}
