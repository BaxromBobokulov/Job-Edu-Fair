import { Track } from '@prisma/client';

/** Fixed keyboard options for the "main direction" step. */
export const DIRECTIONS = [
  'Frontend',
  'Backend',
  'Mobile',
  'UI/UX',
  'QA',
  'Data Science',
  'DevOps',
  'Other',
] as const;
export type Direction = (typeof DIRECTIONS)[number];

/**
 * The single place track assignment is decided:
 * has an IT skill + portfolio/resume → Job Track, still learning → Edu Track.
 */
export function assignTrack(hasSkillAndPortfolio: boolean): Track {
  return hasSkillAndPortfolio ? Track.JOB : Track.EDU;
}

/** Each parser returns the normalized value, or null if the input is invalid. */

export function parseDirection(input: string): Direction | null {
  return DIRECTIONS.find((d) => d === input.trim()) ?? null;
}

export function parseFullName(input: string): string | null {
  const name = input.trim().replace(/\s+/g, ' ');
  if (name.length < 3 || name.length > 100) return null;
  // At least two words (first + last name), letters/apostrophes/hyphens only.
  if (!/^[\p{L}'‘’`.-]+( [\p{L}'‘’`.-]+)+$/u.test(name)) return null;
  return name;
}

export function parseBirthYearOrCourse(input: string): string | null {
  const value = input.trim();
  return value.length >= 1 && value.length <= 50 ? value : null;
}

export function parsePhone(input: string): string | null {
  const digits = input.replace(/[^\d]/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return `+${digits}`;
}

export function parseCvLink(input: string): string | null {
  const value = input.trim();
  if (value.length > 500) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}
