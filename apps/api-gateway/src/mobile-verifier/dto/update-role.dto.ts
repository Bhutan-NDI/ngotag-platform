import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpdateRole {
  @ApiPropertyOptional({ name: 'role', example: 'Manager' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => ('string' === typeof value ? value.trim() : value))
  @IsNotEmpty()
  role?: string;

  // Optional here: orgId can also be supplied as an `?orgId=` query param instead
  // (see resolveNgotagOrgId in ./functions.ts).
  @ApiPropertyOptional({ name: 'orgId', example: 'orgid for the role' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => ('string' === typeof value ? value.trim() : value))
  orgId?: string;
}
