import { Logger } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';

export interface JobQueueOptions {
  /** Total tries per job, the first included. */
  attempts: number;
  /** Exponential backoff base between tries. */
  backoffMs: number;
  /** Jobs processed at once by this process's worker. */
  concurrency: number;
  /** BullMQ rate limit: at most `max` jobs per `duration` ms (all workers). */
  limiter?: { max: number; duration: number };
  /** Jobs processed at once across every worker on every instance. */
  globalConcurrency?: number;
}

export type JobHandler<T> = (data: T) => Promise<void>;

/**
 * A named job queue. `add` never throws and never waits on Redis: callers
 * enqueue right after their Postgres write committed, and a queue problem
 * must not fail or delay that write.
 */
export interface JobQueue<T> {
  readonly name: string;
  add(data: T): void;
  /** Starts consuming jobs in this process. Without it jobs just wait. */
  process(handler: JobHandler<T>): void;
  close(): Promise<void>;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * Connection-level errors (Redis down, client missing) carry no job data, so
 * their message is safe to log — and without it "Error" is undiagnosable.
 */
function connectionError(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  // A refused dual-stack connect (::1 + 127.0.0.1) is an AggregateError with
  // an empty message; the detail is in the inner errors.
  const detail =
    err instanceof AggregateError
      ? err.errors.map((e: unknown) => connectionError(e)).join('; ')
      : err.message;
  return `${err.name}: ${detail}`;
}

/** Redis-backed (BullMQ): persistent, retried with backoff, failed jobs kept. */
export class BullJobQueue<T extends object> implements JobQueue<T> {
  private readonly logger: Logger;
  private readonly queue: Queue;
  private worker?: Worker;

  constructor(
    readonly name: string,
    private readonly redisUrl: string,
    private readonly options: JobQueueOptions,
  ) {
    this.logger = new Logger(`Queue:${name}`);
    this.queue = new Queue(name, {
      connection: { url: redisUrl },
      defaultJobOptions: {
        attempts: options.attempts,
        backoff: { type: 'exponential', delay: options.backoffMs },
        removeOnComplete: { count: 1000 },
        // Kept for inspection / manual retry — never silently dropped.
        removeOnFail: false,
      },
    });
    this.queue.on('error', (err) =>
      this.logger.error(`Redis error: ${connectionError(err)}`),
    );
    if (options.globalConcurrency !== undefined) {
      this.queue
        .setGlobalConcurrency(options.globalConcurrency)
        .catch((err: unknown) =>
          this.logger.error(
            `setGlobalConcurrency failed: ${connectionError(err)}`,
          ),
        );
    }
  }

  add(data: T): void {
    this.queue.add(this.name, data).catch((err: unknown) => {
      this.logger.error(
        `Enqueue FAILED (${errorName(err)}): ${JSON.stringify(data)}`,
      );
    });
  }

  process(handler: JobHandler<T>): void {
    if (this.worker) throw new Error(`${this.name} already has a worker`);
    this.worker = new Worker(this.name, (job: Job<T>) => handler(job.data), {
      // A blocking worker connection must retry forever (BullMQ requirement).
      connection: { url: this.redisUrl, maxRetriesPerRequest: null },
      concurrency: this.options.concurrency,
      ...(this.options.limiter && { limiter: this.options.limiter }),
    });
    this.worker.on('error', (err) =>
      this.logger.error(`Worker error: ${connectionError(err)}`),
    );
    this.worker.on('failed', (job, err) => {
      if (!job) return;
      const final = job.attemptsMade >= (job.opts.attempts ?? 1);
      const message = `Job ${job.id} attempt ${job.attemptsMade} failed: ${errorName(err)}`;
      if (final) {
        this.logger.error(`${message} — no retries left, kept in failed set`);
      } else {
        this.logger.warn(`${message} — will retry`);
      }
    });
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}

/**
 * In-process stand-in when REDIS_URL isn't set (tests, local dev without
 * Redis): FIFO, at most `concurrency` jobs at once, one try, no persistence.
 * Never used in production — see createJobQueue.
 */
export class InlineJobQueue<T> implements JobQueue<T> {
  private readonly logger: Logger;
  private handler?: JobHandler<T>;
  private readonly waiting: T[] = [];
  private readonly running = new Set<Promise<void>>();

  constructor(
    readonly name: string,
    private readonly concurrency = 1,
  ) {
    this.logger = new Logger(`Queue:${name}`);
  }

  add(data: T): void {
    if (!this.handler) {
      this.logger.debug('No worker in this process: job dropped (inline mode)');
      return;
    }
    this.waiting.push(data);
    // Next tick, like a real queue: the caller never runs the job itself.
    setImmediate(() => this.drain());
  }

  process(handler: JobHandler<T>): void {
    if (this.handler) throw new Error(`${this.name} already has a worker`);
    this.handler = handler;
  }

  /** Resolves once every job added so far (and any they add) has finished. */
  async idle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    while (this.running.size > 0 || this.waiting.length > 0) {
      await Promise.all([...this.running]);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  close(): Promise<void> {
    return this.idle();
  }

  private drain(): void {
    const handler = this.handler;
    while (handler && this.running.size < this.concurrency) {
      const data = this.waiting.shift();
      if (data === undefined) return;
      const run = handler(data)
        .catch((err: unknown) =>
          this.logger.error(
            `Job failed (inline, not retried): ${errorName(err)}`,
          ),
        )
        .finally(() => {
          this.running.delete(run);
          this.drain();
        });
      this.running.add(run);
    }
  }
}

/**
 * BullMQ when REDIS_URL is set; otherwise the inline queue, which production
 * refuses — event-day writes need Redis' persistence and retries. Tests are
 * always inline: Prisma loads .env into process.env, so a dev REDIS_URL
 * would otherwise leak into them.
 */
export function createJobQueue<T extends object>(
  name: string,
  redisUrl: string | undefined,
  options: JobQueueOptions,
  nodeEnv: string | undefined,
): JobQueue<T> {
  if (nodeEnv === 'test') {
    return new InlineJobQueue<T>(name, options.concurrency);
  }
  if (redisUrl) return new BullJobQueue<T>(name, redisUrl, options);
  if (nodeEnv === 'production') {
    throw new Error(`REDIS_URL is required in production (queue ${name})`);
  }
  new Logger(`Queue:${name}`).warn(
    'REDIS_URL not set: running in-process — no persistence, no retries (dev only)',
  );
  return new InlineJobQueue<T>(name, options.concurrency);
}
