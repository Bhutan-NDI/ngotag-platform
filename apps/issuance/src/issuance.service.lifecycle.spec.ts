/* eslint-disable camelcase -- Synthetic fixtures preserve the public payload's field names. */
import { IssuanceService } from './issuance.service';
import { IQueuePayload, IIssuance, SendEmailCredentialOffer } from '../interfaces/issuance.interfaces';
import { IssueCredentialType, SchemaType } from '@credebl/enum/enum';
import { io } from 'socket.io-client';
import { IssuanceWorkCoordinator } from './issuance-work.coordinator';
import { IssuanceRepository } from './issuance.repository';
import * as Queue from 'bull';
import { randomUUID } from 'crypto';
import { localRedis } from '../test/local-redis';
import { FileUploadStatus } from 'apps/api-gateway/src/enum';
import { EmailDto } from '@credebl/common/dtos/email.dto';

jest.mock('socket.io-client', () => ({ io: jest.fn(() => ({ emit: jest.fn() })) }));
jest.mock('cache-manager-ioredis-yet', () => ({
  redisStore: jest.fn(async () => ({ del: jest.fn().mockResolvedValue(undefined) }))
}));

const payload = {
  id: 'row',
  jobId: 'batch',
  fileUploadId: 'file',
  orgId: 'org',
  totalJobs: 2,
  clientId: 'client',
  referenceId: 'reference',
  schemaLedgerId: 'schema',
  status: '',
  isRetry: false,
  isLastData: false,
  credentialType: SchemaType.INDY,
  credentialDefinitionId: 'definition',
  credential_data: { email_identifier: 'synthetic@example.com', name: 'Synthetic' }
} as IQueuePayload;

function fixture(): {
  service: IssuanceService;
  repository: Record<string, jest.Mock>;
  emailData: EmailDto;
  emailService: { sendEmail: jest.Mock };
  coordinator: { bulkRow: jest.Mock; offer: jest.Mock; completedRow: jest.Mock; offerConcurrency: number };
} {
  const repository = {
    interruptFileUpload: jest.fn().mockResolvedValue(true),
    getFileDataForProcessing: jest.fn().mockResolvedValue({ status: false }),
    getAgentEndPoint: jest.fn().mockResolvedValue({
      organisation: { name: 'Synthetic' },
      agentEndPoint: 'https://example.com',
      orgAgentTypeId: 'shared'
    }),
    deleteFileDataByJobId: jest.fn().mockResolvedValue({}),
    updateFileUploadData: jest.fn().mockResolvedValue({}),
    getCredentialDefinitionDetails: jest.fn().mockResolvedValue({ attributes: '[]' }),
    getOrganization: jest.fn().mockResolvedValue({ name: 'Synthetic' }),
    getOrgAgentType: jest.fn().mockResolvedValue({}),
    getPlatformConfigDetails: jest.fn().mockResolvedValue({ emailFrom: 'synthetic@example.com' }),
    countErrorsForFile: jest.fn().mockResolvedValue(0),
    updateFileUploadDetails: jest.fn().mockResolvedValue({})
  };
  const coordinator = {
    offerConcurrency: 2,
    bulkRow: jest.fn((_org: string, _file: string, _row: string, operation: () => Promise<boolean>) => operation()),
    offer: jest.fn((operation: () => Promise<unknown>) => operation()),
    completedRow: jest.fn().mockResolvedValue(false)
  };
  const emailData = new EmailDto();
  const emailService = { sendEmail: jest.fn().mockResolvedValue(true) };
  const service = new IssuanceService(
    {} as never,
    {} as never,
    repository as never,
    {} as never,
    {} as never,
    { outOfBandIssuance: (): string => '<p>synthetic</p>' } as never,
    emailData,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    emailService as never,
    coordinator as never
  );
  return { service, repository, coordinator, emailData, emailService };
}

