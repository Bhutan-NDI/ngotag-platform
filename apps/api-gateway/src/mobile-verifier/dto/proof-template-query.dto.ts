import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

// Single canonical copy — the platform's api-gateway route no longer needs a separate
// duplicate under src/proof/dto (both copied the same shape; `roleId` is the only field
// this DTO's consumers actually read, see ProofTemplateService.getRoleProofTemplates).
export class ProofTemplateQueryDto {
  @ApiProperty()
  @IsNotEmpty()
  @Transform(({ value }) => (value ? value.toString() : value))
  @IsString()
  roleId: string;

  @ApiPropertyOptional({ name: 'page', example: '1' })
  @IsOptional()
  @IsNotEmpty()
  @IsInt()
  @Transform(({ value }: TransformFnParams) => (value ? Number(value) : 1))
  @Min(1, { message: 'Page must not be less than 1' })
  page?: number = 1;

  @ApiPropertyOptional({ name: 'pageSize', example: '10' })
  @IsOptional()
  @IsNotEmpty()
  @IsInt()
  @Transform(({ value }: TransformFnParams) => (value ? Number(value) : 10))
  @Min(1, { message: 'pageSize must not be less than 1' })
  pageSize?: number = 10;

  @ApiPropertyOptional({ name: 'search' })
  @IsOptional()
  @IsNotEmpty()
  @Transform(({ value }) => (value ? value.toString() : undefined))
  @IsString()
  search?: string;
}
