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

/** Fails closed on an empty allowlist or an unparseable redirectUri. */
export function isRedirectUriAllowed(redirectUri: string, allowlist: string[]): boolean {
  let target: URL;
  try {
    target = new URL(redirectUri);
  } catch {
    return false;
  }
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
