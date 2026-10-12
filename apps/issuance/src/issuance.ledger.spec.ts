/**
 * Ledger checks on every issuance entry point, through the real IssuanceController and IssuanceService
 * over Nest's RPC pipeline (only the database, agent and storage are faked), over drifted ledger data.
 */
import { Test } from '@nestjs/testing';
import { INestMicroservice, Logger } from '@nestjs/common';
import { IssuanceController } from './issuance.controller';
import { IssuanceService } from './issuance.service';
import { IssuanceWorkCoordinator } from './issuance-work.coordinator';
import { InMemoryTransport } from '../test/in-memory-transport';
import { ResponseMessages } from '@credebl/common/response-messages';

jest.mock('socket.io-client', () => ({ io: jest.fn(() => ({ emit: jest.fn() })) }));
jest.mock('cache-manager-ioredis-yet', () => ({ redisStore: jest.fn() }));
jest.mock('../../api-gateway/src/helper-files/file-operation.helper', () => ({
  createFile: jest.fn().mockResolvedValue(undefined),
  checkIfFileOrDirectoryExists: jest.fn().mockReturnValue(true)
}));
// The real gateway DTO imports this enum through a path alias the Jest config does not map.
jest.mock(
  'apps/connection/src/enum/connection.enum',
  () => jest.requireActual('../../connection/src/enum/connection.enum'),
  { virtual: true }
);

const ORG_ID = 'org-issuer';
const OTHER_ORG_ID = 'org-other';
const TEMPLATE_URL = 'https://schema.example.com/schemas/bank-account';
const W3C_CONTEXT = 'https://www.w3.org/2018/credentials/v1';
const MISMATCH = ResponseMessages.issuance.error.ledgerMismatched;

const LEDGERS: Record<string, string> = {
  'polygon:testnet': 'ledger-polygon-testnet',
  'polygon:mainnet': 'ledger-polygon-mainnet',
  'ethr:sepolia': 'ledger-ethr-sepolia',
  'bcovrin:testnet': 'ledger-bcovrin-testnet',
  'indicio:testnet': 'ledger-indicio-testnet'
};
// The Not_Applicable row (namespace no_ledger) that pre-#76 code wrote for did:ethr agents.
const NO_LEDGER_ID = 'ledger-none';

interface Agent {
  orgId: string;
  orgDid: string;
  ledgerId: string | null;
}

interface TemplateRow {
  orgId: string;
  publisherDid: string;
  ledgerId: string | null;
  schemaLedgerId: string;
  name: string;
  attributes: string;
}

const template = (overrides: Partial<TemplateRow>): TemplateRow => ({
  orgId: ORG_ID,
  publisherDid: 'did:polygon:testnet:0xissuer',
  ledgerId: null,
  schemaLedgerId: TEMPLATE_URL,
  name: 'Bank Account',
  attributes: JSON.stringify([{ attributeName: 'name', schemaDataType: 'string', isRequired: true }]),
  ...overrides
});

// What STAGE had before the data repair, and what PROD and older environments still have.
const DRIFTED_DATA: [string, Agent, TemplateRow[]][] = [
  [
    'a did:ethr agent left on no_ledger by the pre-#76 setPrimaryDid',
    { orgId: ORG_ID, orgDid: 'did:ethr:sepolia:0xissuer', ledgerId: NO_LEDGER_ID },
    [template({ publisherDid: 'did:ethr:sepolia:0xissuer', ledgerId: LEDGERS['ethr:sepolia'] })]
  ],
  [
    'a did:polygon agent with a NULL ledger',
    { orgId: ORG_ID, orgDid: 'did:polygon:testnet:0xissuer', ledgerId: null },
    [template({ ledgerId: LEDGERS['polygon:testnet'] })]
  ],
  [
    'a W3C template with a NULL ledger',
    { orgId: ORG_ID, orgDid: 'did:polygon:testnet:0xissuer', ledgerId: LEDGERS['polygon:testnet'] },
    [template({ ledgerId: null })]
  ],
  [
    "another org's row for the same template URL on another ledger",
    { orgId: ORG_ID, orgDid: 'did:polygon:testnet:0xissuer', ledgerId: LEDGERS['polygon:testnet'] },
    [
      template({ orgId: OTHER_ORG_ID, publisherDid: 'did:ethr:sepolia:0xother', ledgerId: LEDGERS['ethr:sepolia'] }),
      template({ ledgerId: LEDGERS['polygon:testnet'] })
    ]
  ],
  [
    "another org's row for the same template URL with a NULL ledger",
    { orgId: ORG_ID, orgDid: 'did:ethr:sepolia:0xissuer', ledgerId: LEDGERS['ethr:sepolia'] },
    [template({ orgId: OTHER_ORG_ID, publisherDid: 'did:polygon:testnet:0xother', ledgerId: null })]
  ],
  [
    'an org that moved to did:ethr issuing a template it published under did:polygon',
    { orgId: ORG_ID, orgDid: 'did:ethr:sepolia:0xissuer', ledgerId: LEDGERS['ethr:sepolia'] },
    [template({ ledgerId: LEDGERS['polygon:testnet'] })]
  ]
];

