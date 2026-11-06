import { MigrationAgentError } from './migration-agent.client';
import { JobPollFailure, pollJob } from './migration-job-poller';

const job = (status: string): never => ({ jobId: 'j1', status }) as never;
const inAMinute = (): number => Date.now() + 60000;

describe('pollJob', () => {
  it('returns the job once it completes', async () => {
    const fetchJob = jest
      .fn()
      .mockResolvedValueOnce(job('pending'))
      .mockResolvedValueOnce(job('in-progress'))
      .mockResolvedValue(job('completed'));

    await expect(pollJob(fetchJob, inAMinute(), 1)).resolves.toMatchObject({ status: 'completed' });

    expect(fetchJob).toHaveBeenCalledTimes(3);
  });

  it('fails at once when the job fails', async () => {
    const fetchJob = jest.fn().mockResolvedValue(job('failed'));

    await expect(pollJob(fetchJob, inAMinute(), 1)).rejects.toMatchObject({ reason: 'JOB_FAILED' });

    expect(fetchJob).toHaveBeenCalledTimes(1);
  });

  it('gives up at the deadline while the job is still running', async () => {
    const fetchJob = jest.fn().mockResolvedValue(job('in-progress'));

    await expect(pollJob(fetchJob, Date.now() + 20, 1)).rejects.toMatchObject({ reason: 'TIMEOUT' });
  });

  it('does not sleep past the deadline', async () => {
    const started = Date.now();
    const fetchJob = jest.fn().mockResolvedValue(job('in-progress'));

    await expect(pollJob(fetchJob, started + 30, 10000)).rejects.toMatchObject({ reason: 'TIMEOUT' });

    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('tolerates two failed polls in a row', async () => {
    const fetchJob = jest
      .fn()
      .mockRejectedValueOnce(new MigrationAgentError('UNREACHABLE'))
      .mockRejectedValueOnce(new MigrationAgentError('UNREACHABLE'))
      .mockResolvedValue(job('completed'));

    await expect(pollJob(fetchJob, inAMinute(), 1)).resolves.toMatchObject({ status: 'completed' });
  });

  it('counts failed polls in a row, so a success in between resets them', async () => {
    const fetchJob = jest
      .fn()
      .mockRejectedValueOnce(new MigrationAgentError('UNREACHABLE'))
      .mockRejectedValueOnce(new MigrationAgentError('UNREACHABLE'))
      .mockResolvedValueOnce(job('in-progress'))
      .mockRejectedValueOnce(new MigrationAgentError('UNREACHABLE'))
      .mockRejectedValueOnce(new MigrationAgentError('UNREACHABLE'))
      .mockResolvedValue(job('completed'));

    await expect(pollJob(fetchJob, inAMinute(), 1)).resolves.toMatchObject({ status: 'completed' });
  });

  it('gives up after three failed polls in a row and carries the last error', async () => {
    const cause = new MigrationAgentError('UNREACHABLE');
    const fetchJob = jest.fn().mockRejectedValue(cause);

    const error = await pollJob(fetchJob, inAMinute(), 1).catch((e) => e);

    expect(error).toBeInstanceOf(JobPollFailure);
    expect(error).toMatchObject({ reason: 'POLL_ERROR', cause });
    expect(fetchJob).toHaveBeenCalledTimes(3);
  });
});
