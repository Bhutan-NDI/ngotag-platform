import { VerificationProcessState } from '@credebl/enum/enum';
import { ResponseCodeStatus } from './response-code.interface';

export function parseRedirectUriAllowlist(stored?: string | null): string[] {
  return (stored || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => 0 < entry.length);
}

/**
 * Exact origin + path-segment prefix match (not a raw string prefix), so look-alike
 * hosts and paths can't slip through.
 */
export function matchesAllowlistEntry(target: URL, allowed: string): boolean {
  let allowedUrl: URL;
  try {
    allowedUrl = new URL(allowed);
  } catch {
    return false;
  }
  if (target.origin !== allowedUrl.origin) {
    return false;
  }
  const allowedPath = allowedUrl.pathname.replace(/\/+$/, '');
  const targetPath = target.pathname.replace(/\/+$/, '');
  // An origin-only entry permits any path on that origin.
  if ('' === allowedPath) {
    return true;
  }
  return targetPath === allowedPath || targetPath.startsWith(`${allowedPath}/`);
}

export function isHttpRedirectUriAllowed(): boolean {
  return 'true' === process.env.REDIRECT_URI_ALLOW_HTTP;
}

export function hasAllowedRedirectProtocol(uri: string, allowHttp: boolean): boolean {
  try {
    const { protocol } = new URL(uri);
    return 'https:' === protocol || (allowHttp && 'http:' === protocol);
  } catch {
    return false;
  }
}

/** Fails closed on an empty allowlist, an unparseable redirectUri or a disallowed scheme. */
export function isRedirectUriAllowed(redirectUri: string, allowlist: string[], allowHttp: boolean): boolean {
  if (!hasAllowedRedirectProtocol(redirectUri, allowHttp)) {
    return false;
  }
  const target = new URL(redirectUri);
  return allowlist.some((allowed) => matchesAllowlistEntry(target, allowed));
}

export function buildReturnUrl(redirectUri: string, responseCode: string): string {
  const separator = redirectUri.includes('?') ? '&' : '?';
  return `${redirectUri}${separator}response_code=${responseCode}`;
}

/**
 * The wallet reads the invitation as everything between `url=` and `&returnUrl`,
 * so the return target must be appended last, exactly in this form.
 */
export function appendReturnUrl(deepLinkUrl: string, returnUrl: string): string {
  return `${deepLinkUrl}&returnUrl=${encodeURIComponent(returnUrl)}`;
}

export function toTerminalResponseCodeStatus(
  state: string,
  isVerified?: boolean
): ResponseCodeStatus.VERIFIED | ResponseCodeStatus.FAILED | null {
  switch (state) {
    case VerificationProcessState.DONE:
      return isVerified ? ResponseCodeStatus.VERIFIED : ResponseCodeStatus.FAILED;
    case VerificationProcessState.DECLIEND:
    case VerificationProcessState.ABANDONED:
      return ResponseCodeStatus.FAILED;
    default:
      return null;
  }
}
