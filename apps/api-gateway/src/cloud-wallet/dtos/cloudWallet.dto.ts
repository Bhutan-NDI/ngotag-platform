import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  Min,
  MinLength
} from 'class-validator';

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotSQLInjection, trim } from '@credebl/common/cast.helper';
import { Transform } from 'class-transformer';

export class CreateCloudWalletDto {
  @ApiProperty({ example: 'Credential Wallet', description: 'Cloud wallet label' })
  @IsString({ message: 'label must be a string' })
  @IsNotEmpty({ message: 'please provide valid label' })
  @Transform(({ value }) => trim(value))
  @IsNotSQLInjection({ message: 'label is required.' })
  label: string;

  @ApiProperty({ example: 'https://picsum.photos/200', description: 'Connection image URL' })
  @IsString({ message: 'Image URL must be a string' })
  @IsOptional()
  @IsNotEmpty({ message: 'please provide valid image URL' })
  @Transform(({ value }) => trim(value))
  @IsNotSQLInjection({ message: 'Image URL is required.' })
  connectionImageUrl?: string;

  email?: string;

  userId?: string;
}

export class ReceiveInvitationUrlDTO {
  @ApiPropertyOptional()
  @IsString({ message: 'alias must be a string' })
  @IsOptional()
  @IsNotEmpty({ message: 'please provide valid alias' })
  @Transform(({ value }) => trim(value))
  @IsNotSQLInjection({ message: 'alias is required.' })
  alias?: string;

  @ApiPropertyOptional()
  @IsString({ message: 'label must be a string' })
  @IsOptional()
  @IsNotEmpty({ message: 'please provide valid label' })
  @Transform(({ value }) => trim(value))
  @IsNotSQLInjection({ message: 'label is required.' })
  label?: string;

  @ApiPropertyOptional()
  @IsString({ message: 'Image URL must be a string' })
  @IsOptional()
  @IsNotEmpty({ message: 'please provide valid image URL' })
  @Transform(({ value }) => trim(value))
  @IsNotSQLInjection({ message: 'Image URL is required.' })
  imageUrl?: string;

  @ApiPropertyOptional()
  @IsBoolean({ message: 'autoAcceptConnection must be a boolean' })
  @Transform(({ value }) => trim(value))
  @IsOptional()
  autoAcceptConnection?: boolean;

  @ApiPropertyOptional()
  @IsBoolean({ message: 'autoAcceptInvitation must be a boolean' })
  @Transform(({ value }) => trim(value))
  @IsOptional()
  autoAcceptInvitation?: boolean;

  @ApiPropertyOptional()
  @IsBoolean({ message: 'reuseConnection must be a boolean' })
  @Transform(({ value }) => trim(value))
  @IsOptional()
  reuseConnection?: boolean;

  @ApiPropertyOptional()
  @IsInt({ message: 'acceptInvitationTimeoutMs must be an integer' })
  @Transform(({ value }) => trim(value))
  @IsOptional()
  acceptInvitationTimeoutMs?: number;

  @ApiPropertyOptional()
  @IsString({ message: 'ourDid must be a string' })
  @IsOptional()
  @IsNotEmpty({ message: 'please provide valid ourDid' })
  @Transform(({ value }) => trim(value))
  @IsNotSQLInjection({ message: 'ourDid is required.' })
  ourDid?: string;

  @ApiProperty()
  @IsString({ message: 'invitationUrl must be a string' })
  @IsNotEmpty({ message: 'please provide valid invitationUrl' })
  @Transform(({ value }) => trim(value))
  @IsNotSQLInjection({ message: 'invitationUrl is required.' })
  invitationUrl: string;

  email?: string;

  userId?: string;
}

export class AcceptOfferDto {
  @ApiPropertyOptional({
    example: 'always',
    description: 'autoAcceptCredential',
    enum: ['always', 'contentApproved', 'never']
  })
  @Transform(({ value }) => trim(value))
  @IsString({ message: 'autoAcceptCredential must be a string' })
  autoAcceptCredential: string;

  @ApiPropertyOptional({ example: 'string', description: 'Comment' })
  @Transform(({ value }) => trim(value))
  @IsString({ message: 'comment must be a string' })
  @IsOptional()
  comment?: string;

  @ApiProperty({ example: 'string', description: 'Credential record ID' })
  @Transform(({ value }) => trim(value))
  @IsString({ message: 'credentialRecordId must be a string' })
  credentialRecordId: string;

  @ApiProperty({ type: Object, description: 'Credential formats' })
  credentialFormats: object;

