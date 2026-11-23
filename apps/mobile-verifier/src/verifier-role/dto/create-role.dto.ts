import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateRole {
  @ApiProperty({ name: 'role', example: 'Manager' })
  @IsString()
  @Transform(({ value }) => ('string' === typeof value ? value.trim() : value))
  @IsNotEmpty()
  role: string;
}
