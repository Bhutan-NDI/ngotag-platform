import { IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class PresentationExchangeDto {
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  @IsObject()
  credentials: Record<string, string>;
}

class ProofFormatsDto {
  @ApiProperty({ type: PresentationExchangeDto })
  @ValidateNested()
  @Type(() => PresentationExchangeDto)
  presentationExchange: PresentationExchangeDto;
}

export class ProofWithCredDto {
  @ApiProperty({ type: ProofFormatsDto })
  @ValidateNested()
  @Type(() => ProofFormatsDto)
  proofFormats: ProofFormatsDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  comment?: string;

  @ApiProperty({ example: '4e687079-273b-447b-b9dd-9589c84dc6dd' })
  @IsString({ message: 'proofRecordId must be a string' })
  @IsNotEmpty({ message: 'please provide valid proofRecordId' })
  @IsUUID()
  proofRecordId: string;
}
