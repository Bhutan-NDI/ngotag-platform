import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString, IsUrl, Matches, MaxLength } from 'class-validator';
import { toLowerCase, trim } from '@credebl/common/cast.helper';

import { Transform } from 'class-transformer';

export class UserEmailVerificationDto {
  @ApiProperty({ example: 'awqx@yopmail.com' })
  @Transform(({ value }) => trim(value))
  @Transform(({ value }) => toLowerCase(value))
  @IsNotEmpty({ message: 'Email is required.' })
  @MaxLength(256, { message: 'Email must be at most 256 character.' })
  @IsEmail({}, { message: 'Please provide a valid email' })
  email: string;

  @ApiPropertyOptional({ example: 'https://example.com/logo.png' })
  @Transform(({ value }) => trim(value))
  @IsOptional()
  @IsUrl(
    {
      // eslint-disable-next-line camelcase
      require_protocol: true,
      // eslint-disable-next-line camelcase
      require_tld: true
    },
    { message: 'brandLogoUrl should be a valid URL' }
  )
  brandLogoUrl?: string;

  @ApiPropertyOptional({ example: 'MyPlatform' })
  @Transform(({ value }) => trim(value))
  @IsOptional()
  @IsString({ message: 'platformName should be string' })
  platformName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: 'clientAlias should be string' })
  @Transform(({ value }) => trim(value))
  clientAlias?: string;

  // Caller-supplied path to return the user to after they verify their email (e.g. the
  // Microsoft Marketplace landing carrying its ?token=). Restricted to a relative,
  // same-origin path (must start with a single '/') to prevent open-redirects; when
  // omitted the service falls back to the client's configured domain.
  @ApiPropertyOptional({ example: '/marketplace/landing?token=abc123' })
  @Transform(({ value }) => trim(value))
  @IsOptional()
  @IsString({ message: 'redirectTo should be string' })
  @Matches(/^\/(?!\/)/, { message: 'redirectTo must be a relative path beginning with /' })
  redirectTo?: string;

  @ApiPropertyOptional({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsOptional()
  @IsString({ message: 'invitationId should be string' })
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
    message: 'invitationId must be a valid UUID'
  })
  invitationId?: string;
}