function credential(): object {
  return {
    '@context': [W3C_CONTEXT, TEMPLATE_URL],
    type: ['VerifiableCredential', 'Bank Account'],
    issuer: { id: 'did:polygon:testnet:0xissuer' },
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: 'did:key:holder', name: 'Synthetic' }
  };
}

const options = { proofType: 'EcdsaSecp256k1Signature2019', proofPurpose: 'assertionMethod' };

interface Fixture {
  app: INestMicroservice;
  transport: InMemoryTransport;
  service: IssuanceService;
  repository: Record<string, jest.Mock>;
  storageService: { getFileByKey: jest.Mock };
  agentCalls: Record<string, jest.SpyInstance>;
}

async function start(agent: Agent, rows: TemplateRow[]): Promise<Fixture> {
  const repository = {
    getAgentEndPoint: jest.fn().mockResolvedValue({
      ...agent,
      agentEndPoint: 'https://agent.example.com',
      orgAgentTypeId: 'dedicated',
      organisation: { name: 'Issuer', logoUrl: '' }
    }),
    getOrgAgentType: jest.fn().mockResolvedValue({ agent: 'DEDICATED' }),
    getSchemaDetails: jest.fn().mockResolvedValue(rows[0] ?? null),
    getSchemaDetailsBySchemaIdentifier: jest.fn().mockResolvedValue(rows[0] ?? null),
    getLedgerIdByNamespace: jest.fn((namespace: string) => Promise.resolve(LEDGERS[namespace] ?? null)),
    getOrganization: jest.fn().mockResolvedValue({ name: 'Issuer' }),
    updateSchemaIdByThreadId: jest.fn().mockResolvedValue({}),
    getCredentialDefinitionDetails: jest.fn(),
    getInvitationDidByOrgId: jest.fn().mockResolvedValue(null)
  };
  const storageService = { getFileByKey: jest.fn().mockRejectedValue(new Error('storage reached')) };
  const coordinator = {
    offerConcurrency: 2,
    interactive: jest.fn((_deadline: unknown, work: () => unknown) => work())
  };
  const service = new IssuanceService(
    {} as never,
    {} as never,
    repository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    storageService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    coordinator as never
  );
  // Template rows for every URL in the offer, whichever org owns them (ledger service lookup).
  jest.spyOn(service, '_getSchemaDetails').mockResolvedValue(rows as never);
  jest.spyOn(service, 'getW3CSchemaAttributes').mockResolvedValue([] as never);
  const agentCalls = {
    offer: jest.spyOn(service, '_sendCredentialCreateOffer').mockResolvedValue({ threadId: 'thread-1' } as never),
    outOfBand: jest
      .spyOn(service, '_outOfBandCredentialOffer')
      .mockResolvedValue({ response: { invitationUrl: 'https://agent.example.com/oob' } } as never),
    email: jest.spyOn(service, 'sendEmailForCredentialOffer').mockResolvedValue(true)
  };

  const moduleRef = await Test.createTestingModule({
    controllers: [IssuanceController],
    providers: [
      { provide: IssuanceService, useValue: service },
      { provide: IssuanceWorkCoordinator, useValue: coordinator }
    ]
  }).compile();
  const transport = new InMemoryTransport();
  const app = moduleRef.createNestMicroservice({ strategy: transport });
  await app.listen();
  return { app, transport, service, repository, storageService, agentCalls };
}

// The rejection as the gateway would see it, flattened for message assertions.
async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return `${error instanceof Error ? error.message : ''} ${JSON.stringify(error)}`;
  }
  throw new Error('expected the call to fail');
}

const entryPoints = {
  offer: { cmd: 'send-credential-create-offer' },
  outOfBand: { cmd: 'send-credential-create-offer-oob' },
  email: { cmd: 'out-of-band-credential-offer' },
  csvTemplate: { cmd: 'download-csv-template-for-bulk-operation' },
  upload: { cmd: 'upload-csv-template' }
};

