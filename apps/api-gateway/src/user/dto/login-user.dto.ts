import { IsBoolean, IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { trim } from '@credebl/common/cast.helper';

export class LoginUserDto {
  @ApiProperty({ example: 'awqx@yopmail.com' })
  @IsEmail({}, { message: 'Please provide a valid email' })
  @IsNotEmpty({ message: 'Email is required' })
  @IsString({ message: 'Email should be a string' })
  @Transform(({ value }) => trim(value))
  email: string;

  @ApiProperty()
  @Transform(({ value }) => trim(value))
  @IsNotEmpty({ message: 'Password is required.' })
  password: string;

  @ApiPropertyOptional({ example: true, default: true, description: 'Indicates if the password is encrypted' })
  @IsOptional()
  @IsBoolean({ message: 'isPasswordEncrypted should be boolean' })
  isPasswordEncrypted?: boolean = true;
}

export class LoginUserNameDto {
  @ApiProperty({ example: '098f6bcd4621d373cade4e832627b4f6' })
  @IsNotEmpty({ message: 'Username is required' })
  @IsString({ message: 'Username should be a string' })
  @Transform(({ value }) => trim(value))
  username: string;

  @ApiProperty()
  @Transform(({ value }) => trim(value))
  @IsNotEmpty({ message: 'Password is required.' })
  password: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean({ message: 'isPasskey should be boolean' })
  isPasskey?: boolean;
}
