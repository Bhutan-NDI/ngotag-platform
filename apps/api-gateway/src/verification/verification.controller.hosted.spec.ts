import { NotFoundException } from '@nestjs/common';
import { VerificationController } from './verification.controller';

function makeController(): { controller: VerificationController; service: Record<string, jest.Mock> } {
  const service = {
    getHostedPage: jest.fn(async () => ({ returnHost: 'rp.example.com' })),
    getHostedStatus: jest.fn(async () => ({ status: 'pending' }))
  };
  return { controller: new VerificationController(service as never, {} as never), service };
}

function makeRes(): { status: jest.Mock; json: jest.Mock; setHeader: jest.Mock } {
  const res = { status: jest.fn(), json: jest.fn(), setHeader: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe('hosted verification page routes', () => {
  const validId = 'a'.repeat(43);

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
});