const offerPayload = (): object => ({
  orgId: ORG_ID,
  credentialType: 'jsonld',
  isValidateSchema: false,
  credentialData: [{ connectionId: 'connection-1', credential: credential(), options }]
});

const outOfBandPayload = (): object => ({
  orgId: ORG_ID,
  credentialType: 'jsonld',
  credential: credential(),
  options,
  isShortenUrl: false,
  reuseConnection: false
});

const emailPayload = (): object => ({
  outOfBandCredentialDto: {
    orgId: ORG_ID,
    credentialType: 'jsonld',
    credentialOffer: [{ emailId: 'holder@example.com', credential: credential(), options }]
  }
});

describe('issuance ledger checks over drifted ledger data', () => {
  let fixture: Fixture;

  afterEach(async () => {
    await fixture?.app.close();
    jest.restoreAllMocks();
  });

  describe.each(DRIFTED_DATA)('with %s', (_label, agent, rows) => {
    beforeEach(async () => {
      fixture = await start(agent, rows);
    });

    it('creates a connection-based W3C offer (send-credential-create-offer)', async () => {
      const result = await fixture.transport.dispatch(entryPoints.offer, offerPayload());

      expect(result).toEqual(
        expect.objectContaining({
          statusCode: 201,
          data: [expect.objectContaining({ statusCode: 201, data: { threadId: 'thread-1' } })]
        })
      );
      expect(fixture.agentCalls.offer).toHaveBeenCalledTimes(1);
      expect(fixture.agentCalls.offer).toHaveBeenCalledWith(expect.any(Object), expect.any(String), ORG_ID);
    });

    it('creates an out-of-band W3C offer (send-credential-create-offer-oob)', async () => {
      await expect(fixture.transport.dispatch(entryPoints.outOfBand, outOfBandPayload())).resolves.toEqual({
        invitationUrl: 'https://agent.example.com/oob'
      });
      expect(fixture.agentCalls.outOfBand).toHaveBeenCalledTimes(1);
    });

    it('sends an emailed W3C offer, the path bulk issuance rows take (out-of-band-credential-offer)', async () => {
      await expect(fixture.transport.dispatch(entryPoints.email, emailPayload())).resolves.toBe(true);
      expect(fixture.agentCalls.email).toHaveBeenCalledTimes(1);
    });

    it('builds the bulk CSV template for a W3C template (download-csv-template-for-bulk-operation)', async () => {
      await expect(
        fixture.transport.dispatch(entryPoints.csvTemplate, {
          orgId: ORG_ID,
          templateDetails: { schemaType: 'w3c', templateId: TEMPLATE_URL }
        })
      ).resolves.toEqual(expect.objectContaining({ fileName: expect.stringMatching(/^Bank Account-\d+\.csv$/) }));
    });

    it('accepts a bulk upload for a W3C template and goes on to read the file (upload-csv-template)', async () => {
      const failure = await failureOf(
        fixture.transport.dispatch(entryPoints.upload, {
          orgId: ORG_ID,
          importFileDetails: { templateId: TEMPLATE_URL, type: 'w3c', fileKey: 'uploads/file.csv', fileName: 'f.csv' }
        })
      );

      expect(fixture.storageService.getFileByKey).toHaveBeenCalledWith('uploads/file.csv');
      expect(failure).toContain('storage reached');
      expect(failure).not.toContain(MISMATCH);
    });
  });
});

describe('W3C template lookups that find nothing', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await start({ orgId: ORG_ID, orgDid: 'did:polygon:testnet:0xissuer', ledgerId: null }, []);
  });

  afterEach(async () => {
    await fixture.app.close();
    jest.restoreAllMocks();
  });

  it('rejects an unknown template on upload as not found instead of crashing', async () => {
    const failure = await failureOf(
      fixture.transport.dispatch(entryPoints.upload, {
        orgId: ORG_ID,
        importFileDetails: { templateId: TEMPLATE_URL, type: 'w3c', fileKey: 'uploads/file.csv', fileName: 'f.csv' }
      })
    );

    expect(failure).toContain(ResponseMessages.bulkIssuance.error.invalidIdentifier);
    expect(fixture.storageService.getFileByKey).not.toHaveBeenCalled();
  });

  it('rejects an unknown template on CSV download as not found', async () => {
    const failure = await failureOf(
      fixture.transport.dispatch(entryPoints.csvTemplate, {
        orgId: ORG_ID,
        templateDetails: { schemaType: 'w3c', templateId: TEMPLATE_URL }
      })
    );

    expect(failure).toContain(ResponseMessages.bulkIssuance.error.invalidIdentifier);
  });

  it('rejects an unknown template on an out-of-band offer as not found', async () => {
    const failure = await failureOf(fixture.transport.dispatch(entryPoints.outOfBand, outOfBandPayload()));

    expect(failure).toContain(ResponseMessages.schema.error.notFound);
    expect(fixture.agentCalls.outOfBand).not.toHaveBeenCalled();
  });
});

