import {
  computePurgeDate,
  formatCalendarDate,
  isPurgeDue,
  parseEventDate,
} from './retention.service';

const purgeDateOf = (eventDate: string) => {
  const parsed = parseEventDate(eventDate);
  if (!parsed) throw new Error(`bad test date ${eventDate}`);
  return formatCalendarDate(computePurgeDate(parsed));
};

describe('retention date math', () => {
  it('parses only real YYYY-MM-DD dates', () => {
    expect(parseEventDate('2026-11-15')).toEqual({
      year: 2026,
      month: 11,
      day: 15,
    });
    expect(parseEventDate(' 2026-11-15 ')).not.toBeNull();
    for (const bad of [
      undefined,
      '',
      '   ',
      '15.11.2026',
      '2026-11-15T10:00:00Z',
      '2026-13-01',
      '2026-00-10',
      '2026-02-29', // not a leap year
      '2026-11-31',
      'next week',
    ]) {
      expect(parseEventDate(bad)).toBeNull();
    }
  });

  it('adds exactly 3 calendar months', () => {
    expect(purgeDateOf('2026-11-15')).toBe('2027-02-15');
    expect(purgeDateOf('2026-10-31')).toBe('2027-01-31'); // across the year
    expect(purgeDateOf('2026-09-30')).toBe('2026-12-30');
    expect(purgeDateOf('2026-01-01')).toBe('2026-04-01');
  });

  it('clamps to the last day of a shorter target month, never rolls past it', () => {
    expect(purgeDateOf('2026-11-30')).toBe('2027-02-28');
    expect(purgeDateOf('2027-11-30')).toBe('2028-02-29'); // leap year
    expect(purgeDateOf('2026-05-31')).toBe('2026-08-31');
    expect(purgeDateOf('2026-03-31')).toBe('2026-06-30');
  });

  it('is due from 00:00 Asia/Tashkent (UTC+5) on the purge date — not a second earlier', () => {
    const purge = computePurgeDate({ year: 2026, month: 11, day: 15 });
    // 2027-02-14 23:59:59 in Tashkent.
    expect(isPurgeDue(purge, new Date('2027-02-14T18:59:59.999Z'))).toBe(false);
    // 2027-02-15 00:00 in Tashkent.
    expect(isPurgeDue(purge, new Date('2027-02-14T19:00:00.000Z'))).toBe(true);
    // Any later day stays due (a missed run catches up).
    expect(isPurgeDue(purge, new Date('2027-06-01T12:00:00Z'))).toBe(true);
    // A day early, and on the event day itself: not due.
    expect(isPurgeDue(purge, new Date('2027-02-13T20:00:00Z'))).toBe(false);
    expect(isPurgeDue(purge, new Date('2026-11-15T12:00:00Z'))).toBe(false);
  });
});
