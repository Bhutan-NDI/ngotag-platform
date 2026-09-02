/**
 * Regression test for trim()'s non-string fallback (#84 review, second finding). Previously
 * returned `undefined` implicitly for any non-string input, which combined with @IsOptional()
 * silently wiped boolean/int DTO fields on every request with zero validation error -- the root
 * cause behind the receive-invitation-url boolean-wiping bug this PR's first commit fixed
 * symptomatically (by removing @Transform(trim) from the 4 affected fields in that one DTO).
 */
import { trim } from './cast.helper';

describe('trim', () => {
  it('trims a real string', () => {
    expect(trim('  hello  ')).toBe('hello');
  });

  it('returns non-string input unchanged instead of coercing it to undefined', () => {
    expect(trim(true as never)).toBe(true);
    expect(trim(false as never)).toBe(false);
    expect(trim(42 as never)).toBe(42);
    expect(trim(0 as never)).toBe(0);
  });

  it('passes through null/undefined unchanged', () => {
    expect(trim(null as never)).toBeNull();
    expect(trim(undefined as never)).toBeUndefined();
  });
});
