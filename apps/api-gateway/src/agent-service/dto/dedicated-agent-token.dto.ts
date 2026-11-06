import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, IsUrl, IsUUID } from 'class-validator';
import { trim } from '@credebl/common/cast.helper';

export class SetDedicatedAgentTokenDto {
  // Not named `orgId`: OrgRolesGuard reads req.params/query/body.orgId and, whenever it finds one,
  // takes the org-membership branch instead of the PLATFORM_ADMIN branch, which would 403 a platform
  // admin who is not a member of the target org.
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsUUID('4', { message: 'targetOrgId must be a valid UUID.' })
  @IsNotEmpty()
  @Transform(({ value }) => trim(value))
  targetOrgId: string;

  @ApiProperty({ description: 'Token minted on the agent via POST /agent/token using its own API_KEY.' })
  @IsString({ message: 'agentToken must be in string format.' })
  @IsNotEmpty({ message: 'agentToken is required.' })
  @Transform(({ value }) => trim(value))
  agentToken: string;

  // Caller states where they expect the token to go; the service refuses if it no longer matches the
  // stored row, so a tampered agentEndPoint cannot silently redirect a third party's credential.
  @ApiProperty({ example: 'https://agent.example.com' })
  @IsString({ message: 'agentEndPoint must be in string format.' })
  @IsNotEmpty({ message: 'agentEndPoint is required.' })
  @IsUrl({
    // eslint-disable-next-line camelcase
    require_protocol: true,
    protocols: ['https']
  })
  @Transform(({ value }) => trim(value))
  agentEndPoint: string;
}
