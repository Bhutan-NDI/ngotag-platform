import { of } from 'rxjs';
import { NATSClient } from './NATSClient';
import { ISSUANCE_DEADLINE_HEADER } from '../../context/src/issuanceDeadline';

it.each(['sendNats', 'sendNatsMessage'] as const)(
  'propagates the original gateway deadline through %s',
  async (method) => {
    const deadline = Date.now() + 2000;
    const service = new NATSClient({ getContextId: () => 'test', get: () => deadline } as never);
    const send = jest.fn(() => of('ok'));
    await service[method]({ send } as never, 'send-credential-create-offer-oob', { synthetic: true });
    const record = (send.mock.calls as unknown[][])[0][1] as { headers: { get: (name: string) => string } };
    expect(record.headers.get(ISSUANCE_DEADLINE_HEADER)).toBe(String(deadline));
  }
);

it('does not reset an expired deadline or send expired work', () => {
  const service = new NATSClient({ getContextId: () => 'test', get: () => Date.now() - 1 } as never);
  const send = jest.fn();
  expect(() => service.sendNatsMessage({ send }, 'send-credential-create-offer', {})).toThrow('expired');
  expect(send).not.toHaveBeenCalled();
});

it('does not apply interactive deadlines to durable bulk commands', async () => {
  const service = new NATSClient({ getContextId: () => 'test', get: () => Date.now() - 1 } as never);
  const send = jest.fn(() => of('queued'));
  await service.sendNatsMessage({ send } as never, 'issue-bulk-credentials', {});
  const record = (send.mock.calls as unknown[][])[0][1] as { headers: { get: (name: string) => string } };
  expect(record.headers.get(ISSUANCE_DEADLINE_HEADER)).toBe('');
});
