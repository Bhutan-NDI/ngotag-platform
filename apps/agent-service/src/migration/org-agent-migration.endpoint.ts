const MAX_ENDPOINT_LENGTH = 2048;
const PRIVATE_IPV4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./
];

// URL writes an IPv4-mapped or IPv4-compatible IPv6 literal as two hex groups.
const embeddedIpv4 = (host: string): string | undefined => {
  const match = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!match) {
    return undefined;
  }
  const high = parseInt(match[1], 16);
  const low = parseInt(match[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
};

export const isHttpsUrl = (value: string): boolean => {
  try {
    return 'https:' === new URL(value).protocol;
  } catch {
    return false;
  }
};

/**
 * The DIDComm address as the shared agent's relay will accept it (the same rules as its relay target check), in the
 * form the relay stores. Undefined when the relay would refuse it: not https, credentials in the URL, too long, or a
 * private, loopback or link-local host. Hostname literals are checked; DNS answers are not.
 */
export const normaliseDidcommEndpoint = (value: string): string | undefined => {
  if ('string' !== typeof value || '' === value || value.length > MAX_ENDPOINT_LENGTH) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if ('https:' !== url.protocol || url.username || url.password) {
    return undefined;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const ipv4 = embeddedIpv4(host) ?? host;
  const isPrivate =
    'localhost' === host ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    '::1' === host ||
    '::' === host ||
    host.startsWith('fe80:') ||
    host.startsWith('64:ff9b:') ||
    (host.startsWith('fc') && host.includes(':')) ||
    (host.startsWith('fd') && host.includes(':')) ||
    PRIVATE_IPV4.some((pattern) => pattern.test(ipv4));
  return isPrivate ? undefined : url.toString();
};
