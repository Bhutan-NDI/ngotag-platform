/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type, implicit-arrow-linebreak */
import { ConnectionService } from './connection.service';

const ORG_ID = 'org-issuer';

const build = (reuseDids: { invitationDid?: string; additionalInvitationDids?: string[] }) => {
  const repository = {
    getAgentEndPoint: jest.fn().mockResolvedValue({
      agentEndPoint: 'https://agent.example.com',
      id: 'agent-1',
      organisation: { name: 'Issuer', logoUrl: undefined }
    }),
    getReuseInvitationDids: jest.fn().mockResolvedValue(reuseDids),
    saveAgentConnectionInvitations: jest.fn().mockResolvedValue({ id: 'invitation-row', orgId: ORG_ID })
  };
  const service = new ConnectionService(
    {} as never,
    {} as never,
    repository as never,
    {} as never,
    { log: jest.fn(), error: jest.fn() } as never,
    {} as never
  );
  const create = jest
    .spyOn(service, '_createOutOfBandConnectionInvitation')
    .mockResolvedValue({ invitationUrl: 'https://agent.example.com/oob', outOfBandRecord: { id: 'oob-1' } } as never);
  jest.spyOn(service, 'storeConnectionObjectAndReturnUrl').mockResolvedValue('https://short.example.com/x');
  return { service, repository, create };
};

const request = (extra: object = {}) =>
  ({ createOutOfBandConnectionInvitation: { orgId: ORG_ID, IsReuseConnection: true, ...extra } }) as never;

describe('connection invitations that reuse a connection', () => {
  it('carry the new invitation DID first and the old one second for an org that moved', async () => {
    const { service, create } = build({ invitationDid: 'did:peer:new', additionalInvitationDids: ['did:peer:old'] });

    await service.createConnectionInvitation(request());

    expect(create.mock.calls[0][0]).toMatchObject({
      invitationDid: 'did:peer:new',
      additionalInvitationDids: ['did:peer:old']
    });
  });

  it('carry just the invitation DID, and no additionalInvitationDids key, for any other org', async () => {
    const { service, create } = build({ invitationDid: 'did:peer:oldest' });

    await service.createConnectionInvitation(request());

    const [[payload]] = create.mock.calls;
    expect(payload).toMatchObject({ invitationDid: 'did:peer:oldest' });
    expect(payload).not.toHaveProperty('additionalInvitationDids');
  });

  it('use an invitation DID the caller named as it is, without a lookup or a second DID', async () => {
    const { service, create, repository } = build({
      invitationDid: 'did:peer:new',
      additionalInvitationDids: ['did:peer:old']
    });

    await service.createConnectionInvitation(request({ invitationDid: 'did:peer:chosen' }));

    expect(repository.getReuseInvitationDids).not.toHaveBeenCalled();
    const [[payload]] = create.mock.calls;
    expect(payload).toMatchObject({ invitationDid: 'did:peer:chosen' });
    expect(payload).not.toHaveProperty('additionalInvitationDids');
  });

  it('look up nothing when the invitation does not reuse a connection', async () => {
    const { service, create, repository } = build({ invitationDid: 'did:peer:oldest' });

    await service.createConnectionInvitation(request({ IsReuseConnection: false }));

    expect(repository.getReuseInvitationDids).not.toHaveBeenCalled();
    const [[payload]] = create.mock.calls;
    expect(payload.invitationDid).toBeUndefined();
    expect(payload).not.toHaveProperty('additionalInvitationDids');
  });
});