describe('W3C ledger difference warning', () => {
  let fixture: Fixture;
  let warn: jest.SpyInstance;

  afterEach(async () => {
    await fixture.app.close();
    jest.restoreAllMocks();
  });

  async function startWith(agent: Agent, rows: TemplateRow[]): Promise<void> {
    fixture = await start(agent, rows);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  }

  it('reports once when an org issues its own template from another network than it was published on', async () => {
    const issuer = { orgId: ORG_ID, orgDid: 'did:ethr:sepolia:0xissuer', ledgerId: LEDGERS['ethr:sepolia'] };
    await startWith(issuer, [template({ ledgerId: LEDGERS['polygon:testnet'] })]);

    await fixture.transport.dispatch(entryPoints.offer, offerPayload());
    await fixture.transport.dispatch(entryPoints.offer, offerPayload());

    const reports = warn.mock.calls.filter(([message]) => String(message).includes(TEMPLATE_URL));
    expect(reports).toHaveLength(1);
    expect(reports[0][0]).toContain('polygon:testnet');
    expect(reports[0][0]).toContain('ethr:sepolia');
  });

  it.each([
    ['the template was published on the same network', template({ publisherDid: 'did:polygon:testnet:0xissuer' })],
    ['the row belongs to another org', template({ orgId: OTHER_ORG_ID, publisherDid: 'did:ethr:sepolia:0xother' })],
    ['the publisher DID does not name a network', template({ publisherDid: 'did:web:issuer.example.com' })]
  ])('stays quiet when %s', async (_label, row) => {
    await startWith({ orgId: ORG_ID, orgDid: 'did:polygon:testnet:0xissuer', ledgerId: null }, [row]);

    await fixture.transport.dispatch(entryPoints.offer, offerPayload());

    expect(warn.mock.calls.filter(([message]) => String(message).includes(TEMPLATE_URL))).toHaveLength(0);
  });

  const movedIssuer = { orgId: ORG_ID, orgDid: 'did:ethr:sepolia:0xissuer', ledgerId: LEDGERS['ethr:sepolia'] };
  const reportsFor = (url: string): unknown[][] => warn.mock.calls.filter(([message]) => String(message).includes(url));

  it('looks the templates up once per offer, not once per recipient', async () => {
    await startWith(movedIssuer, [template({})]);
    const otherUrl = 'https://schema.example.com/schemas/other';
    const recipients = [TEMPLATE_URL, TEMPLATE_URL, otherUrl, TEMPLATE_URL].map((url, i) => ({
      connectionId: `connection-${i}`,
      credential: { ...credential(), '@context': [W3C_CONTEXT, url] },
      options
    }));

    const result = await fixture.transport.dispatch(entryPoints.offer, {
      ...offerPayload(),
      credentialData: recipients
    });

    expect(result).toEqual(expect.objectContaining({ statusCode: 201 }));
    expect(fixture.agentCalls.offer).toHaveBeenCalledTimes(4);
    expect(fixture.service._getSchemaDetails).toHaveBeenCalledTimes(1);
    expect(fixture.service._getSchemaDetails).toHaveBeenCalledWith([TEMPLATE_URL, otherUrl]);
  });

  it('still creates the offer when the template lookup fails', async () => {
    await startWith(movedIssuer, [template({})]);
    jest.mocked(fixture.service._getSchemaDetails).mockRejectedValue(new Error('ledger service unavailable'));

    await expect(fixture.transport.dispatch(entryPoints.offer, offerPayload())).resolves.toEqual(
      expect.objectContaining({ statusCode: 201 })
    );
    await expect(fixture.transport.dispatch(entryPoints.email, emailPayload())).resolves.toBe(true);
    expect(reportsFor(TEMPLATE_URL)).toHaveLength(0);
  });

  it('reports from the emailed and bulk path, naming both networks and no remediation', async () => {
    await startWith(movedIssuer, [template({})]);

    await fixture.transport.dispatch(entryPoints.email, emailPayload());

    const [[message]] = reportsFor(TEMPLATE_URL);
    expect(message).toBe(
      `W3C template ${TEMPLATE_URL} of org ${ORG_ID} was published from polygon:testnet; the org now issues from ethr:sepolia.`
    );
  });

  it('does not look templates up on the single-template paths', async () => {
    await startWith(movedIssuer, [template({})]);

    await fixture.transport.dispatch(entryPoints.outOfBand, outOfBandPayload());
    await fixture.transport.dispatch(entryPoints.csvTemplate, {
      orgId: ORG_ID,
      templateDetails: { schemaType: 'w3c', templateId: TEMPLATE_URL }
    });

    expect(fixture.service._getSchemaDetails).not.toHaveBeenCalled();
    expect(reportsFor(TEMPLATE_URL)).toHaveLength(0);
  });
});

