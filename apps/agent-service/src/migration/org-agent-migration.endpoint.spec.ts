import { isHttpsUrl, normaliseDidcommEndpoint } from './org-agent-migration.endpoint';

describe('normaliseDidcommEndpoint', () => {
  it('returns the address in the form the relay stores', () => {
    expect(normaliseDidcommEndpoint('https://didcomm.example.com')).toBe('https://didcomm.example.com/');
    expect(normaliseDidcommEndpoint('https://didcomm.example.com:8443/didcomm')).toBe(
      'https://didcomm.example.com:8443/didcomm'
    );
  });

  it.each([
    'http://didcomm.example.com',
    'not a url',
    '',
    'https://user:pw@didcomm.example.com',
    'https://10.1.2.3',
    'https://172.20.0.1',
    'https://192.168.1.1',
    'https://169.254.169.254',
    'https://100.64.0.1',
    'https://127.0.0.1',
    'https://localhost',
    'https://agent.localhost',
    'https://agent.internal',
    'https://[::1]',
    'https://[fe80::1]',
    'https://[fd00::1]',
    'https://[::ffff:10.0.0.5]',
    'https://[::ffff:169.254.169.254]',
    'https://[64:ff9b::a00:5]'
  ])('refuses %s', (value) => {
    expect(normaliseDidcommEndpoint(value)).toBeUndefined();
  });

  it('refuses an address over 2048 characters', () => {
    expect(normaliseDidcommEndpoint(`https://didcomm.example.com/${'a'.repeat(2048)}`)).toBeUndefined();
  });

  it('accepts a public address that merely resembles a private range', () => {
    expect(normaliseDidcommEndpoint('https://172.32.0.1')).toBeDefined();
    expect(normaliseDidcommEndpoint('https://100.128.0.1')).toBeDefined();
  });
});

describe('isHttpsUrl', () => {
  it('is true only for https', () => {
    expect(isHttpsUrl('https://admin.example.com')).toBe(true);
    expect(isHttpsUrl('http://admin.example.com')).toBe(false);
    expect(isHttpsUrl('nope')).toBe(false);
  });
});
