import { VerifierUserService } from './verifier-user.service';

// Role checks read a Keycloak token; these tests are about the credential offer, not the role.
jest.mock('../common/keycloak-roles.util', () => ({ assertRole: jest.fn() }));

const ORG_ID = 'org-1';

function offeredProofType(primaryDid: string): Promise<string> {
  const natsClient = { sendNatsMessage: jest.fn().mockResolvedValue({}) };
  const prismaService = {
    organisation: { findFirst: jest.fn().mockResolvedValue({ name: 'Org' }) },
    // eslint-disable-next-line camelcase -- Prisma model name
    org_dids: { findFirst: jest.fn().mockResolvedValue({ did: primaryDid }) }
  };
  const service = new VerifierUserService(
    prismaService as never,
    {} as never,
    natsClient as never,
    {} as never,
    { getWebhook: jest.fn().mockResolvedValue({ webhookUrl: 'https://client.example.com' }) } as never,
    { getVerifierRoleByWhere: jest.fn().mockResolvedValue({ id: 'role-1', role: 'Gate' }) } as never
  );
  jest.spyOn(service as never, 'resolveWebhookAuthHeader').mockResolvedValue('Bearer token' as never);
  jest
    .spyOn(service as never, 'getExternalVerifierUser')
    .mockResolvedValue({ id: 'user-1', email: 'user@example.com', verifierRoleId: 'role-1', statusId: 3 } as never);

  return service.sendCredentialIssuance('user-1', ORG_ID, 'Bearer jwt').then(() => {
    const [[, , { outOfBandCredentialDto }]] = natsClient.sendNatsMessage.mock.calls;
    const [offer] = outOfBandCredentialDto.credentialOffer;
    return offer.options.proofType;
  });
}

describe('VerifierUserService.sendCredentialIssuance', () => {
  beforeAll(() => {
    process.env.MOBILE_VERIFIER_SCHEMA_URL = 'https://schema.example.com/mobile-verifier';
  });

  // Was Ed25519Signature2018 for every org, which a polygon or did:ethr primary DID cannot sign.
  it.each([
    [
      'did:ethr:sepolia:0x025685d7548c6e21bfa56249594aba0ee7f9cfe810e3909d0c0e8a8bbb86244f9c',
      'EcdsaSecp256k1Signature2019'
    ],
    ['did:polygon:testnet:0x4a09b8CB511cca4Ca1c5dB0475D0e07bFc96EF47', 'EcdsaSecp256k1Signature2019'],
    ['did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', 'Ed25519Signature2018']
  ])('offers a credential signed by a %s primary DID with %s', async (primaryDid, proofType) => {
    await expect(offeredProofType(primaryDid)).resolves.toBe(proofType);
  });
});