describe('issuance service job lifecycle', () => {
  const originalDomain = process.env.DEEPLINK_DOMAIN;
  beforeEach(() => {
    process.env.DEEPLINK_DOMAIN = 'synthetic://';
  });
  afterEach(() => {
    if (undefined === originalDomain) {
      delete process.env.DEEPLINK_DOMAIN;
    } else {
      process.env.DEEPLINK_DOMAIN = originalDomain;
    }
  });
  it('does not finish or count a row until its result is persisted', async () => {
    const { service, repository, coordinator } = fixture();
    jest.spyOn(service, 'outOfBandCredentialOffer').mockResolvedValue(true);
    let persist: () => void;
    repository.updateFileUploadData.mockImplementation(() => {
      return new Promise<void>((resolve) => {
        persist = resolve;
      });
    });
    const result = service.processIssuanceData(payload);
    for (let i = 0; 10 > i; i++) {
      await Promise.resolve();
    }
    expect(repository.updateFileUploadData).toHaveBeenCalled();
    expect(coordinator.completedRow).not.toHaveBeenCalled();
    persist();
    await expect(result).resolves.toBe(true);
    expect(coordinator.completedRow).toHaveBeenCalledWith('batch', 'row', 2);
  });

  it.each([false, 'reject'])('persists and reports an issuance failure (%s)', async (outcome) => {
    const { service, repository, coordinator } = fixture();
    const offer = jest.spyOn(service, 'outOfBandCredentialOffer');
    if ('reject' === outcome) {
      offer.mockRejectedValue(new Error('synthetic'));
    } else {
      offer.mockResolvedValue(false);
    }
    await expect(service.processIssuanceData(payload)).resolves.toBe(false);
    expect(repository.updateFileUploadData).toHaveBeenCalledWith(
      expect.objectContaining({ isError: true, jobId: 'row' })
    );
    expect(repository.deleteFileDataByJobId).not.toHaveBeenCalled();
    expect(coordinator.completedRow).toHaveBeenCalledTimes(1);
  });

  it('skips issuance for a row already durably marked successful', async () => {
    const { service, repository } = fixture();
    repository.getFileDataForProcessing.mockResolvedValue({ status: true });
    const offer = jest.spyOn(service, 'outOfBandCredentialOffer');
    await expect(service.processIssuanceData(payload)).resolves.toBe(true);
    expect(offer).not.toHaveBeenCalled();
    expect(repository.getAgentEndPoint).not.toHaveBeenCalled();
  });

  it('rejects a row outside the supplied file and organization', async () => {
    const { service, repository } = fixture();
    repository.getFileDataForProcessing.mockResolvedValue(null);
    await expect(service.processIssuanceData(payload)).rejects.toThrow('does not belong');
    expect(repository.getFileDataForProcessing).toHaveBeenCalledWith('row', 'file', 'org');
    expect(repository.getAgentEndPoint).not.toHaveBeenCalled();
  });

  it.each(['guard', 'row read', 'row persistence', 'completion'])(
    'interrupts the file after a thrown %s failure without counting an unpersisted row',
    async (phase) => {
      const { service, repository, coordinator } = fixture();
      const failure = new Error('synthetic failure');
      jest.spyOn(service, 'outOfBandCredentialOffer').mockResolvedValue(true);
      if ('guard' === phase) {
        coordinator.bulkRow.mockRejectedValue(failure);
      }
      if ('row read' === phase) {
        repository.getFileDataForProcessing.mockRejectedValue(failure);
      }
      if ('row persistence' === phase) {
        repository.updateFileUploadData.mockRejectedValue(failure);
      }
      if ('completion' === phase) {
        coordinator.completedRow.mockRejectedValue(failure);
      }
      const emit = jest.fn();
      (io as jest.Mock).mockReturnValue({ emit });
      await expect(service.processIssuanceData(payload)).rejects.toBe(failure);
      expect(repository.interruptFileUpload).toHaveBeenCalledWith('file', 'org');
      if ('completion' !== phase) {
        expect(coordinator.completedRow).not.toHaveBeenCalled();
      }
      expect(emit).toHaveBeenCalledWith(
        'error-in-bulk-issuance-process',
        expect.objectContaining({ fileUploadId: 'file' })
      );
      expect(repository.updateFileUploadData).not.toHaveBeenCalledWith(expect.objectContaining({ isError: true }));
    }
  );

  it('does not notify interruption for another tenant or an already terminal file', async () => {
    const { service, repository, coordinator } = fixture();
    coordinator.bulkRow.mockRejectedValue(new Error('held guard'));
    repository.interruptFileUpload.mockResolvedValue(false);
    const emit = jest.fn();
    (io as jest.Mock).mockReturnValue({ emit });
    await expect(service.processIssuanceData(payload)).rejects.toThrow('held guard');
    expect(emit).not.toHaveBeenCalled();
    expect(coordinator.completedRow).not.toHaveBeenCalled();
  });

  it('preserves the original job failure when interruption persistence also fails', async () => {
    const { service, repository, coordinator } = fixture();
    coordinator.bulkRow.mockRejectedValue(new Error('held guard'));
    repository.interruptFileUpload.mockRejectedValue(new Error('database unavailable'));
    await expect(service.processIssuanceData(payload)).rejects.toThrow('held guard');
    expect(coordinator.completedRow).not.toHaveBeenCalled();
  });

  it('scopes interruption updates to the owning tenant and active file statuses', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const repository = new IssuanceRepository({ file_upload: { updateMany } } as never, {} as never);
    await expect(repository.interruptFileUpload('file', 'org')).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'file', orgId: 'org', status: { in: [FileUploadStatus.started, FileUploadStatus.retry] } },
      data: { status: FileUploadStatus.interrupted }
    });
    updateMany.mockResolvedValue({ count: 0 });
    await expect(repository.interruptFileUpload('file', 'other-org')).resolves.toBe(false);
  });

  it('records pre-dispatch agent lookup failures as failed rows', async () => {
    const { service, repository } = fixture();
    repository.getAgentEndPoint.mockRejectedValue(new Error('synthetic'));
    await expect(service.processIssuanceData(payload)).resolves.toBe(false);
    expect(repository.updateFileUploadData).toHaveBeenCalledWith(expect.objectContaining({ isError: true }));
  });

  it('persists final file status before notifying completion', async () => {
    const { service, repository, coordinator } = fixture();
    repository.getFileDataForProcessing.mockResolvedValue({ status: true });
    coordinator.completedRow.mockResolvedValue(true);
    let persist: () => void;
    repository.updateFileUploadDetails.mockImplementation(() => {
      return new Promise<void>((resolve) => {
        persist = resolve;
      });
    });
    const emit = jest.fn();
    (io as jest.Mock).mockReturnValueOnce({ emit });
    const result = service.processIssuanceData({ ...payload, isRetry: true });
    for (let i = 0; 20 > i; i++) {
      await Promise.resolve();
    }
    expect(repository.updateFileUploadDetails).toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    persist();
    await expect(result).resolves.toBe(true);
    expect(emit).toHaveBeenCalledWith(
      'bulk-issuance-process-retry-completed',
      expect.objectContaining({ fileUploadId: 'file' })
    );
  });

  it('routes direct and out-of-band offer requests through the same budget', async () => {
    const { service, coordinator } = fixture();
    jest.spyOn(service, 'natsCallAgent').mockResolvedValue({
      id: 'synthetic',
      createdAt: '2026-01-01',
      state: 'offer-sent',
      connectionId: 'connection',
      threadId: 'thread',
      protocolVersion: 'v1'
    });
    jest.spyOn(service, 'natsCall').mockResolvedValue({ response: 'synthetic' });
    await service._sendCredentialCreateOffer({} as never, 'https://example.com', 'org');
    await service._outOfBandCredentialOffer({}, 'https://example.com', 'org');
    expect(coordinator.offer).toHaveBeenCalledTimes(2);
  });

  it('keeps email recipients and attachments isolated across overlapping offers', async () => {
    const { service, emailData, emailService } = fixture();
    jest
      .spyOn(service, '_outOfBandCredentialOffer')
      .mockResolvedValue({ response: { invitationUrl: 'https://example.com/invite' } } as never);
    jest.spyOn(service, 'storeIssuanceObjectReturnUrl').mockResolvedValue('https://example.com/short');
    const request = (emailId: string): SendEmailCredentialOffer => ({
      iterator: undefined,
      emailId,
      index: 0,
      credentialType: IssueCredentialType.INDY,
      protocolVersion: 'v1',
      attributes: [],
      credentialDefinitionId: 'definition',
      outOfBandCredential: { orgId: 'org' },
      comment: '',
      organisation: { name: 'Synthetic' } as never,
      errors: [],
      url: 'https://example.com',
      orgId: 'org',
      organizationDetails: { name: 'Synthetic' } as never
    });
    await Promise.all([
      service.sendEmailForCredentialOffer(request('one@example.com')),
      service.sendEmailForCredentialOffer(request('two@example.com'))
    ]);
    const messages = emailService.sendEmail.mock.calls.map(([message]) => message as EmailDto);
    expect(messages).toHaveLength(2);
    expect(messages[0]).not.toBe(messages[1]);
    expect(messages.map((message) => message.emailTo).sort()).toEqual(['one@example.com', 'two@example.com']);
    expect(emailData.emailTo).toBeUndefined();
    expect(emailData.emailAttachments).toBeUndefined();
  });

  it('preserves direct offer results without a per-request artificial delay', async () => {
    const { service } = fixture();
    const delay = jest.spyOn(service, 'delay');
    jest.spyOn(service, '_sendCredentialCreateOffer').mockResolvedValue({
      id: 'synthetic',
      createdAt: '2026-01-01',
      state: 'offer-sent',
      connectionId: 'connection',
      threadId: 'thread',
      protocolVersion: 'v1'
    });
    const request = {
      orgId: 'org',
      credentialDefinitionId: 'definition',
      credentialType: IssueCredentialType.INDY,
      credentialData: [{ connectionId: 'connection', attributes: [{ name: 'name', value: 'Synthetic' }] }]
    } as IIssuance;
    const result = await service.sendCredentialCreateOffer(request);
    expect(result.statusCode).toBe(201);
    expect(delay).not.toHaveBeenCalled();
  });
});

