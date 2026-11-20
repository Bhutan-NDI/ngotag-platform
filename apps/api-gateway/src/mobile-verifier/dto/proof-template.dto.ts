import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayNotEmpty,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsSemVer,
  IsString,
  ValidateNested
} from 'class-validator';
import { DifProofRequestTemplatePayload } from './proof-template-request.dto';

export class ProofTemplateDto {
  @ApiProperty({ name: 'templateId', example: 'sample-id' })
  @IsString()
  @IsNotEmpty()
  templateId: string;

  @ApiProperty({ name: 'name', example: 'Foundational ID' })
  @IsString()
  @IsNotEmpty()
  name: string;

  // Optional here: orgId can also be supplied as an `?orgId=` query param instead
  // (see resolveNgotagOrgId in ./functions.ts) — accepted in the body too since that's
  // what ngotag-studio already sends for create/update.
  @ApiPropertyOptional({ name: 'orgId', example: '1234' })
  @IsOptional()
  @IsString()
  orgId?: string;

  @ApiProperty({ name: 'description', example: 'Foundational ID' })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiProperty({ name: 'version', example: '1.0.0' })
  @IsString()
  @IsSemVer()
  @IsNotEmpty()
  version: string;

  @ApiProperty({ name: 'payload' })
  @IsNotEmpty()
  @ValidateNested()
  @Type(() => DifProofRequestTemplatePayload)
  payload: DifProofRequestTemplatePayload;

  @ApiPropertyOptional({ name: 'verifierRoleIds', example: ['123', '344'] })
  @IsOptional()
  @ArrayNotEmpty()
  @ArrayMinSize(1)
  @IsArray()
  @IsString({ each: true })
  verifierRoleIds?: string[];
}
