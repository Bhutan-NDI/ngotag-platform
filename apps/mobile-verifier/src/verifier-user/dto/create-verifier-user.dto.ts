import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class CreateVerifierUser {
  @ApiProperty({ name: 'firstName', example: 'sonam' })
  @IsString()
  @IsNotEmpty({ message: 'firstName should not be empty' })
  firstName: string;

  @ApiProperty({ name: 'lastName', example: 'dorji' })
  @IsString()
  @IsNotEmpty({ message: 'lastName should not be empty' })
  lastName: string;

  @ApiProperty({ name: 'username', example: 'user1' })
  @IsString()
  @IsNotEmpty({ message: 'username should not be empty' })
  username: string;

  @ApiProperty({ name: 'foundationID', example: '123' })
  @IsString()
  @IsNotEmpty({ message: 'foundationID should not be empty' })
  foundationID: string;

  @ApiProperty({ name: 'email', example: 'verifier@example.com' })
  @IsEmail()
  @Transform(({ value }) => ('string' === typeof value ? value.trim() : value))
  @IsNotEmpty({ message: 'email should not be empty' })
  email: string;

  @ApiProperty({ name: 'verifierRoleId', example: 'Traffic Police' })
  @IsString()
  @IsNotEmpty({ message: 'verifierRoleId should not be empty' })
  verifierRoleId: string;
}
