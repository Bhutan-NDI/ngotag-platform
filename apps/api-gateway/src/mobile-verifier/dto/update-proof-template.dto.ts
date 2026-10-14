import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, ArrayNotEmpty, IsArray, IsOptional, IsSemVer, IsString, ValidateNested } from 'class-validator';
import { DifProofRequestTemplatePayload } from './proof-template-request.dto';

export class UpdateProofTemplateDto {
  @ApiPropertyOptional({ name: 'name', example: 'Foundational ID' })
  @IsOptional()
  @IsString()
  name?: string;

  // Optional here: orgId can also be supplied as an `?orgId=` query param instead
  // (see resolveNgotagOrgId in ./functions.ts).
  @ApiPropertyOptional({ name: 'orgId', example: '1234' })
  @IsOptional()
  @IsString()
  orgId?: string;

  @ApiPropertyOptional({ name: 'description', example: 'Foundational ID' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ name: 'version', example: '1.0.0' })
  @IsOptional()
  @IsString()
  @IsSemVer()
  version?: string;

  @ApiPropertyOptional({ name: 'payload' })
  @IsOptional()
  @ValidateNested()
  @Type(() => DifProofRequestTemplatePayload)
  payload?: DifProofRequestTemplatePayload;

  @ApiPropertyOptional({ name: 'verifierRoleIds', example: ['123', '344'] })
  @IsOptional()
  @ArrayNotEmpty()
  @ArrayMinSize(1)
  @IsArray()
  @IsString({ each: true })
  verifierRoleIds?: string[];
}
