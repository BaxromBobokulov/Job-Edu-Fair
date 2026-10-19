/**
 * Real-Postgres test setup: each DB spec file gets its own schema (Jest runs
 * spec files in parallel), recreated from the committed migrations every run.
 * Set SKIP_DB_TESTS=1 to skip on a machine without Postgres.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { PrismaService } from '../src/prisma/prisma.service';

const ROOT = join(__dirname, '..');

export const describeDb =
  process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

function testDatabaseUrl(schema: string): string {
  const envFile = join(ROOT, '.env');
  const base =
    process.env.DATABASE_URL ??
    (existsSync(envFile)
      ? parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
      : undefined);
  if (!base) {
    throw new Error(
      'DATABASE_URL is not set (env or .env). Start Postgres (`docker compose up -d`) or set SKIP_DB_TESTS=1.',
    );
  }
  const url = new URL(base);
  url.searchParams.set('schema', schema);
  return url.toString();
}

/**
 * Points DATABASE_URL at `schema`, drops and re-migrates it, and returns a
 * connected client. Call from `beforeAll`.
 */
export async function setUpTestDatabase(
  schema: string,
): Promise<PrismaService> {
  process.env.DATABASE_URL = testDatabaseUrl(schema);
  const prisma = new PrismaService();
  // Recreate from the committed migrations on every run, so a new NOT NULL
  // column never trips over rows left by a previous run.
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  // Pass env explicitly: Jest sandboxes process.env, so a child process
  // wouldn't see the test URL and Prisma would fall back to .env (public schema).
  execSync('npx prisma migrate deploy', {
    cwd: ROOT,
    stdio: 'pipe',
    env: { ...process.env },
  });
  await prisma.$connect();
  return prisma;
}