  email?: string;

  userId?: string;
}

export class CreateCloudWalletDidDto {
  @ApiProperty({ example: '000000000000000000000000000Seed1' })
  @MaxLength(32, { message: 'seed must be at most 32 characters.' })
  @Transform(({ value }) => trim(value))
  @IsOptional()
  @ApiPropertyOptional()
  @IsString({ message: 'seed must be in string format.' })
  @Matches(/^\S*$/, {
    message: 'Spaces are not allowed in seed'
  })
  seed?: string;

  @ApiProperty({ example: 'ed25519' })
  @IsNotEmpty({ message: 'key type is required' })
  @Transform(({ value }) => trim(value))
  @IsString({ message: 'key type be in string format.' })
  keyType: string;

  @ApiProperty({ example: 'indy' })
  @IsNotEmpty({ message: 'method is required' })
  @Transform(({ value }) => trim(value))
  @IsString({ message: 'method must be in string format.' })
  method: string;

  @ApiPropertyOptional({ example: 'bcovrin:testnet' })
  @IsOptional()
  @Transform(({ value }) => trim(value))
  @IsString({ message: 'network must be in string format.' })
  network?: string;

  @ApiPropertyOptional({ example: 'www.github.com' })
  @IsOptional()
  @Transform(({ value }) => trim(value))
  @IsString({ message: 'domain must be in string format.' })
  domain?: string;

  @ApiPropertyOptional({ example: 'endorser' })
  @IsOptional()
  @Transform(({ value }) => trim(value))
  @IsString({ message: 'role must be in string format.' })
  role?: string;

  @ApiPropertyOptional({ example: '651727dab6dfdbb4f18afff5f368d13b0dca41fd26bd5e1c7953457524d645e6' })
  @IsOptional()
  @IsString({ message: 'private key must be in string format.' })
  @Transform(({ value }) => trim(value))
  privatekey?: string;

  @ApiPropertyOptional({ example: 'http://localhost:6006/docs' })
  @IsOptional()
  @IsString({ message: 'endpoint must be in string format.' })
  endpoint?: string;

  @ApiPropertyOptional({ example: 'XzFjo1RTZ2h9UVFCnPUyaQ' })
  @IsOptional()
  @Transform(({ value }) => trim(value))
  @IsString({ message: 'did must be in string format.' })
  did?: string;

  @ApiPropertyOptional({ example: 'did:indy:bcovrin:testnet:UEeW111G1tYo1nEkPwMcF' })
  @IsOptional()
  @Transform(({ value }) => trim(value))
  @IsString({ message: 'endorser did must be in string format.' })
  endorserDid?: string;

  @ApiPropertyOptional({ example: 'false' })
  @IsOptional()
  @IsBoolean({ message: 'isDefault must be boolean value.' })
  isDefault?: boolean = false;

  email?: string;

  userId?: string;
}

export class CredentialListDto {
  @ApiProperty({ required: false })
  @IsNotEmpty()
  @IsOptional()
  @IsString()
  threadId: string;

  @ApiProperty({ required: false })
  @IsNotEmpty()
  @IsOptional()
  @IsString()
  connectionId: string;

  @ApiProperty({ required: false })
  @IsNotEmpty()
  @IsOptional()
  @IsString()
  state: string;

  email?: string;

  userId?: string;
}

export class GetAllCloudWalletConnectionsDto {
  @ApiProperty({ required: false, example: 'e315f30d-9beb-4068-aea4-abb5fe5eecb1' })
  @IsNotEmpty()
  @IsString()
  @IsOptional()
  outOfBandId: string;

  @ApiProperty({ required: false, example: 'Test' })
  @IsNotEmpty()
  @IsString()
  @IsOptional()
  alias: string;

  @ApiProperty({ required: false, example: 'did:example:e315f30d-9beb-4068-aea4-abb5fe5eecb1' })
  @IsNotEmpty()
  @IsString()
  @IsOptional()
  myDid: string;

  @ApiProperty({ required: false, example: 'did:example:e315f30d-9beb-4068-aea4-abb5fe5eecb1' })
  @IsNotEmpty()
  @IsString()
  @IsOptional()
  theirDid: string;

  @ApiProperty({ required: false, example: 'Bob' })
  @IsNotEmpty()
  @IsString()
  @IsOptional()
  theirLabel: string;

  email?: string;

  userId?: string;
}

export class BasicMessageDTO {
  @ApiProperty({ example: 'Message' })
  @IsNotEmpty({ message: 'content is required' })
  @Transform(({ value }) => trim(value))
  @IsString({ message: 'content should be in string format.' })
  content: string;

