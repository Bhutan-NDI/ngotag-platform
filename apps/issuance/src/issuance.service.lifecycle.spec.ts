/* eslint-disable camelcase -- Synthetic fixtures preserve the public payload's field names. */
import { IssuanceService } from './issuance.service';
import { IQueuePayload, IIssuance, SendEmailCredentialOffer } from '../interfaces/issuance.interfaces';
import { IssueCredentialType, SchemaType } from '@credebl/enum/enum';
import { io } from 'socket.io-client';
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
  coordinator: { bulkRow: jest.Mock; offer: jest.Mock; completedRow: jest.Mock };
} {
  const repository = {
    getFileDataForProcessing: jest.fn().mockResolvedValue({ status: false }),
    getAgentEndPoint: jest.fn().mockResolvedValue({
      organisation: { name: 'Synthetic' },
      agentEndPoint: 'https://example.com',
      orgAgentTypeId: 'shared'
    }),
    deleteFileDataByJobId: jest.fn().mockResolvedValue({}),
    updateFileUploadData: jest.fn().mockResolvedValue({}),
    getCredentialDefinitionDetails: jest.fn().mockResolvedValue({ attributes: '[]' }),
    getOrgAgentType: jest.fn().mockResolvedValue({}),
    getPlatformConfigDetails: jest.fn().mockResolvedValue({ emailFrom: 'synthetic@example.com' }),
    countErrorsForFile: jest.fn().mockResolvedValue(0),
    updateFileUploadDetails: jest.fn().mockResolvedValue({})
  };
  const coordinator = {
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
      .mockResolvedValue({ response: { invitationUrl: 'https://example.com/invite' } });
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
