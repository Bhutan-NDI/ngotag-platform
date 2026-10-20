/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type */
import { ForbiddenException } from '@nestjs/common';
import { OrgAgentMigrationAuthorizer } from './org-agent-migration.authorizer';

const ORG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const USER_ID = 'a1b2c3d4-5717-4562-b3fc-2c963f66afa6';

const build = (options: { owner?: boolean; active?: object | null } = {}) => {
  const migrationRepository = {
    isOrgOwner: jest.fn().mockResolvedValue(options.owner ?? false),
    getActiveByOrgId: jest.fn().mockResolvedValue('active' in options ? options.active : { id: 'm1' }),
    recordEvent: jest.fn().mockResolvedValue(undefined)
  };
  const logger = { warn: jest.fn(), error: jest.fn() };
  return {
    authorizer: new OrgAgentMigrationAuthorizer(migrationRepository as never, logger as never),
    migrationRepository,
    logger
  };
};

describe('OrgAgentMigrationAuthorizer', () => {
  it('lets an owner of the organisation through and audits nothing', async () => {
    const { authorizer, migrationRepository } = build({ owner: true });

    await expect(authorizer.assertOwner(ORG_ID, USER_ID)).resolves.toBeUndefined();

    expect(migrationRepository.isOrgOwner).toHaveBeenCalledWith(ORG_ID, USER_ID);
    expect(migrationRepository.recordEvent).not.toHaveBeenCalled();
  });

  it('refuses anyone who is not an owner there, and audits the refusal on the active migration', async () => {
    const { authorizer, migrationRepository, logger } = build({ owner: false });

    await expect(authorizer.assertOwner(ORG_ID, USER_ID)).rejects.toBeInstanceOf(ForbiddenException);

    expect(migrationRepository.recordEvent).toHaveBeenCalledWith('m1', { action: 'ACCESS_DENIED', actor: USER_ID });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('refuses a call with no user, without even looking up roles', async () => {
    const { authorizer, migrationRepository } = build({ owner: true });

    await expect(authorizer.assertOwner(ORG_ID, undefined as never)).rejects.toBeInstanceOf(ForbiddenException);

    expect(migrationRepository.isOrgOwner).not.toHaveBeenCalled();
  });

  it('still refuses when the org has no active migration to audit against', async () => {
    const { authorizer, migrationRepository } = build({ active: null });

    await expect(authorizer.assertOwner(ORG_ID, USER_ID)).rejects.toBeInstanceOf(ForbiddenException);

    expect(migrationRepository.recordEvent).not.toHaveBeenCalled();
  });

  it('still refuses when the audit write fails', async () => {
    const { authorizer, migrationRepository, logger } = build();
    migrationRepository.recordEvent.mockRejectedValue(new Error('db down'));

    await expect(authorizer.assertOwner(ORG_ID, USER_ID)).rejects.toBeInstanceOf(ForbiddenException);

    expect(logger.error).toHaveBeenCalled();
  });

  it('does not say which role the user does hold', async () => {
    const { authorizer } = build();

    const error = await authorizer.assertOwner(ORG_ID, USER_ID).catch((e) => e);

    expect(error.message).toBe('Only an owner of the organization can move its wallet');
  });
});
