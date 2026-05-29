import { IsEmail, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class MarketplaceBuyerClaimsDto {
  @IsOptional()
  @IsString()
  tid?: string;

  @IsOptional()
  @IsString()
  oid?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  preferred_username?: string;

  @IsOptional()
  @IsString()
  name?: string;
}

export class ResolveMarketplaceDto {
  @IsString()
  @IsNotEmpty()
  marketplaceToken: string;

  @IsOptional()
  @IsString()
  microsoftIdToken?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MarketplaceBuyerClaimsDto)
  buyerClaims?: MarketplaceBuyerClaimsDto;
}

export class LinkMarketplaceAccountDto {
  @IsIn(['existing_user', 'create_from_microsoft_sso'])
  mode: 'existing_user' | 'create_from_microsoft_sso';

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsString()
  microsoftTenantId?: string;

  @IsOptional()
  @IsString()
  microsoftObjectId?: string;
}

export class MarketplaceOrganizationDetailsDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  website?: string;

  @IsOptional()
  @IsString()
  logo?: string;
}

export class MarketplaceOrganizationDto {
  @IsIn(['create', 'link_existing'])
  mode: 'create' | 'link_existing';

  @IsOptional()
  @IsUUID()
  orgId?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => MarketplaceOrganizationDetailsDto)
  organization?: MarketplaceOrganizationDetailsDto;
}

export class ActivateMarketplaceDto {
  @IsUUID()
  orgId: string;
}

export class MarketplaceUsagePeriodDto {
  @IsOptional()
  @IsString()
  period?: string;
}
