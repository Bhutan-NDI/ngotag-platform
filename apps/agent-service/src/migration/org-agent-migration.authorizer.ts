import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ResponseMessages } from '@credebl/common/response-messages';
import { OrgAgentMigrationRepository } from '../repositories/org-agent-migration.repository';

/**
 * Only an organisation's OWNER may create, check or rehearse its move: the move hands the org's signing keys to
 * an address the owner chooses. The gateway enforces the role on the routes; this repeats the check where the keys
 * are actually moved, so a call that reaches agent-service by any other path is refused too.
 */
@Injectable()
export class OrgAgentMigrationAuthorizer {
  constructor(
    private readonly migrationRepository: OrgAgentMigrationRepository,
    private readonly logger: Logger
  ) {}

  /**
   * @throws ForbiddenException when the user is not an OWNER of the organisation; the refusal is audited on the
   * org's active migration when there is one
   */
  async assertOwner(orgId: string, userId: string): Promise<void> {
    if (userId && (await this.migrationRepository.isOrgOwner(orgId, userId))) {
      return;
    }

    this.logger.warn(`[migration] refused a non-owner: orgId ${orgId}, userId ${userId ?? 'none'}`);
    try {
      const active = await this.migrationRepository.getActiveByOrgId(orgId);
      if (active) {
        await this.migrationRepository.recordEvent(active.id, {
          action: 'ACCESS_DENIED',
          actor: userId ?? null
        });
      }
    } catch (error) {
      this.logger.error(`[migration] could not audit a refusal: ${error instanceof Error ? error.message : 'failed'}`);
    }
    throw new ForbiddenException(ResponseMessages.agent.error.migrationOwnerRequired);
  }
}
