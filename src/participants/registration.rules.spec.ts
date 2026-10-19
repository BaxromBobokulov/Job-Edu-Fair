import { Track } from '@prisma/client';
import {
  assignTrack,
  parseBirthYearOrCourse,
  parseCvLink,
  parseDirection,
  parseFullName,
  parsePhone,
} from './registration.rules';

describe('assignTrack', () => {
  it('sends participants with a skill + portfolio to the Job Track', () => {
    expect(assignTrack(true)).toBe(Track.JOB);
  });

  it('sends participants still learning to the Edu Track', () => {
    expect(assignTrack(false)).toBe(Track.EDU);
  });
});

describe('registration field parsers', () => {
  it.each([
    ['  Aziz   Karimov ', 'Aziz Karimov'],
    ['O‘tkir Rahimov', 'O‘tkir Rahimov'],
    ['Азиз Каримов', 'Азиз Каримов'],
  ])('accepts full name %p', (input, expected) => {
    expect(parseFullName(input)).toBe(expected);
  });

  it.each(['Aziz', '', 'Aziz 123', 'a'.repeat(60) + ' ' + 'b'.repeat(60)])(
    'rejects full name %p',
    (input) => {
      expect(parseFullName(input)).toBeNull();
    },
  );

  it('accepts only the fixed direction options', () => {
    expect(parseDirection('Backend')).toBe('Backend');
    expect(parseDirection(' UI/UX ')).toBe('UI/UX');
    expect(parseDirection('backend')).toBeNull();
    expect(parseDirection('Blockchain')).toBeNull();
  });

  it('normalizes phone numbers to +digits', () => {
    expect(parsePhone('998901234567')).toBe('+998901234567');
    expect(parsePhone('+998 90 123-45-67')).toBe('+998901234567');
    expect(parsePhone('123')).toBeNull();
  });

  it('accepts a birth year or course as short free text', () => {
    expect(parseBirthYearOrCourse(' 2003 ')).toBe('2003');
    expect(parseBirthYearOrCourse('3rd year')).toBe('3rd year');
    expect(parseBirthYearOrCourse('   ')).toBeNull();
    expect(parseBirthYearOrCourse('x'.repeat(51))).toBeNull();
  });

  it('accepts only http(s) CV links with a real host', () => {
    expect(parseCvLink('https://github.com/aziz')).toBe(
      'https://github.com/aziz',
    );
    expect(parseCvLink('github.com/aziz')).toBeNull();
    expect(parseCvLink('javascript:alert(1)')).toBeNull();
    expect(parseCvLink('http://localhost/cv')).toBeNull();
  });
});
