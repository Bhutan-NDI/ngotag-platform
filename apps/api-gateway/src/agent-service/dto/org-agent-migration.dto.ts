import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString, IsUrl, IsUUID, Max, Min, IsInt } from 'class-validator';
import { trim } from '@credebl/common/cast.helper';
import { OrgAgentMigrationStatus } from '@credebl/enum/enum';

const HTTPS_ONLY = {
  // eslint-disable-next-line camelcase
  require_protocol: true,
  // eslint-disable-next-line camelcase
  disallow_auth: true,
  protocols: ['https']
};

// The org and the user are never read from a body: the org comes from the path and the user from the token.
export class CreateOrgAgentMigrationDto {
  @ApiProperty({
    example: 'https://admin.agent.example.org',
    description: "The dedicated agent's admin address, reachable from the platform"
  })
  @IsString({ message: 'targetAdminEndpoint must be in string format.' })
  @IsNotEmpty({ message: 'targetAdminEndpoint is required.' })
  @IsUrl(HTTPS_ONLY, { message: 'targetAdminEndpoint must be an https URL.' })
  @Transform(({ value }) => trim(value))
  targetAdminEndpoint: string;

  @ApiProperty({
    example: 'https://didcomm.agent.example.org',
    description: "The dedicated agent's public DIDComm address, which citizens' wallets will reach"
  })
  @IsString({ message: 'targetDidcommEndpoint must be in string format.' })
  @IsNotEmpty({ message: 'targetDidcommEndpoint is required.' })
  @IsUrl(HTTPS_ONLY, { message: 'targetDidcommEndpoint must be an https URL.' })
  @Transform(({ value }) => trim(value))
  targetDidcommEndpoint: string;

  @ApiProperty({ description: "The dedicated agent's API key. It is exchanged for a token and never stored." })
  @IsString({ message: 'apiKey must be in string format.' })
  @IsNotEmpty({ message: 'apiKey is required.' })
  apiKey: string;

  @ApiPropertyOptional({
    description: "The owner confirms the new agent's wallet database is backed up. Preflight fails until they do."
  })
  @IsOptional()
  @IsBoolean({ message: 'backupsConfirmed must be a boolean.' })
  backupsConfirmed?: boolean;
}

export class PreflightOrgAgentMigrationDto {
  @ApiPropertyOptional({
    description: 'Send the API key again only to replace the token kept from an earlier check.'
  })
  @IsOptional()
  @IsString({ message: 'apiKey must be in string format.' })
  @IsNotEmpty({ message: 'apiKey must not be empty.' })
  apiKey?: string;

  @ApiPropertyOptional({ description: 'Confirm the new agent’s wallet database is backed up.' })
  @IsOptional()
  @IsBoolean({ message: 'backupsConfirmed must be a boolean.' })
  backupsConfirmed?: boolean;
}

export class ListOrgAgentMigrationsDto {
  // Not named `orgId`: OrgRolesGuard reads req.query.orgId and, whenever it finds one, checks org membership
  // instead of the PLATFORM_ADMIN role, which would refuse an admin who is not a member of that org.
  @ApiPropertyOptional({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsOptional()
  @IsUUID('4', { message: 'targetOrgId must be a valid UUID.' })
  @Transform(({ value }) => trim(value))
  targetOrgId?: string;

  @ApiPropertyOptional({ enum: OrgAgentMigrationStatus })
  @IsOptional()
  @IsEnum(OrgAgentMigrationStatus, { message: 'status must be a known migration status.' })
  status?: OrgAgentMigrationStatus;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'Page number must be greater than 0' })
  pageNumber?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'Page size must be greater than 0' })
  @Max(100, { message: 'Page size must be 100 or less' })
  pageSize?: number;
}
