import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateRole {
  @ApiProperty({ name: 'role', example: 'Manager' })
  @IsString()
  @Transform(({ value }) => ('string' === typeof value ? value.trim() : value))
  @IsNotEmpty()
  role: string;

  // Optional here: orgId can also be supplied as an `?orgId=` query param instead
  // (see resolveNgotagOrgId in ./functions.ts) — accepted in the body too since that's
  // what ngotag-studio already sends for create/update.
  @ApiPropertyOptional({ name: 'orgId', example: 'orgid for the role' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => ('string' === typeof value ? value.trim() : value))
  orgId?: string;
}
