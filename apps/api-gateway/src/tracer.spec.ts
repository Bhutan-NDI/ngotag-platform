import type { IncomingMessage, RequestOptions } from 'http';
import { incomingUrlAttributes, isUntracedRequest, outgoingUrlAttributes, redactedQuery } from './tracer';

describe('isUntracedRequest', () => {
  it.each(['/api', '/api/', '/api/swagger-ui.css', '/api-json', '/api-yaml', '/api?x=1'])('skips %s', (url) => {
    expect(isUntracedRequest(url)).toBe(true);
  });

  it.each(['/v1/orgs', '/apis', '/v1/api', '/', undefined])('traces %s', (url) => {
    expect(isUntracedRequest(url)).toBe(false);
  });
});

describe('redactedQuery', () => {
  it('keeps the names and replaces every value', () => {
    expect(redactedQuery('?token=SECRET&page=2&flag')).toBe('token=[redacted]&page=[redacted]&flag');
  });

  it('replaces values that contain = or encoded characters', () => {
    expect(redactedQuery('?oob=eyJAaWQiOiI%3D%3D&x=a=b')).toBe('oob=[redacted]&x=[redacted]');
  });
});

describe('span URL attributes', () => {
  it('redacts the query of an incoming request', () => {
    const request = { url: '/v1/orgs/42/credentials?token=SECRET' } as IncomingMessage;
    expect(incomingUrlAttributes(request)).toEqual({ 'url.query': 'token=[redacted]' });
  });

  it('records nothing for an incoming request without a query', () => {
    expect(incomingUrlAttributes({ url: '/v1/orgs' } as IncomingMessage)).toEqual({});
  });

  it('drops the query of an outgoing request', () => {
    const options: RequestOptions = {
      protocol: 'https:',
      hostname: 'bucket.s3.amazonaws.com',
      path: '/f?X-Amz-Signature=S'
    };
    expect(outgoingUrlAttributes(options)).toEqual({ 'url.full': 'https://bucket.s3.amazonaws.com/f' });
  });

  it('keeps an explicit port', () => {
    const options: RequestOptions = { host: 'keycloak', port: 8080, path: '/realms/x' };
    expect(outgoingUrlAttributes(options)).toEqual({ 'url.full': 'http://keycloak:8080/realms/x' });
  });
});
