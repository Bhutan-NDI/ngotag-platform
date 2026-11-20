import { ConnectionService } from './connection.service';

const SAVED_ORG_ID = 'tenant-org';

function build(save: jest.Mock = jest.fn(async () => ({ id: 'row-1', orgId: SAVED_ORG_ID }))): {
  service: ConnectionService;
  sendNatsMessage: jest.Mock;
  save: jest.Mock;
} {
  const sendNatsMessage = jest.fn(async () => undefined);
  const service = new ConnectionService(
    {} as never,
    {} as never,
    { saveConnectionWebhook: save } as never,
    {} as never,
    { log: jest.fn(), error: jest.fn(), debug: jest.fn() } as never,
    { sendNatsMessage } as never
  );
  return { service, sendNatsMessage, save };
}

function scanCall(sendNatsMessage: jest.Mock): unknown {
  const call = sendNatsMessage.mock.calls.find(([, cmd]) => 'hosted-verification-scanned' === cmd);
  return call?.[2];
}

describe('ConnectionService: hosted page scan signal (DL-016)', () => {
  it('sends the invitation of a new connection, with the org the save resolved', async () => {
    const { service, sendNatsMessage } = build();

    await service.getConnectionWebhook({
      connectionDto: { id: 'conn-1', state: 'request-received', outOfBandId: 'oob-new' } as never,
      orgId: 'webhook-url-org'
    });

    expect(scanCall(sendNatsMessage)).toEqual({ outOfBandId: 'oob-new', orgId: SAVED_ORG_ID });
  });

  it('sends the scanned invitation of a reused connection, not the one the connection was first made from', async () => {
    const { service, sendNatsMessage } = build();

    // HandshakeReused: the connection keeps its original outOfBandId; outOfBandRecord is the invitation just scanned.
    // This is also the shape when the org reuses its public invitation DID.
    await service.getConnectionWebhook({
      connectionDto: {
        id: 'conn-1',
        state: 'completed',
        outOfBandId: 'oob-original',
        outOfBandRecord: { id: 'oob-scanned' },
        reuseThreadId: 'reuse-1'
      } as never,
      orgId: 'webhook-url-org'
    });

    expect(scanCall(sendNatsMessage)).toEqual({ outOfBandId: 'oob-scanned', orgId: SAVED_ORG_ID });
  });

  it('still answers the webhook when the signal cannot be delivered', async () => {
    const { service, sendNatsMessage } = build();
    sendNatsMessage.mockRejectedValue(new Error('verification service down'));

    await expect(
      service.getConnectionWebhook({ connectionDto: { id: 'c', outOfBandId: 'oob' } as never, orgId: 'o' })
    ).resolves.toEqual({ id: 'row-1', orgId: SAVED_ORG_ID });
  });

  it('sends nothing without an invitation id or when the connection could not be saved', async () => {
    const noInvitation = build();
    await noInvitation.service.getConnectionWebhook({ connectionDto: { id: 'c' } as never, orgId: 'o' });
    expect(scanCall(noInvitation.sendNatsMessage)).toBeUndefined();

    const failedSave = build(jest.fn(async () => Promise.reject(new Error('db down'))));
    await expect(
      failedSave.service.getConnectionWebhook({ connectionDto: { id: 'c', outOfBandId: 'oob' } as never, orgId: 'o' })
    ).rejects.toBeDefined();
    expect(scanCall(failedSave.sendNatsMessage)).toBeUndefined();
  });
});
