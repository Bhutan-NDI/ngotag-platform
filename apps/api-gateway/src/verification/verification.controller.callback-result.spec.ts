import { HttpStatus } from '@nestjs/common';
import { VerificationController } from './verification.controller';

function makeController(callbackResult: object): VerificationController {
  const verificationService = { getProofCallbackResult: jest.fn(async () => callbackResult) };
  return new VerificationController(verificationService as never, {} as never);
}

function makeRes(): { status: jest.Mock; json: jest.Mock; setHeader: jest.Mock } {
  const res = { status: jest.fn(), json: jest.fn(), setHeader: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe('GET /verification/callback-result', () => {
  it('returns an expired request outcome (with threadId) as 200', async () => {
    const callbackResult = { status: 'expired', threadId: 'thread-1', result: { state: 'abandoned' } };
    const res = makeRes();

    await makeController(callbackResult).getProofCallbackResult('code', res as never);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(res.json.mock.calls[0][0].data).toEqual(callbackResult);
  });

  it('returns 410 for an unknown or already used response_code', async () => {
    const res = makeRes();

    await makeController({ status: 'expired' }).getProofCallbackResult('code', res as never);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.GONE);
  });
});
