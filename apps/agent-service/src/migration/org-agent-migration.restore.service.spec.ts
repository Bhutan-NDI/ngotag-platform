/* eslint-disable camelcase, @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-explicit-any, prefer-destructuring */
/**
 * Disaster restore against an in-memory world: the migration, the org's agent row, the relay on the shared agent and
 * the invitation made on the lost agent.
 */
import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { OrgAgentMigrationStatus as Status } from '@credebl/enum/enum';
import { MigrationAgentError } from './migration-agent.client';
import { OrgAgentMigrationRestoreService } from './org-agent-migration.restore.service';

const MIGRATION_ID = '5b1b3b9e-6f56-4b69-9a54-0f2c2d6e1f10';
const ORG_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const ADMIN_ID = 'a1b2c3d4-5717-4562-b3fc-2c963f66afa6';
const SHARED = { endpoint: 'https://shared.example.com', token: 'base-token' };
const DEDICATED_ENDPOINT = 'https://admin.org.example.com';

const buildWorld = (rowOverrides: Record<string, unknown> = {}) => {
  const world = {
    leaseHeld: false,
    row: {
      id: MIGRATION_ID,
      orgId: ORG_ID,
      status: Status.STABILISING as string,
      tenantId: 'tenant-1',
      purgedAt: null,
      targetAdminEndpoint: DEDICATED_ENDPOINT,
      newInvitationDid: 'did:peer:2.new',
      error: null as string | null,
      sourceOrgAgentSnapshot: { agentEndPoint: SHARED.endpoint, tenantId: 'tenant-1', walletName: 'org-wallet' },
      ...rowOverrides
    } as Record<string, any>,
    orgAgent: {
      orgAgentTypeId: 'dedicated-type',
      agentEndPoint: DEDICATED_ENDPOINT,
      tenantId: null as string | null,
      walletName: 'org-wallet',
      apiKey: 'DEDICATED-TOKEN-CIPHER' as string | null
    },
    relay: 'FORWARD' as 'FORWARD' | 'none',
    heldMessages: 2,
    invitations: ['did:peer:2.legacy', 'did:peer:2.new'],
    events: [] as { action: string; actor: unknown; detail?: unknown }[],
    order: [] as string[]
  };

  const migrationRepository = {
    getActiveByOrgId: jest.fn(async () => (world.row ? { ...world.row } : null)),
    // A lease stays held until it is given back, as the real one does until it runs out.
    tryAcquireLease: jest.fn(async () => {
      world.order.push('lease');
      if (world.leaseHeld) {
        return false;
      }
      world.leaseHeld = true;
      return true;
    }),
    releaseLease: jest.fn(async () => {
      world.leaseHeld = false;
    }),
    recordEvent: jest.fn(async (_id: string, entry: { action: string; actor: unknown; detail?: unknown }) => {
      world.events.push(entry);
    }),
    restoreOrgAgent: jest.fn(async (params: any) => {
      world.order.push('flip');
      if (world.row.status !== Status.STABILISING) {
        throw new ConflictException('changed');
      }
      if (
        world.orgAgent.orgAgentTypeId !== params.dedicatedOrgAgentTypeId ||
        world.orgAgent.agentEndPoint !== params.expectedAgentEndPoint
      ) {
        throw new ConflictException('agent row changed');
      }
      Object.assign(world.orgAgent, {
        orgAgentTypeId: params.sharedOrgAgentTypeId,
        agentEndPoint: params.agentEndPoint,
        tenantId: params.tenantId,
        walletName: params.walletName,
        apiKey: null
      });
      world.row.status = Status.DISASTER_RESTORED;
      const before = world.invitations.length;
      world.invitations = world.invitations.filter((did) => did !== params.newInvitationDid);
      return { migration: { ...world.row }, invitationsRemoved: before - world.invitations.length };
    })
  } as Record<string, jest.Mock>;
  const agentServiceRepository = {
    getOrgAgentTypeDetails: jest.fn(async (type: string) => ('SHARED' === type ? 'shared-type' : 'dedicated-type'))
  };
  const access = { shared: jest.fn(async () => SHARED) };
  const agentClient = {
    restoreRelay: jest.fn(async () => {
      world.order.push('relay');
      if ('none' === world.relay) {
        throw new MigrationAgentError('NOT_FOUND', 404);
      }
      world.relay = 'none';
      const injected = world.heldMessages;
      world.heldMessages = 0;
      return { injected, failed: 0 };
    })
  } as Record<string, jest.Mock>;
  const alertService = { alertKeyExport: jest.fn(async () => ({ recipients: 3, sent: 3 })) } as Record<
    string,
    jest.Mock
  >;
  const logger = { error: jest.fn(), warn: jest.fn() };
  const service = new OrgAgentMigrationRestoreService(
    migrationRepository as never,
    agentServiceRepository as never,
    access as never,
    agentClient as never,
    alertService as never,
    logger as never
  );
  return { world, service, migrationRepository, agentServiceRepository, access, agentClient, alertService, logger };
};

