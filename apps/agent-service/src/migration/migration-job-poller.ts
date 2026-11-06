import { IPortabilityJob } from './migration-agent.client';

const MINUTE_MS = 60 * 1000;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

export const envMs = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && 0 < value ? value : fallback;
};

export const jobTimeoutMs = (): number => envMs('ORG_MIGRATION_JOB_TIMEOUT_MS', 60 * MINUTE_MS);

export const pollIntervalMs = (): number => envMs('ORG_MIGRATION_POLL_INTERVAL_MS', 5000);

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Why a poll gave up. `cause` is the last poll error for POLL_ERROR. */
export class JobPollFailure extends Error {
  constructor(
    readonly reason: 'JOB_FAILED' | 'TIMEOUT' | 'POLL_ERROR',
    readonly cause?: unknown
  ) {
    super(reason);
  }
}

/**
 * Polls an export or import job until it completes. A few failed polls in a row are tolerated, because the job
 * keeps running on the agent either way. Gives up at `deadlineAt` (epoch ms).
 */
export const pollJob = async (
  fetchJob: () => Promise<IPortabilityJob>,
  deadlineAt: number,
  intervalMs: number = pollIntervalMs()
): Promise<IPortabilityJob> => {
  let failedPolls = 0;

  for (;;) {
    try {
      const job = await fetchJob();
      failedPolls = 0;
      if ('completed' === job.status) {
        return job;
      }
      if ('failed' === job.status) {
        throw new JobPollFailure('JOB_FAILED');
      }
    } catch (error) {
      if (error instanceof JobPollFailure) {
        throw error;
      }
      failedPolls += 1;
      if (MAX_CONSECUTIVE_POLL_FAILURES <= failedPolls) {
        throw new JobPollFailure('POLL_ERROR', error);
      }
    }
    if (Date.now() >= deadlineAt) {
      throw new JobPollFailure('TIMEOUT');
    }
    await sleep(Math.min(intervalMs, Math.max(deadlineAt - Date.now(), 1)));
  }
};
