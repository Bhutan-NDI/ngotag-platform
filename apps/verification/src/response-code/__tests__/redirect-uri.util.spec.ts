import {
  appendReturnUrl,
  isRedirectUriAllowed,
  parseRedirectUriAllowlist,
  toTerminalResponseCodeStatus
} from '../redirect-uri.util';
import { ResponseCodeStatus } from '../response-code.interface';

const ALLOWLIST = parseRedirectUriAllowlist(' https://rp.example.com/return , https://portal.example.org ,,');

describe('parseRedirectUriAllowlist', () => {
  it('trims entries and drops empties', () => {
    expect(ALLOWLIST).toEqual(['https://rp.example.com/return', 'https://portal.example.org']);
  });

  it('returns an empty list for null/undefined', () => {
    expect(parseRedirectUriAllowlist(null)).toEqual([]);
    expect(parseRedirectUriAllowlist(undefined)).toEqual([]);
  });
});

describe('isRedirectUriAllowed', () => {
  it('accepts an exact match', () => {
    expect(isRedirectUriAllowed('https://rp.example.com/return', ALLOWLIST)).toBe(true);
  });

  it('accepts extra query params and a trailing slash on an allowed path', () => {
    expect(isRedirectUriAllowed('https://rp.example.com/return/?session=1', ALLOWLIST)).toBe(true);
  });

  it('accepts a sub-path of an allowed path (segment boundary)', () => {
    expect(isRedirectUriAllowed('https://rp.example.com/return/step-2', ALLOWLIST)).toBe(true);
  });

  it('accepts any path on an origin-only entry', () => {
    expect(isRedirectUriAllowed('https://portal.example.org/any/path', ALLOWLIST)).toBe(true);
  });

  it('rejects a URL not in the allowlist', () => {
    expect(isRedirectUriAllowed('https://evil.example.net/return', ALLOWLIST)).toBe(false);
  });

  it('rejects a look-alike host that would pass a raw string prefix', () => {
    expect(isRedirectUriAllowed('https://rp.example.com.evil.net/return', ALLOWLIST)).toBe(false);
  });

  it('rejects a path sharing a prefix but not a segment boundary', () => {
    expect(isRedirectUriAllowed('https://rp.example.com/returnx', ALLOWLIST)).toBe(false);
  });

  it('rejects a different port or scheme on the same host', () => {
    expect(isRedirectUriAllowed('https://rp.example.com:8443/return', ALLOWLIST)).toBe(false);
    expect(isRedirectUriAllowed('http://rp.example.com/return', ALLOWLIST)).toBe(false);
  });

  it('rejects a malformed URL', () => {
    expect(isRedirectUriAllowed('not a url', ALLOWLIST)).toBe(false);
  });

  it('fails closed when the org has registered nothing', () => {
    expect(isRedirectUriAllowed('https://rp.example.com/return', [])).toBe(false);
  });

  it('ignores malformed allowlist entries', () => {
    expect(isRedirectUriAllowed('https://rp.example.com/return', ['::bad::'])).toBe(false);
  });
});

describe('appendReturnUrl', () => {
  const deepLink = 'https://link.example.id?url=https://short.example/abc';

  it('appends an encoded returnUrl carrying the response_code as the last parameter', () => {
    const result = appendReturnUrl(deepLink, 'https://rp.example.com/return', 'tok_123');
    expect(result).toBe(
      `${deepLink}&returnUrl=${encodeURIComponent('https://rp.example.com/return?response_code=tok_123')}`
    );
  });

  it('uses & when the redirectUri already has a query string', () => {
    const result = appendReturnUrl(deepLink, 'https://rp.example.com/return?a=1', 'tok_123');
    expect(decodeURIComponent(result.split('&returnUrl=')[1])).toBe(
      'https://rp.example.com/return?a=1&response_code=tok_123'
    );
  });

  it('keeps the invitation url recoverable the way the wallet reads it (between url= and &returnUrl)', () => {
    const result = appendReturnUrl(deepLink, 'https://rp.example.com/return', 'tok_123');
    const start = result.indexOf('url=') + 4;
    expect(result.substring(start, result.indexOf('&returnUrl'))).toBe('https://short.example/abc');
  });
});

describe('toTerminalResponseCodeStatus', () => {
  it('maps done + isVerified to verified', () => {
    expect(toTerminalResponseCodeStatus('done', true)).toBe(ResponseCodeStatus.VERIFIED);
  });

  it('maps done without verification, declined and abandoned to failed', () => {
    expect(toTerminalResponseCodeStatus('done', false)).toBe(ResponseCodeStatus.FAILED);
    expect(toTerminalResponseCodeStatus('declined')).toBe(ResponseCodeStatus.FAILED);
    expect(toTerminalResponseCodeStatus('abandoned')).toBe(ResponseCodeStatus.FAILED);
  });

  it('treats intermediate states as non-terminal', () => {
    expect(toTerminalResponseCodeStatus('request-sent')).toBeNull();
    expect(toTerminalResponseCodeStatus('presentation-received')).toBeNull();
  });
});
