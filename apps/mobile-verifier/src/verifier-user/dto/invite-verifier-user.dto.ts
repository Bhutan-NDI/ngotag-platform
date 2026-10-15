import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty } from 'class-validator';

export class InviteVerifierUser {
  @ApiProperty({ name: 'email', example: 'john@example.com' })
  @Transform(({ value }) => ('string' === typeof value ? value.trim() : value))
  @IsEmail()
  @IsNotEmpty()
  email: string;
}
