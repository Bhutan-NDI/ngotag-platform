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
}
