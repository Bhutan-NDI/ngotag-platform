import { OnQueueActive, Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { ISSUANCE_WORKER_CONCURRENCY } from './issuance-work.coordinator';
import { IssuanceService } from './issuance.service';
import { Logger } from '@nestjs/common';
import { IQueuePayload } from '../interfaces/issuance.interfaces';

@Processor('bulk-issuance')
export class BulkIssuanceProcessor {
  private readonly logger = new Logger('IssueCredentialService');
  constructor(private readonly issuanceService: IssuanceService) {}

  @OnQueueActive()
  onActive(job: Job): void {
    this.logger.log(`Emitting job status${job.id} of type ${job.name} ...`);
  }

  @Process({ concurrency: ISSUANCE_WORKER_CONCURRENCY })
  async issueCredential(job: Job<IQueuePayload>): Promise<void> {
    this.logger.log(`Processing job ${job.id} of type ${job.name} ...`);

    // Do not replay an offer after a timeout or lost response. Failed rows use
    // the explicit retry/reconciliation flow, not automatic queue retries.
    job.discard();
    const succeeded = await this.issuanceService.processIssuanceData(job.data);
    if (!succeeded) {
      throw new Error('Bulk issuance row failed; see the persisted row status');
    }
  }
}