const integration = '1' === process.env.RUN_ISSUANCE_REDIS_TESTS ? describe : describe.skip;
integration('multi-recipient service requests with real Redis admission', () => {
  const originalDomain = process.env.DEEPLINK_DOMAIN;
  let queue: Queue.Queue;
  let worker: IssuanceWorkCoordinator;
  let prefix: string;
  beforeEach(async () => {
    process.env.DEEPLINK_DOMAIN = 'synthetic://';
    prefix = `issuance-recipients-${randomUUID()}`;
    queue = new Queue('bulk-issuance', { redis: localRedis(), prefix });
    await queue.isReady();
    worker = new IssuanceWorkCoordinator(queue);
  });
  afterEach(async () => {
    const keys = await queue.client.keys(`${prefix}:*`);
    if (keys.length) {
      await queue.client.del(...keys);
    }
    await queue.close();
    if (undefined === originalDomain) {
      delete process.env.DEEPLINK_DOMAIN;
    } else {
      process.env.DEEPLINK_DOMAIN = originalDomain;
    }
  });

  it('creates all twenty direct offers taking two seconds each without timing out its own recipients', async () => {
    const { service } = fixture();
    Object.defineProperty(service, 'issuanceWork', { value: worker });
    let active = 0;
    let peak = 0;
    const dispatch = jest.spyOn(service, 'natsCallAgent').mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      active--;
      return { id: 'synthetic' } as never;
    });
    const result = await worker.interactive(Date.now() + 10000, () => {
      return service.sendCredentialCreateOffer({
        orgId: 'org',
        credentialType: IssueCredentialType.INDY,
        credentialDefinitionId: 'definition',
        credentialData: Array.from({ length: 20 }, (_, index) => ({
          connectionId: `connection-${index}`,
          attributes: []
        }))
      } as IIssuance);
    });
    expect(result.statusCode).toBe(201);
    expect(dispatch).toHaveBeenCalledTimes(20);
    expect(peak).toBe(worker.offerConcurrency);
    expect(await queue.client.exists(queue.toKey('offer-capacity-v1'))).toBe(0);
  }, 15000);

  it('finishes thirty sequential email recipients after the original ten-second admission deadline', async () => {
    const { service, emailService } = fixture();
    Object.defineProperty(service, 'issuanceWork', { value: worker });
    const dispatch = jest
      .spyOn(service, 'natsCall')
      .mockResolvedValue({ response: { invitationUrl: 'https://example.com/invite' } } as never);
    jest.spyOn(service, 'storeIssuanceObjectReturnUrl').mockResolvedValue('https://example.com/short');
    emailService.sendEmail.mockImplementation(async () => {
      // Email work stays outside the offer permit even for an admitted request.
      expect(await queue.client.exists(queue.toKey('offer-capacity-v1'))).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 700));
      return true;
    });
    await expect(
      worker.interactive(Date.now() + 10000, () => {
        return service.outOfBandCredentialOffer({
          orgId: 'org',
          credentialType: IssueCredentialType.INDY,
          credentialDefinitionId: 'definition',
          credentialOffer: Array.from({ length: 30 }, (_, index) => ({
            emailId: `synthetic-${index}@example.com`,
            attributes: []
          }))
        } as never);
      })
    ).resolves.toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(30);
    expect(emailService.sendEmail.mock.calls.map(([email]) => email.emailTo)).toEqual(
      Array.from({ length: 30 }, (_, index) => `synthetic-${index}@example.com`)
    );
  }, 30000);
});
