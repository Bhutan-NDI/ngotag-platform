/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type, no-mixed-operators */
import { HttpException } from '@nestjs/common';
import { StepUpAuthGuard } from './step-up.guard';

const SECOND = 1000;
const contextFor = (user: unknown) => ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as never;
const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * SECOND);

const userToken = (overrides: Record<string, unknown> = {}) => ({
  id: 'user-1',
  sub: 'keycloak-1',
  sid: 'session-1',
  sessionCreatedAt: secondsAgo(30),
  ...overrides
});

const refusal = (user: unknown) => {
  try {
    new StepUpAuthGuard().canActivate(contextFor(user));
  } catch (error) {
    return error as HttpException;
  }
  return undefined;
};

afterEach(() => {
  delete process.env.STEP_UP_MAX_AGE_SECONDS;
});

describe('StepUpAuthGuard', () => {
  it('lets a user whose session was created moments ago through', () => {
    expect(new StepUpAuthGuard().canActivate(contextFor(userToken()))).toBe(true);
  });

  it('accepts a session created just inside the five-minute window', () => {
    expect(new StepUpAuthGuard().canActivate(contextFor(userToken({ sessionCreatedAt: secondsAgo(295) })))).toBe(true);
  });

  it('accepts a created-at that arrived as an ISO string, as it does over NATS', () => {
    const user = userToken({ sessionCreatedAt: secondsAgo(10).toISOString() });

    expect(new StepUpAuthGuard().canActivate(contextFor(user))).toBe(true);
  });

  it('refuses a session older than five minutes with 401 STEP_UP_REQUIRED', () => {
    const error = refusal(userToken({ sessionCreatedAt: secondsAgo(301) }));

    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(401);
    expect(error.getResponse()).toMatchObject({ statusCode: 401, error: 'STEP_UP_REQUIRED' });
    expect(error.message).toContain('STEP_UP_REQUIRED');
  });

  it.each([
    ['there is no session id', userToken({ sid: undefined })],
    ['there is no session creation time', userToken({ sessionCreatedAt: undefined })],
    ['the session creation time is not a date', userToken({ sessionCreatedAt: 'not-a-date' })],
    ['it is a service token', userToken({ client_id: 'service-client' })],
    ['it is an organisation client token', userToken({ client_id: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })],
    ['there is no user at all', undefined]
  ])('refuses when %s', (_name, user) => {
    expect(refusal(user)?.getResponse()).toMatchObject({ error: 'STEP_UP_REQUIRED' });
  });

  it('refuses a session created in the future beyond clock skew', () => {
    expect(refusal(userToken({ sessionCreatedAt: new Date(Date.now() + 10 * 60 * SECOND) }))).toBeDefined();
  });

  it('tolerates a few seconds of clock skew', () => {
    expect(
      new StepUpAuthGuard().canActivate(contextFor(userToken({ sessionCreatedAt: new Date(Date.now() + 5 * SECOND) })))
    ).toBe(true);
  });

  it('uses a window from STEP_UP_MAX_AGE_SECONDS when it is a positive whole number', () => {
    process.env.STEP_UP_MAX_AGE_SECONDS = '60';

    expect(refusal(userToken({ sessionCreatedAt: secondsAgo(90) }))).toBeDefined();
    expect(refusal(userToken({ sessionCreatedAt: secondsAgo(30) }))).toBeUndefined();
  });

  it.each(['0', '-5', 'soon', '1.5'])('ignores an invalid STEP_UP_MAX_AGE_SECONDS of %s', (value) => {
    process.env.STEP_UP_MAX_AGE_SECONDS = value;

    expect(refusal(userToken({ sessionCreatedAt: secondsAgo(200) }))).toBeUndefined();
    expect(refusal(userToken({ sessionCreatedAt: secondsAgo(400) }))).toBeDefined();
  });
});
