import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsNotEmpty, IsObject, IsOptional, IsString, IsUrl, ValidateNested } from 'class-validator';

export class OAuth2V1Data {
  @ApiProperty({ example: 'https://example.com/oauth2/token' })
  @IsString()
  @IsNotEmpty()
  url: string;

  @ApiProperty({ example: 'client_credentials' })
  @IsString()
  @IsNotEmpty()
  grantType: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  clientId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  clientSecret: string;
}

export class OAuth2V2Data {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  token: string;
}

export class AuthenticationDto {
  @ApiProperty({ example: 'OAuth2' })
  @IsIn(['OAuth2'])
  type: 'OAuth2';

  @ApiProperty({ example: 'v2' })
  @IsIn(['v1', 'v2'])
  version: 'v1' | 'v2';

  // Shape depends on `version` (OAuth2V1Data | OAuth2V2Data) — validated in the service
  // against the matching class rather than here, since class-validator can't discriminate
  // a nested object's shape by a sibling field on its own.
  @ApiProperty()
  @IsObject()
  data: OAuth2V1Data | OAuth2V2Data;
}

export class CreateVerifierWebhook {
  @ApiProperty({ name: 'webhookId', example: 'my-org-webhook' })
  @IsString()
  @Transform(({ value }) => ('string' === typeof value ? value.trim() : value))
  @IsNotEmpty()
  webhookId: string;

  @ApiProperty({ name: 'webhookUrl', example: 'https://example.com/webhook' })
  @IsString()
  @Transform(({ value }) => ('string' === typeof value ? value.trim() : value))
  // require_tld: false — a client system's webhook can legitimately be a local dev
  // address (e.g. http://localhost:3002/webhook), which has no top-level domain.
  // eslint-disable-next-line camelcase -- class-validator option name
  @IsUrl({ require_tld: false }, { message: 'webhookUrl is not valid' })
  webhookUrl: string;

  @ApiProperty({ name: 'authentication' })
  @IsNotEmpty()
  @ValidateNested()
  @Type(() => AuthenticationDto)
  authentication: AuthenticationDto;

  @ApiPropertyOptional({ name: 'orgId', example: '1234' })
  @IsOptional()
  @IsString()
  orgId?: string;
}
