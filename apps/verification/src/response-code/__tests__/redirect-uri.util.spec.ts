import {
  appendReturnUrl,
  buildReturnUrl,
  hasAllowedRedirectProtocol,
  isHttpRedirectUriAllowed,
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
    expect(isRedirectUriAllowed('https://rp.example.com/return', ALLOWLIST, false)).toBe(true);
  });

  it('accepts extra query params and a trailing slash on an allowed path', () => {
    expect(isRedirectUriAllowed('https://rp.example.com/return/?session=1', ALLOWLIST, false)).toBe(true);
  });

  it('accepts a sub-path of an allowed path (segment boundary)', () => {
    expect(isRedirectUriAllowed('https://rp.example.com/return/step-2', ALLOWLIST, false)).toBe(true);
  });

  it('accepts any path on an origin-only entry', () => {
    expect(isRedirectUriAllowed('https://portal.example.org/any/path', ALLOWLIST, false)).toBe(true);
  });

  it('rejects a URL not in the allowlist', () => {
    expect(isRedirectUriAllowed('https://evil.example.net/return', ALLOWLIST, false)).toBe(false);
  });

  it('rejects a look-alike host that would pass a raw string prefix', () => {
    expect(isRedirectUriAllowed('https://rp.example.com.evil.net/return', ALLOWLIST, false)).toBe(false);
  });

  it('rejects a path sharing a prefix but not a segment boundary', () => {
    expect(isRedirectUriAllowed('https://rp.example.com/returnx', ALLOWLIST, false)).toBe(false);
  });

  it('rejects a different port or scheme on the same host', () => {
    expect(isRedirectUriAllowed('https://rp.example.com:8443/return', ALLOWLIST, false)).toBe(false);
    expect(isRedirectUriAllowed('http://rp.example.com/return', ALLOWLIST, false)).toBe(false);
  });

  it('rejects a malformed URL', () => {
    expect(isRedirectUriAllowed('not a url', ALLOWLIST, false)).toBe(false);
  });

  it('fails closed when the org has registered nothing', () => {
    expect(isRedirectUriAllowed('https://rp.example.com/return', [], false)).toBe(false);
  });

  it('ignores malformed allowlist entries', () => {
    expect(isRedirectUriAllowed('https://rp.example.com/return', ['::bad::'], false)).toBe(false);
  });
});

describe('redirect URI scheme', () => {
  const httpAllowlist = ['http://localhost:3000/return'];

  it('rejects an http redirectUri by default, even when registered', () => {
    expect(isRedirectUriAllowed('http://localhost:3000/return', httpAllowlist, false)).toBe(false);
  });

  it('accepts a registered http redirectUri when http is allowed', () => {
    expect(isRedirectUriAllowed('http://localhost:3000/return', httpAllowlist, true)).toBe(true);
  });

  it('only permits https, or http when allowed', () => {
    expect(hasAllowedRedirectProtocol('https://rp.example.com', false)).toBe(true);
    expect(hasAllowedRedirectProtocol('http://rp.example.com', false)).toBe(false);
    expect(hasAllowedRedirectProtocol('http://rp.example.com', true)).toBe(true);
    expect(hasAllowedRedirectProtocol('bhutanndi://data', true)).toBe(false);
    expect(hasAllowedRedirectProtocol('javascript:alert(1)', true)).toBe(false);
    expect(hasAllowedRedirectProtocol('not a url', true)).toBe(false);
  });

  describe('isHttpRedirectUriAllowed', () => {
    const original = process.env.REDIRECT_URI_ALLOW_HTTP;
    afterEach(() => {
      if (undefined === original) {
        delete process.env.REDIRECT_URI_ALLOW_HTTP;
      } else {
        process.env.REDIRECT_URI_ALLOW_HTTP = original;
      }
    });

    it('is false unless REDIRECT_URI_ALLOW_HTTP is exactly "true"', () => {
      delete process.env.REDIRECT_URI_ALLOW_HTTP;
      expect(isHttpRedirectUriAllowed()).toBe(false);
      process.env.REDIRECT_URI_ALLOW_HTTP = 'false';
      expect(isHttpRedirectUriAllowed()).toBe(false);
      process.env.REDIRECT_URI_ALLOW_HTTP = 'true';
      expect(isHttpRedirectUriAllowed()).toBe(true);
    });
  });
});

describe('appendReturnUrl', () => {
  const deepLink = 'https://link.example.id?url=https://short.example/abc';
  const returnUrl = 'https://rp.example.com/return?response_code=tok_123';

  it('appends the encoded returnUrl as the last parameter', () => {
    expect(appendReturnUrl(deepLink, returnUrl)).toBe(`${deepLink}&returnUrl=${encodeURIComponent(returnUrl)}`);
  });

  it('keeps the invitation url recoverable the way the wallet reads it (between url= and &returnUrl)', () => {
    const result = appendReturnUrl(deepLink, returnUrl);
    const start = result.indexOf('url=') + 4;
    expect(result.substring(start, result.indexOf('&returnUrl'))).toBe('https://short.example/abc');
  });
});

describe('buildReturnUrl', () => {
  it('adds response_code as a query parameter', () => {
    expect(buildReturnUrl('https://rp.example.com/return', 'tok_123')).toBe(
      'https://rp.example.com/return?response_code=tok_123'
    );
  });

  it('uses & when the redirectUri already has a query string', () => {
    expect(buildReturnUrl('https://rp.example.com/return?a=1', 'tok_123')).toBe(
      'https://rp.example.com/return?a=1&response_code=tok_123'
    );
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
