import { NotFoundException } from '@nestjs/common';
import { HOSTED_PAGE_IP_RATE_LIMIT, isWalletFetch, VerificationController } from './verification.controller';

function makeController(): { controller: VerificationController; service: Record<string, jest.Mock> } {
  const service = {
    getHostedPage: jest.fn(async () => ({ returnHost: 'rp.example.com' })),
    getHostedStatus: jest.fn(async () => ({ status: 'pending' })),
    getHostedInvitation: jest.fn(async () => 'https://agent.example/didcomm?oob=abc')
  };
  return { controller: new VerificationController(service as never, {} as never), service };
}

function makeRes(): { status: jest.Mock; json: jest.Mock; setHeader: jest.Mock; type: jest.Mock; send: jest.Mock } {
  const res = { status: jest.fn(), json: jest.fn(), setHeader: jest.fn(), type: jest.fn(), send: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.type.mockReturnValue(res);
  res.send.mockReturnValue(res);
  return res;
}

describe('hosted verification page routes', () => {
  const validId = 'a'.repeat(43);

  // The global RateLimiterGuard reads this metadata and uses its points instead of the global 50 per second.
  it.each(['getHostedPage', 'getHostedStatus', 'getHostedInvitation'] as const)(
    '%s replaces the global per-IP limit',
    (handler) => {
      expect(Reflect.getMetadata('rateLimit', VerificationController.prototype[handler])).toEqual(
        HOSTED_PAGE_IP_RATE_LIMIT
      );
    }
  );

  it('serves a valid hostedId without caching', async () => {
    const { controller, service } = makeController();
    const res = makeRes();

    await controller.getHostedStatus(validId, res as never);

    expect(service.getHostedStatus).toHaveBeenCalledWith(validId);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.json.mock.calls[0][0].data).toEqual({ status: 'pending' });
  });

  it.each(['short', `${'a'.repeat(42)}!`, 'a'.repeat(44)])(
    'answers not found for a malformed hostedId %p without calling the service',
    async (hostedId) => {
      const { controller, service } = makeController();

      await expect(controller.getHostedPage(hostedId, makeRes() as never)).rejects.toBeInstanceOf(NotFoundException);
      expect(service.getHostedPage).not.toHaveBeenCalled();
    }
  );

  describe('scan link', () => {
    const token = 'ab'.repeat(32);

    it('answers the oob URL as a bare JSON string, without caching, and marks scanned for the wallet', async () => {
      const { controller, service } = makeController();
      const res = makeRes();

      await controller.getHostedInvitation(token, 'application/json', res as never);

      expect(service.getHostedInvitation).toHaveBeenCalledWith(token, true);
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
      expect(res.type).toHaveBeenCalledWith('application/json');
      expect(res.send).toHaveBeenCalledWith(JSON.stringify('https://agent.example/didcomm?oob=abc'));
    });

    it('does not mark scanned for a browser or link preview', async () => {
      const { controller, service } = makeController();

      await controller.getHostedInvitation(token, 'text/html,*/*', makeRes() as never);

      expect(service.getHostedInvitation).toHaveBeenCalledWith(token, false);
      expect(isWalletFetch(undefined)).toBe(false);
      expect(isWalletFetch('Application/JSON')).toBe(true);
    });

    it.each(['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), `${'a'.repeat(60)}oob=`])(
      'answers not found for a malformed token %p without calling the service',
      async (bad) => {
        const { controller, service } = makeController();

        await expect(
          controller.getHostedInvitation(bad, 'application/json', makeRes() as never)
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(service.getHostedInvitation).not.toHaveBeenCalled();
      }
    );
  });
});
