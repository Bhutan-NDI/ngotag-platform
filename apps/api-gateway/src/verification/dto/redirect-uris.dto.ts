import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsNotEmpty,
  IsString,
  IsUrl,
  Matches
} from 'class-validator';
import { Transform } from 'class-transformer';
import { trim } from '@credebl/common/cast.helper';

/* eslint-disable camelcase */
export const REDIRECT_URI_VALIDATION_OPTIONS = {
  protocols: ['http', 'https'],
  require_protocol: true,
  require_tld: false
};
/* eslint-enable camelcase */

export class RedirectUrisDto {
  @ApiProperty({ example: ['https://relying-party.example/return'] })
  @IsArray({ message: 'redirectUris must be an array' })
  @ArrayNotEmpty({ message: 'redirectUris must not be empty' })
  @ArrayMaxSize(20, { message: 'A maximum of 20 redirect URIs can be registered' })
  @ArrayUnique({ message: 'Duplicate redirect URIs are not allowed' })
  @Transform(({ value }) => (Array.isArray(value) ? value.map((uri) => trim(uri)) : value))
  @IsString({ each: true, message: 'Each redirect URI must be a string' })
  @IsNotEmpty({ each: true, message: 'Redirect URIs must not be empty' })
  // Stored comma-separated on org_agents.
  @Matches(/^[^,]*$/, { each: true, message: 'Redirect URIs must not contain commas' })
  @IsUrl(REDIRECT_URI_VALIDATION_OPTIONS, { each: true, message: 'Each redirect URI must be a valid http(s) URL' })
  redirectUris: string[];
}
