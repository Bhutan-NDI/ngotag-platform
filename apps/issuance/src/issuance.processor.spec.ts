import { BulkIssuanceProcessor } from './issuance.processor';
import { IssuanceService } from './issuance.service';
import { Job } from 'bull';
import { IQueuePayload } from '../interfaces/issuance.interfaces';

jest.mock('./issuance.service', () => ({ IssuanceService: class {} }));

describe('bulk issuance job lifecycle', () => {
  const job = (): Job<IQueuePayload> => {
    return { id: 'synthetic', data: {}, discard: jest.fn() } as unknown as Job<IQueuePayload>;
  };

  it('keeps a job pending until issuance and persistence finish', async () => {
    let finish: (value: boolean) => void;
    const work = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const service = { processIssuanceData: jest.fn(() => work) };
    const processor = new BulkIssuanceProcessor(service as unknown as IssuanceService);
    const task = job();
    let settled = false;
    const promise = processor.issueCredential(task).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(task.discard).toHaveBeenCalledTimes(1);
    finish(true);
    await promise;
    expect(settled).toBe(true);
  });

  it('fails a job when the service reports a persisted row failure', async () => {
    const processor = new BulkIssuanceProcessor({
      processIssuanceData: jest.fn().mockResolvedValue(false)
    } as unknown as IssuanceService);
    await expect(processor.issueCredential(job())).rejects.toThrow('Bulk issuance row failed');
  });

  it('propagates unexpected failures without retrying issuance itself', async () => {
    const failure = new Error('synthetic persistence failure');
    const service = { processIssuanceData: jest.fn().mockRejectedValue(failure) };
    const processor = new BulkIssuanceProcessor(service as unknown as IssuanceService);
    await expect(processor.issueCredential(job())).rejects.toBe(failure);
    expect(service.processIssuanceData).toHaveBeenCalledTimes(1);
  });
});