describe('Indy templates keep the ledger check, read from the issuer DID', () => {
  let fixture: Fixture;

  afterEach(async () => {
    await fixture.app.close();
    jest.restoreAllMocks();
  });

  const CRED_DEF_ID = 'issuer:3:CL:1:default';

  async function startIndy(agent: Agent, schemaLedgerId: string | null): Promise<void> {
    fixture = await start(agent, []);
    fixture.repository.getCredentialDefinitionDetails.mockResolvedValue({
      credentialDefinitionId: CRED_DEF_ID,
      tag: 'default',
      schemaLedgerId: 'issuer:2:Bank:1.0',
      schemaName: 'Bank',
      attributes: JSON.stringify([{ attributeName: 'name', schemaDataType: 'string', isRequired: true }])
    });
    fixture.repository.getSchemaDetails.mockResolvedValue({ ledgerId: schemaLedgerId });
  }

  function csvTemplate(): Promise<unknown> {
    return fixture.transport.dispatch(entryPoints.csvTemplate, {
      orgId: ORG_ID,
      templateDetails: { schemaType: 'indy', templateId: CRED_DEF_ID }
    });
  }

  function upload(): Promise<unknown> {
    return fixture.transport.dispatch(entryPoints.upload, {
      orgId: ORG_ID,
      importFileDetails: { templateId: CRED_DEF_ID, type: 'indy', fileKey: 'uploads/file.csv', fileName: 'f.csv' }
    });
  }

  it.each([
    [
      'the stored agent ledger is NULL but the DID names the ledger',
      { orgId: ORG_ID, orgDid: 'did:indy:bcovrin:testnet:issuer', ledgerId: null }
    ],
    [
      'the stored agent ledger is stale but the DID names the ledger',
      { orgId: ORG_ID, orgDid: 'did:indy:bcovrin:testnet:issuer', ledgerId: NO_LEDGER_ID }
    ],
    [
      'the DID is unqualified and the stored agent ledger matches',
      { orgId: ORG_ID, orgDid: 'issuer', ledgerId: LEDGERS['bcovrin:testnet'] }
    ],
    [
      'the DID names a ledger that is not seeded and the stored agent ledger matches',
      { orgId: ORG_ID, orgDid: 'did:indy:unseeded:net:issuer', ledgerId: LEDGERS['bcovrin:testnet'] }
    ]
  ])('allows the CSV template and upload when %s', async (_label, agent) => {
    await startIndy(agent, LEDGERS['bcovrin:testnet']);

    await expect(csvTemplate()).resolves.toEqual(expect.objectContaining({ fileName: expect.any(String) }));
    const failure = await failureOf(upload());
    expect(failure).not.toContain(MISMATCH);
    expect(fixture.storageService.getFileByKey).toHaveBeenCalled();
  });

  it.each([
    [
      'the issuer DID is on another Indy ledger, whatever the stored copy says',
      { orgId: ORG_ID, orgDid: 'did:indy:bcovrin:testnet:issuer', ledgerId: LEDGERS['indicio:testnet'] }
    ],
    [
      'the DID is unqualified and the stored agent ledger differs',
      { orgId: ORG_ID, orgDid: 'issuer', ledgerId: LEDGERS['bcovrin:testnet'] }
    ]
  ])('rejects the CSV template and upload when %s', async (_label, agent) => {
    await startIndy(agent, LEDGERS['indicio:testnet']);

    expect(await failureOf(csvTemplate())).toContain(MISMATCH);
    expect(await failureOf(upload())).toContain(MISMATCH);
    expect(fixture.storageService.getFileByKey).not.toHaveBeenCalled();
  });
});