describe('OrgAgentMigrationRestoreService', () => {
  describe('rolling a move back', () => {
    it('takes the relay off, gives the org back to the shared agent and marks the move DISASTER_RESTORED', async () => {
      const { service, world } = buildWorld();

      const restored = await service.restore(ORG_ID, ADMIN_ID);

      expect(restored.status).toBe(Status.DISASTER_RESTORED);
      expect(world.relay).toBe('none');
      expect(world.orgAgent).toEqual({
        orgAgentTypeId: 'shared-type',
        agentEndPoint: SHARED.endpoint,
        tenantId: 'tenant-1',
        walletName: 'org-wallet',
        apiKey: null
      });
    });

    it('takes the relay off before the org is switched back, so messages reach the shared wallet first', async () => {
      const { service, world } = buildWorld();

      await service.restore(ORG_ID, ADMIN_ID);

      expect(world.order).toEqual(['lease', 'relay', 'flip']);
    });

    it('asks the shared agent to restore the relay of the org tenant, with the base-wallet token', async () => {
      const { service, agentClient } = buildWorld();

      await service.restore(ORG_ID, ADMIN_ID);

      expect(agentClient.restoreRelay).toHaveBeenCalledWith(SHARED.endpoint, SHARED.token, 'tenant-1');
    });

    it('switches back only the row the move created, using what was saved before the move', async () => {
      const { service, migrationRepository } = buildWorld();

      await service.restore(ORG_ID, ADMIN_ID);

      expect(migrationRepository.restoreOrgAgent).toHaveBeenCalledWith({
        migrationId: MIGRATION_ID,
        orgId: ORG_ID,
        expectedAgentEndPoint: DEDICATED_ENDPOINT,
        sharedOrgAgentTypeId: 'shared-type',
        dedicatedOrgAgentTypeId: 'dedicated-type',
        agentEndPoint: SHARED.endpoint,
        tenantId: 'tenant-1',
        walletName: 'org-wallet',
        lastChangedBy: ADMIN_ID,
        actor: ADMIN_ID,
        newInvitationDid: 'did:peer:2.new'
      });
    });

    it('removes the invitation made on the lost agent and keeps the old one', async () => {
      const { service, world } = buildWorld();

      await service.restore(ORG_ID, ADMIN_ID);

      expect(world.invitations).toEqual(['did:peer:2.legacy']);
    });

    it('records who did it, what came back and what was lost', async () => {
      const { service, world } = buildWorld();

      await service.restore(ORG_ID, ADMIN_ID);

      expect(world.events).toEqual([
        {
          action: 'DISASTER_RESTORED',
          actor: ADMIN_ID,
          detail: { relayWasAlreadyOff: false, messagesReturned: 2, messagesLost: 0, invitationsRemoved: 1 }
        }
      ]);
    });

    it('counts messages that could not be handed back as lost', async () => {
      const { service, world, agentClient } = buildWorld();
      agentClient.restoreRelay.mockResolvedValue({ injected: 1, failed: 2 });

      await service.restore(ORG_ID, ADMIN_ID);

      expect(world.events[0].detail).toMatchObject({ messagesReturned: 1, messagesLost: 2 });
    });

    it('alerts the owners and platform admins, naming the admin who did it', async () => {
      const { service, alertService } = buildWorld();

      await service.restore(ORG_ID, ADMIN_ID);

      expect(alertService.alertKeyExport).toHaveBeenCalledWith(
        expect.objectContaining({ id: MIGRATION_ID }),
        'DISASTER_RESTORE',
        ADMIN_ID
      );
    });

    it('still restores when the alert cannot be sent', async () => {
      const { service, alertService, logger } = buildWorld();
      alertService.alertKeyExport.mockRejectedValue(new Error('smtp down'));

      await expect(service.restore(ORG_ID, ADMIN_ID)).resolves.toMatchObject({ status: Status.DISASTER_RESTORED });

      expect(logger.error).toHaveBeenCalled();
    });

    it('still restores when the audit write fails', async () => {
      const { service, migrationRepository } = buildWorld();
      migrationRepository.recordEvent.mockRejectedValue(new Error('db down'));

      await expect(service.restore(ORG_ID, ADMIN_ID)).resolves.toMatchObject({ status: Status.DISASTER_RESTORED });
    });
  });

  describe('when it is not allowed', () => {
    it.each([
      Status.CREATED,
      Status.REHEARSED,
      Status.FROZEN,
      Status.CUTOVER,
      Status.ROTATING,
      Status.COMPLETED,
      Status.FAILED
    ])('refuses a move in %s: only the stabilisation window can be rolled back', async (status) => {
      const world = buildWorld({ status });

      await expect(world.service.restore(ORG_ID, ADMIN_ID)).rejects.toBeInstanceOf(BadRequestException);

      expect(world.agentClient.restoreRelay).not.toHaveBeenCalled();
      expect(world.migrationRepository.restoreOrgAgent).not.toHaveBeenCalled();
    });

    it('refuses once the shared copy has been purged', async () => {
      const world = buildWorld({ purgedAt: new Date() });

      await expect(world.service.restore(ORG_ID, ADMIN_ID)).rejects.toBeInstanceOf(BadRequestException);

      expect(world.agentClient.restoreRelay).not.toHaveBeenCalled();
    });

    it('refuses an org with no active move', async () => {
      const world = buildWorld();
      world.migrationRepository.getActiveByOrgId.mockResolvedValue(null);

      await expect(world.service.restore(ORG_ID, ADMIN_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([
      ['no saved agent endpoint', { sourceOrgAgentSnapshot: { tenantId: 't', walletName: 'w' } }],
      ['no saved tenant', { sourceOrgAgentSnapshot: { agentEndPoint: SHARED.endpoint, walletName: 'w' } }],
      ['no snapshot at all', { sourceOrgAgentSnapshot: null }],
      ['no tenant on the move', { tenantId: null }]
    ])('refuses a move with %s, touching nothing', async (_name, overrides) => {
      const world = buildWorld(overrides);

      await expect(world.service.restore(ORG_ID, ADMIN_ID)).rejects.toBeInstanceOf(BadRequestException);

      expect(world.agentClient.restoreRelay).not.toHaveBeenCalled();
      expect(world.migrationRepository.tryAcquireLease).not.toHaveBeenCalled();
    });

    it('refuses while something else holds the move, and touches nothing', async () => {
      const world = buildWorld();
      world.migrationRepository.tryAcquireLease.mockResolvedValue(false);

      await expect(world.service.restore(ORG_ID, ADMIN_ID)).rejects.toBeInstanceOf(ConflictException);

      expect(world.agentClient.restoreRelay).not.toHaveBeenCalled();
      expect(world.world.orgAgent.orgAgentTypeId).toBe('dedicated-type');
    });
  });

  describe('when something goes wrong', () => {
    it('leaves the org on the dedicated agent when the shared agent cannot be reached, and works on a retry', async () => {
      const world = buildWorld();
      world.agentClient.restoreRelay.mockRejectedValueOnce(new MigrationAgentError('UNREACHABLE'));

      await expect(world.service.restore(ORG_ID, ADMIN_ID)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(world.world.orgAgent.orgAgentTypeId).toBe('dedicated-type');
      expect(world.migrationRepository.restoreOrgAgent).not.toHaveBeenCalled();

      await expect(world.service.restore(ORG_ID, ADMIN_ID)).resolves.toMatchObject({
        status: Status.DISASTER_RESTORED
      });
    });

    it('gives the lease back after a failed attempt, so a retry can start at once', async () => {
      const world = buildWorld();
      world.agentClient.restoreRelay.mockRejectedValueOnce(new MigrationAgentError('UNREACHABLE'));

      await world.service.restore(ORG_ID, ADMIN_ID).catch(() => undefined);

      expect(world.migrationRepository.releaseLease).toHaveBeenCalledWith(MIGRATION_ID);
      expect(world.world.leaseHeld).toBe(false);
    });

    it('gives the lease back after a restore that worked too', async () => {
      const world = buildWorld();

      await world.service.restore(ORG_ID, ADMIN_ID);

      expect(world.migrationRepository.releaseLease).toHaveBeenCalledTimes(1);
    });

    it('does not take the lease away from whoever holds it when it refuses', async () => {
      const world = buildWorld();
      world.world.leaseHeld = true;

      await expect(world.service.restore(ORG_ID, ADMIN_ID)).rejects.toBeInstanceOf(ConflictException);

      expect(world.migrationRepository.releaseLease).not.toHaveBeenCalled();
      expect(world.world.leaseHeld).toBe(true);
    });

    it('answers busy, and frees the lease, while the agent is still handing queued messages back', async () => {
      const world = buildWorld();
      world.agentClient.restoreRelay.mockRejectedValue(new MigrationAgentError('CONFLICT', 409, 'RELAY_BUSY'));

      await expect(world.service.restore(ORG_ID, ADMIN_ID)).rejects.toBeInstanceOf(ConflictException);

      expect(world.migrationRepository.releaseLease).toHaveBeenCalledTimes(1);
      expect(world.world.orgAgent.orgAgentTypeId).toBe('dedicated-type');
    });

    it('refuses without changing the org when the shared copy is already purged', async () => {
      const world = buildWorld();
      world.agentClient.restoreRelay.mockRejectedValue(new MigrationAgentError('CONFLICT', 409, 'TENANT_PURGED'));

      await expect(world.service.restore(ORG_ID, ADMIN_ID)).rejects.toBeInstanceOf(BadRequestException);

      expect(world.migrationRepository.restoreOrgAgent).not.toHaveBeenCalled();
    });

    it('treats a relay that is already gone as done, which is how a half-finished restore is completed', async () => {
      const world = buildWorld();
      world.world.relay = 'none';

      const restored = await world.service.restore(ORG_ID, ADMIN_ID);

      expect(restored.status).toBe(Status.DISASTER_RESTORED);
      expect(world.world.events[0].detail).toMatchObject({ relayWasAlreadyOff: true, messagesReturned: 0 });
    });

    it('can be repeated after the relay was taken off but the org row was not switched back', async () => {
      const world = buildWorld();
      world.migrationRepository.restoreOrgAgent.mockRejectedValueOnce(new Error('connection reset'));
      await expect(world.service.restore(ORG_ID, ADMIN_ID)).rejects.toThrow('connection reset');
      expect(world.world.relay).toBe('none');

      await expect(world.service.restore(ORG_ID, ADMIN_ID)).resolves.toMatchObject({
        status: Status.DISASTER_RESTORED
      });

      expect(world.world.orgAgent.orgAgentTypeId).toBe('shared-type');
    });

    it('does not switch the org back when its agent row is no longer the one the move made', async () => {
      const world = buildWorld();
      world.world.orgAgent.agentEndPoint = 'https://changed.example.com';

      await expect(world.service.restore(ORG_ID, ADMIN_ID)).rejects.toBeInstanceOf(ConflictException);

      expect(world.world.row.status).toBe(Status.STABILISING);
      expect(world.world.invitations).toContain('did:peer:2.new');
    });

    it('cannot find the shared agent without its token', async () => {
      const world = buildWorld();
      world.access.shared.mockResolvedValue(undefined);

      await expect(world.service.restore(ORG_ID, ADMIN_ID)).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(world.migrationRepository.restoreOrgAgent).not.toHaveBeenCalled();
    });

    it('never logs a token', async () => {
      const world = buildWorld();
      world.agentClient.restoreRelay.mockRejectedValue(new MigrationAgentError('UNREACHABLE'));

      await world.service.restore(ORG_ID, ADMIN_ID).catch(() => undefined);

      expect(JSON.stringify([...world.logger.error.mock.calls, ...world.logger.warn.mock.calls])).not.toMatch(
        /base-token|DEDICATED-TOKEN/
      );
    });
  });
});
