import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, ArrayNotEmpty, IsArray, IsNotEmpty, IsSemVer, IsString, ValidateNested } from 'class-validator';
import { DifProofRequestTemplatePayload } from './proof-request.dto';

export class ProofTemplateDto {
  @ApiProperty({ name: 'templateId', example: 'sample-id' })
  @IsString()
  @IsNotEmpty()
  templateId: string;

  @ApiProperty({ name: 'name', example: 'Foundational ID' })
  @IsString()
  @IsNotEmpty()
  name: string;

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

  @ApiProperty({ name: 'verifierRoleIds', example: ['123', '344'] })
  @ArrayNotEmpty()
  @ArrayMinSize(1)
  @IsArray()
  @IsString({ each: true })
  verifierRoleIds?: string[];
}
