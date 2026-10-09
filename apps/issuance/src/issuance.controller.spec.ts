import { Test } from '@nestjs/testing';
import { CustomTransportStrategy, NatsContext, Server } from '@nestjs/microservices';
import { INestMicroservice } from '@nestjs/common';
import { isObservable, lastValueFrom } from 'rxjs';
import { IssuanceController } from './issuance.controller';
import { IssuanceService } from './issuance.service';
import { IssuanceWorkCoordinator } from './issuance-work.coordinator';
import { ISSUANCE_DEADLINE_HEADER } from '../../../libs/context/src/issuanceDeadline';

jest.mock('./issuance.service', () => ({ IssuanceService: class IssuanceService {} }));
jest.mock('./issuance-work.coordinator', () => ({ IssuanceWorkCoordinator: class IssuanceWorkCoordinator {} }));
jest.mock('apps/api-gateway/src/issuance/dtos/issuance.dto', () => ({
  OOBIssueCredentialDto: class OOBIssueCredentialDto {}
}));

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

  async dispatch(cmd: string, data: unknown, headers: Record<string, string> = {}): Promise<unknown> {
    const handler = this.getHandlerByPattern(this.normalizePattern({ cmd }));
    const natsHeaders = {
      has: (name: string): boolean => name in headers,
      get: (name: string): string => headers[name] ?? ''
    };
    const result = await handler(data, new NatsContext(['issuance', natsHeaders as never]));
    return isObservable(result) ? lastValueFrom(result) : result;
  }
}

describe('IssuanceController NATS payloads', () => {
  let app: INestMicroservice;
  let transport: InMemoryTransport;
  const issuanceService = {
    sendCredentialCreateOffer: jest.fn().mockResolvedValue({ offer: true }),
    sendCredentialOutOfBand: jest.fn().mockResolvedValue({ response: {} }),
    outOfBandCredentialOffer: jest.fn().mockResolvedValue(true)
  };
  const issuanceWork = { interactive: jest.fn((_deadline: unknown, work: () => unknown) => work()) };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [IssuanceController],
      providers: [
        { provide: IssuanceService, useValue: issuanceService },
        { provide: IssuanceWorkCoordinator, useValue: issuanceWork }
      ]
    }).compile();
    transport = new InMemoryTransport();
    app = moduleRef.createNestMicroservice({ strategy: transport });
    await app.listen();
  });

  afterEach(async () => {
    await app.close();
  });

  it('passes the message payload to sendCredentialCreateOffer', async () => {
    const payload = { orgId: 'org-1', credentialType: 'jsonld' };
    await expect(transport.dispatch('send-credential-create-offer', payload)).resolves.toEqual({ offer: true });
    expect(issuanceService.sendCredentialCreateOffer).toHaveBeenCalledWith(payload);
  });

  it('passes the message payload to sendCredentialOutOfBand', async () => {
    const payload = { orgId: 'org-1', credentialType: 'jsonld' };
    await transport.dispatch('send-credential-create-offer-oob', payload);
    expect(issuanceService.sendCredentialOutOfBand).toHaveBeenCalledWith(payload);
  });

  it('passes the out-of-band DTO from the message payload', async () => {
    const outOfBandCredentialDto = { orgId: 'org-1', emailId: 'holder@example.com' };
    await transport.dispatch('out-of-band-credential-offer', { outOfBandCredentialDto });
    expect(issuanceService.outOfBandCredentialOffer).toHaveBeenCalledWith(outOfBandCredentialDto);
  });

  it('reads the admission deadline from the NATS headers', async () => {
    await transport.dispatch('send-credential-create-offer', { orgId: 'org-1' }, { [ISSUANCE_DEADLINE_HEADER]: '123' });
    expect(issuanceWork.interactive).toHaveBeenCalledWith('123', expect.any(Function));
  });
});
