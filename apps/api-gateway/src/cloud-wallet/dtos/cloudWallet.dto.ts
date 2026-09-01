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

  // Required, not optional -- the agent's own contract (ReceiveInvitationByUrlProps /
  // AcceptInvitationConfig) has always required label; a missing one previously traveled all the
  // way to the agent and came back as an opaque error instead of a clear local validation failure.
  @ApiProperty()
  @IsString({ message: 'label must be a string' })
  @IsNotEmpty({ message: 'please provide valid label' })
  @Transform(({ value }) => trim(value))
  @IsNotSQLInjection({ message: 'label is required.' })
  label: string;

  @ApiPropertyOptional()
  @IsString({ message: 'Image URL must be a string' })
  @IsOptional()
  @IsNotEmpty({ message: 'please provide valid image URL' })
  @Transform(({ value }) => trim(value))
  @IsNotSQLInjection({ message: 'Image URL is required.' })
  imageUrl?: string;

  // trim() (cast.helper.ts) only handles strings -- returns undefined for anything else, so
  // @Transform(trim) here was silently wiping every boolean sent, regardless of value. Dropped;
  // trimming a boolean/int was never meaningful.
  @ApiPropertyOptional()
  @IsBoolean({ message: 'autoAcceptConnection must be a boolean' })
  @IsOptional()
  autoAcceptConnection?: boolean;

  @ApiPropertyOptional()
  @IsBoolean({ message: 'autoAcceptInvitation must be a boolean' })
  @IsOptional()
  autoAcceptInvitation?: boolean;

  @ApiPropertyOptional()
  @IsBoolean({ message: 'reuseConnection must be a boolean' })
  @IsOptional()
  reuseConnection?: boolean;

  @ApiPropertyOptional()
  @IsInt({ message: 'acceptInvitationTimeoutMs must be an integer' })
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
  // This validates a well-formed https URL, not a MinIO/self-hosted endpoint -- the only
  // legitimate value is a pre-signed URL for agent-controller's own S3-only export bucket
  // (agent-controller's downloadAndChecksum independently restricts to its S3 hostname; MinIO
  // isn't a supported target on either side). require_protocol: true is what actually closes the
  // gap this review found -- class-validator's @IsUrl defaults require_protocol to false, so
  // protocols: ['https'] was only consulted when a scheme was present, and a scheme-less payload
  // like '169.254.169.254/latest/meta-data/' passed gateway validation entirely, surfacing only
  // as an opaque failure later in the poll response instead of a clean 400 at the edge. This is
  // defense in depth, not a duplicate of agent-controller's own fix -- notably it does NOT stop
  // an https URL pointing at a bare IP (e.g. a metadata endpoint, `https://169.254.169.254/...`);
  // the agent-side bucket hostname allowlist is what rules that out.
  //
  // require_tld deliberately NOT set to false: every legitimate S3 hostname shape (virtual-hosted,
  // region-qualified, path-style, dotted bucket name) already ends in `.com`/`.cn` and passes with
  // the default require_tld: true -- verified empirically against this repo's installed validator
  // version. Setting it false buys nothing for S3, but does let bare/internal hostnames like
  // `https://minio-internal/...` or `https://localhost:9000/...` pass this check, reopening the
  // exact SSRF surface this validator exists to narrow. See the #73 review.
  @IsUrl(
    // eslint-disable-next-line camelcase -- class-validator's own IsUrlOptions field names
    { require_protocol: true, protocols: ['https'] },
    { message: 'exportUrl must be a valid https URL' }
  )
  exportUrl: string;

  // Example is a genuine 64-char SHA-256 hex digest (matches VALID_BODY in this DTO's own
  // checksum.spec.ts) -- the previous example was 63 characters, one short of what the @Matches
  // validator below requires, so Swagger UI's "Try it out" prefilled body 400'd on this field
  // with nothing hinting the example itself was malformed. See the #73 review.
  @ApiProperty({ example: 'b06a1534375273fdd838693e45ce17aded75b0e73524768a92078d8c621419c9' })
  // Lowercased, not just trimmed -- the @Matches validator below is case-insensitive (/i) and
  // this DTO's own test suite deliberately accepts an uppercase digest as a convenience, but
  // agent-controller's own comparison (WalletPortabilityService.gzipAndChecksum returns
  // hash.digest('hex'), always lowercase, compared with !==) is case-sensitive. Without
  // normalizing here, a correct-but-uppercased checksum passed gateway validation, crossed NATS,
  // consumed the tenant's only portability slot, and streamed the whole artifact down from S3 --
  // only to fail "Checksum mismatch" at the agent for a digest that was arithmetically right.
  // See the #73 review.
  @Transform(({ value }) => trim(value)?.toLowerCase())
  @IsNotEmpty({ message: 'checksum is required' })
  @IsString({ message: 'checksum must be in string format.' })
  // A bare non-empty-string check let any malformed value through to start real import work
  // before agent-controller's own checksum comparison ever ran. Validating the exact expected
  // SHA-256 hex representation here rejects a malformed request at the edge instead of relying
  // on the agent to reject attacker-controlled integrity data after a job has already started.
  // See the #73 review.
  @Matches(/^[a-f0-9]{64}$/i, { message: 'checksum must be a 64-character hexadecimal SHA-256 digest' })
  checksum: string;

  // @ApiProperty, not @ApiPropertyOptional: @IsNotEmpty makes this required at runtime (a 400
  // from the global ValidationPipe if omitted, and agent-controller's importTenantWallet 400s
  // without it too: `if (!exportUrl || !passKey || !checksum)`), but @ApiPropertyOptional
  // advertised it as optional in Swagger and excluded it from the generated model's `required`
  // list. Same mismatch as ExportCloudWalletDto.passKey on the stacked #71. See the #73 review.
  @ApiProperty({ example: 'XzFjo1RTZ2h9UVFCnPUyaQ' })
  @Transform(({ value }) => trim(value))
  @IsNotEmpty({ message: 'passKey is required' })
  @IsString({ message: 'passKey must be in string format.' })
  // Mirrors agent-controller's own MIN_PASSKEY_LENGTH (16), same as ExportCloudWalletDto.passKey
  // -- without it an under-length passKey passes gateway validation, crosses NATS, runs
  // checkUserExist + _commonCloudWalletInfo + checkAgentHealth, and only then fails at the agent
  // as an opaque RpcException instead of a field-level 400. This is the same passKey the caller
  // supplied at export time, so a weak one accepted here just means the export-side floor was
  // bypassable via import's own endpoint. See the #73 review.
  @MinLength(16, { message: 'passKey must be at least 16 characters' })
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
