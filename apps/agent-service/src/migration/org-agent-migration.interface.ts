import { OrgAgentMigrationStatus } from '@credebl/enum/enum';

export interface ICreateOrgAgentMigration {
  orgId: string;
  userId: string;
  targetAdminEndpoint: string;
  targetDidcommEndpoint: string;
}

export interface IListOrgAgentMigrations {
  orgId?: string;
  status?: OrgAgentMigrationStatus;
  pageNumber?: number;
  pageSize?: number;
}
