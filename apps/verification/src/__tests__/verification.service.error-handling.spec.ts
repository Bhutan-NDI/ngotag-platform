// The root jest config has no mapping for bare `apps/...` imports.
jest.mock(
  'apps/api-gateway/src/verification/enum/verification.enum',
  () => jest.requireActual('../../../api-gateway/src/verification/enum/verification.enum'),
  { virtual: true }
);

import { RpcException } from '@nestjs/microservices';
import { VerificationService } from '../verification.service';

const FROZEN = {
  message: 'ORG_AGENT_MIGRATING: the organization agent is being migrated and is temporarily unavailable',
  code: 423,
  statusCode: 423,
  error: 'ORG_AGENT_MIGRATING'
};

const thrownBy = (error: unknown): unknown => {
  const service = Object.create(VerificationService.prototype) as VerificationService;
  try {
    service.verificationErrorHandling(error);
  } catch (caught) {
    return (caught as RpcException).getError();
  }
  throw new Error('verificationErrorHandling did not throw');
};

describe('verificationErrorHandling', () => {
  it('forwards an error that did not come from the agent as it arrived, so a 423 keeps its status and code', () => {
    expect(thrownBy(FROZEN)).toEqual(FROZEN);
  });

  it('forwards the response of an exception that carries one', () => {
    const response = { statusCode: 409, message: 'already exists', error: 'Conflict' };

    expect(thrownBy({ response })).toEqual(response);
  });

  it('keeps the agent reason and status of an error wrapped from an agent call', () => {
    const error = { status: { message: { error: { reason: 'connection not found' } }, code: 404 } };

    expect(thrownBy(error)).toEqual({ message: 'connection not found', statusCode: 404 });
  });

  it('keeps the agent error text when it has no reason', () => {
    const error = { status: { message: { error: 'proof request refused' }, code: 400 } };

    expect(thrownBy(error)).toEqual({ message: 'proof request refused', statusCode: 400 });
  });

  it('does not fail on an empty rejection', () => {
    expect(() => thrownBy(undefined)).not.toThrow(TypeError);
  });
});
