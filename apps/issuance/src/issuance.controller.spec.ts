import { Test } from '@nestjs/testing';
import { CustomTransportStrategy, MsPattern, NatsContext, Server } from '@nestjs/microservices';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { INestMicroservice } from '@nestjs/common';
import { headers as natsHeaders } from 'nats';
import { isObservable, lastValueFrom } from 'rxjs';
import { IssuanceController } from './issuance.controller';
import { IssuanceService } from './issuance.service';
import { IssuanceWorkCoordinator } from './issuance-work.coordinator';
import { ISSUANCE_DEADLINE_HEADER } from '../../../libs/context/src/issuanceDeadline';

jest.mock('./issuance.service', () => ({ IssuanceService: class IssuanceService {} }));
jest.mock('./issuance-work.coordinator', () => ({ IssuanceWorkCoordinator: class IssuanceWorkCoordinator {} }));
// The real gateway DTO imports this enum through a path alias the Jest config does not map.
jest.mock(
  'apps/connection/src/enum/connection.enum',
  () => jest.requireActual('../../connection/src/enum/connection.enum'),
  { virtual: true }
);

// Registers the controller's handlers without a broker, so messages go through Nest's own
// RPC argument resolution instead of calling controller methods directly.
class InMemoryTransport extends Server implements CustomTransportStrategy {
  listen(callback: () => void): void {
    callback();
  }

  close(): void {}

  on(): void {}

  unwrap<T>(): T {
    throw new Error('In-memory transport has no broker');
  }

  async dispatch(pattern: MsPattern, data: unknown, headers: Record<string, string> = {}): Promise<unknown> {
    const handler = this.getHandlerByPattern(this.normalizePattern(pattern));
    const msgHeaders = natsHeaders();
    Object.entries(headers).forEach(([name, value]) => msgHeaders.set(name, value));
    const result = await handler(data, new NatsContext(['issuance', msgHeaders]));
    return isObservable(result) ? lastValueFrom(result) : result;
  }
}

const issuanceService = {
  sendCredentialCreateOffer: jest.fn().mockResolvedValue({ offer: true }),
  sendCredentialOutOfBand: jest.fn().mockResolvedValue({ response: {} }),
  outOfBandCredentialOffer: jest.fn().mockResolvedValue(true)
};
const issuanceWork = { interactive: jest.fn((_deadline: unknown, work: () => unknown) => work()) };

async function startController(): Promise<{ app: INestMicroservice; transport: InMemoryTransport }> {
  const moduleRef = await Test.createTestingModule({
    controllers: [IssuanceController],
    providers: [
      { provide: IssuanceService, useValue: issuanceService },
      { provide: IssuanceWorkCoordinator, useValue: issuanceWork }
    ]
  }).compile();
  const transport = new InMemoryTransport();
  const app = moduleRef.createNestMicroservice({ strategy: transport });
  await app.listen();
  return { app, transport };
}

describe('IssuanceController NATS payloads', () => {
  let app: INestMicroservice;
  let transport: InMemoryTransport;

  beforeEach(async () => {
    jest.clearAllMocks();
    ({ app, transport } = await startController());
  });

  afterEach(async () => {
    await app.close();
  });

  it('passes the message payload to sendCredentialCreateOffer', async () => {
    const payload = { orgId: 'org-1', credentialType: 'jsonld' };
    await expect(transport.dispatch({ cmd: 'send-credential-create-offer' }, payload)).resolves.toEqual({
      offer: true
    });
    expect(issuanceService.sendCredentialCreateOffer).toHaveBeenCalledWith(payload);
  });

  it('passes the message payload to sendCredentialOutOfBand', async () => {
    const payload = { orgId: 'org-1', credentialType: 'jsonld' };
    await transport.dispatch({ cmd: 'send-credential-create-offer-oob' }, payload);
    expect(issuanceService.sendCredentialOutOfBand).toHaveBeenCalledWith(payload);
  });

  it('passes the out-of-band DTO from the message payload', async () => {
    const outOfBandCredentialDto = { orgId: 'org-1', emailId: 'holder@example.com' };
    await transport.dispatch({ cmd: 'out-of-band-credential-offer' }, { outOfBandCredentialDto });
    expect(issuanceService.outOfBandCredentialOffer).toHaveBeenCalledWith(outOfBandCredentialDto);
  });

  it('reads the admission deadline from the NATS headers', async () => {
    await transport.dispatch(
      { cmd: 'send-credential-create-offer' },
      { orgId: 'org-1' },
      { [ISSUANCE_DEADLINE_HEADER]: '123' }
    );
    expect(issuanceWork.interactive).toHaveBeenCalledWith('123', expect.any(Function));
  });

  it('treats a missing deadline header as absent', async () => {
    await transport.dispatch({ cmd: 'send-credential-create-offer' }, { orgId: 'org-1' });
    expect(issuanceWork.interactive).toHaveBeenCalledWith(undefined, expect.any(Function));
  });
});

// Once any argument of a handler is decorated, Nest leaves the undecorated ones undefined.
// Every handler must therefore still receive the message payload as its first argument.
describe('every IssuanceController NATS handler', () => {
  type Handler = (...args: unknown[]) => unknown;
  const prototype = IssuanceController.prototype as unknown as Record<string, Handler>;
  const handlerNames = Object.getOwnPropertyNames(prototype).filter(
    (name) => 'constructor' !== name && Reflect.hasMetadata(PATTERN_METADATA, prototype[name])
  );
  const patterns = new Map(
    handlerNames.map((name) => [name, (Reflect.getMetadata(PATTERN_METADATA, prototype[name]) as MsPattern[])[0]])
  );
  let app: INestMicroservice;
  let transport: InMemoryTransport;

  beforeAll(async () => {
    for (const name of handlerNames) {
      const original = prototype[name];
      const stub = jest.spyOn(prototype, name).mockImplementation(async () => undefined);
      // Nest finds handlers by the metadata on the method, so the stub needs the original's.
      for (const key of Reflect.getMetadataKeys(original)) {
        Reflect.defineMetadata(key, Reflect.getMetadata(key, original), stub);
      }
    }
    ({ app, transport } = await startController());
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('finds the controller handlers', () => {
    expect(handlerNames).toEqual(expect.arrayContaining(['sendCredentialCreateOffer', 'getIssueCredentials']));
  });

  it.each(handlerNames)('%s receives the message payload as its first argument', async (name) => {
    const payload = { probe: name };
    await transport.dispatch(patterns.get(name), payload);
    expect(jest.mocked(prototype[name]).mock.calls[0][0]).toEqual(payload);
  });
});
