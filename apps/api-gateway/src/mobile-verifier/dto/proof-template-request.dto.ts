import { ApiProperty } from '@nestjs/swagger';
import { ProofRequestType } from './proof-request-type.enum';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsEnum, IsNotEmpty, IsString, ValidateNested } from 'class-validator';

export class StringDto {
  @IsString()
  value: string;
}

export class DifProofRequestTemplatePayloadData {
  @ApiProperty({ name: 'schemaName', example: 'Foundational ID' })
  @IsString()
  @IsNotEmpty()
  schemaName: string;

  @ApiProperty({ example: ['IDType', 'IDNumber'] })
  @IsString({ each: true })
  @ArrayMinSize(1)
  @IsArray({ message: 'names should be an array' })
  @Type(() => Array<string>)
  names: StringDto[];

  @ApiProperty({ name: 'schema', example: 'https://schema.credebl.id/schemas/117c7860-489b-4cbb-ab64-bc7b13180da7' })
  @IsNotEmpty()
  @IsString()
  schema: string;
}

export class DifProofRequestTemplatePayload {
  @ApiProperty({ example: ProofRequestType.DIF })
  @IsEnum(ProofRequestType)
  type: ProofRequestType = ProofRequestType.DIF;

  @ApiProperty({ type: [DifProofRequestTemplatePayloadData] })
  @IsNotEmpty()
  @ValidateNested()
  @ArrayMinSize(1)
  @IsArray({ message: 'data should be an array' })
  @Type(() => DifProofRequestTemplatePayloadData)
  data: DifProofRequestTemplatePayloadData[];
}