  email?: string;

  userId?: string;

  connectionId: string;
}

export class ExportCloudWalletDto {
  // @ApiProperty, not @ApiPropertyOptional: @IsNotEmpty makes this required at runtime (a 400
  // from the global ValidationPipe if omitted), but @ApiPropertyOptional advertised it as
  // optional in Swagger and excluded it from the generated model's `required` list -- a client
  // generated from this spec would treat POST /cloud-wallet/export-wallet as callable with an
  // empty body and get a 400 at runtime. See the #71 review.
  @ApiProperty({ example: 'XzFjo1RTZ2h9UVFCnPUyaQ' })
  @Transform(({ value }) => trim(value))
  @IsNotEmpty({ message: 'passKey is required' })
  @IsString({ message: 'passKey must be in string format.' })
  // Mirrors agent-controller's own MIN_PASSKEY_LENGTH (16) so a too-short passKey is a 400 with
  // a field-level message here, not an opaque failure after the NATS + agent round-trip. Without
  // this, an under-length passKey passed gateway validation, crossed NATS, ran checkUserExist +
  // _commonCloudWalletInfo + checkAgentHealth, and only then failed at the agent -- surfacing as
  // an opaque RpcException rather than a validation error, for a value that protects the exported
  // wallet artifact (a security property, not just ergonomics). See the #73 review.
  @MinLength(16, { message: 'passKey must be at least 16 characters' })
  passKey: string;

  // No walletID field — agent-controller's export endpoint (PR #72) takes the tenant id from the
  // path (server already knows it from cloud_wallet_user_info.tenantId) and only { passKey } in
  // the body. walletID had no counterpart on the agent side and was never read anywhere on the
  // platform side either — a required field forcing the client to send data the server owns.
  // See the #71 review's "DTO doesn't match agent-controller PR #72's export contract".

  email: string;

  userId: string;
}

// Matches the WalletPortabilityService's import contract exactly (exportUrl/checksum/passKey,
// the same three values a prior export job returns) — no exportId/walletID, those were
// legacy-Python-service concepts with no equivalent in the native design.
export class ImportCloudWalletDto {
  @ApiProperty({ example: 'https://example-bucket.s3.amazonaws.com/wallet-exports/...' })
  @Transform(({ value }) => trim(value))
  @IsNotEmpty({ message: 'exportUrl is required' })
  // require_tld: false so a self-hosted/MinIO export endpoint (http://minio:9000/..., a real
  // deployment topology) isn't rejected outright; protocols restricted to https since the only
  // legitimate value is a pre-signed URL for the platform's own export bucket — a bare @IsUrl()
  // accepted arbitrary http(s) targets, an authenticated SSRF surface into agent-controller's
  // server-side fetch. agent-controller's own downloadAndChecksum independently restricts to its
  // S3 hostname (see the #73 review) — this is defense in depth, not a duplicate of that fix.
  // eslint-disable-next-line camelcase
  @IsUrl({ require_tld: false, protocols: ['https'] }, { message: 'exportUrl must be a valid https URL' })
  exportUrl: string;

  @ApiProperty({ example: '4c63119399d4c98fb1dbc2b31943374c74e7026d75903828f0a2bae79ca2b4e' })
  @Transform(({ value }) => trim(value))
  @IsNotEmpty({ message: 'checksum is required' })
  @IsString({ message: 'checksum must be in string format.' })
  checksum: string;

  @ApiPropertyOptional({ example: 'XzFjo1RTZ2h9UVFCnPUyaQ' })
  @Transform(({ value }) => trim(value))
  @IsNotEmpty({ message: 'passKey is required' })
  @IsString({ message: 'passKey must be in string format.' })
  passKey: string;

  email: string;

  userId: string;
}

export class UpdateBaseWalletDto {
  // Optional, no default: this DTO is a partial update, and both fields being independently
  // omittable is the whole point -- {"isActive":false} alone must deactivate a wallet without
  // also being forced to resend its cap, and {"maxSubWallets":10000} alone must raise the cap
  // without silently reactivating a deactivated wallet (a plain property-initializer default
  // gets materialized by class-transformer even when the caller omits the key, since
  // @IsOptional() only skips validation, not construction). See the #71 review.
  @ApiPropertyOptional({
    example: 5,
    description: 'Maximum number of sub wallets allowed'
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxSubWallets?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'isActive must be a boolean' })
  isActive?: boolean;

  email?: string;
  userId?: string;
  walletId: string;
}
