import { Body, Controller, Get, Headers, HttpStatus, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { OrgRoles } from 'libs/org-roles/enums';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Response } from 'express';
import { user } from '@prisma/client';
import { IResponse } from '@credebl/common/interfaces/response.interface';
import { User } from '../authz/decorators/user.decorator';
import { MarketplaceService } from './marketplace.service';
import {
  ActivateMarketplaceDto,
  LinkMarketplaceAccountDto,
  MarketplaceOrganizationDto,
  MarketplaceUsagePeriodDto,
  ResolveMarketplaceDto
} from './dto/marketplace.dto';

@Controller('marketplace')
@ApiTags('marketplace')
export class MarketplaceController {
  constructor(private readonly marketplaceService: MarketplaceService) {}

  @Post('/subscriptions/resolve')
  @ApiOperation({ summary: 'Resolve a Microsoft Marketplace purchase token' })
  async resolveSubscription(@Body() resolveDto: ResolveMarketplaceDto, @Res() res: Response): Promise<Response> {
    const data = await this.marketplaceService.resolveSubscription(resolveDto);
    const finalResponse: IResponse = { statusCode: HttpStatus.OK, message: 'Success', data };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  @Get('/onboarding/sessions/:sessionId')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  async getOnboardingSession(
    @Param('sessionId') sessionId: string,
    @User() reqUser: user,
    @Res() res: Response
  ): Promise<Response> {
    const data = await this.marketplaceService.getOnboardingSession(sessionId, reqUser.id);
    const finalResponse: IResponse = { statusCode: HttpStatus.OK, message: 'Success', data };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  @Post('/onboarding/:sessionId/account')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  async linkAccount(
    @Param('sessionId') sessionId: string,
    @Body() linkAccountDto: LinkMarketplaceAccountDto,
    @User() reqUser: user,
    @Res() res: Response
  ): Promise<Response> {
    const data = await this.marketplaceService.linkAccount(sessionId, linkAccountDto, reqUser);
    const finalResponse: IResponse = { statusCode: HttpStatus.OK, message: 'Success', data };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  @Post('/onboarding/:sessionId/organization')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  async linkOrganization(
    @Param('sessionId') sessionId: string,
    @Body() organizationDto: MarketplaceOrganizationDto,
    @User() reqUser: user,
    @Res() res: Response
  ): Promise<Response> {
    const data = await this.marketplaceService.linkOrganization(sessionId, organizationDto, reqUser);
    const finalResponse: IResponse = { statusCode: HttpStatus.OK, message: 'Success', data };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  @Post('/onboarding/:sessionId/activate')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  async activateSubscription(
    @Param('sessionId') sessionId: string,
    @Body() activateDto: ActivateMarketplaceDto,
    @User() reqUser: user,
    @Res() res: Response
  ): Promise<Response> {
    const data = await this.marketplaceService.activateSubscription(sessionId, activateDto, reqUser.id);
    const finalResponse: IResponse = { statusCode: HttpStatus.OK, message: 'Success', data };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  @Get('/subscriptions/:subscriptionId')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  async getSubscription(
    @Param('subscriptionId') subscriptionId: string,
    @User() reqUser: user,
    @Res() res: Response
  ): Promise<Response> {
    const data = await this.marketplaceService.getSubscription(subscriptionId, reqUser.id);
    const finalResponse: IResponse = { statusCode: HttpStatus.OK, message: 'Success', data };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  @Post('/subscriptions/:subscriptionId/refresh')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  async refreshSubscription(
    @Param('subscriptionId') subscriptionId: string,
    @User() reqUser: user,
    @Res() res: Response
  ): Promise<Response> {
    const data = await this.marketplaceService.refreshSubscription(subscriptionId, reqUser.id);
    const finalResponse: IResponse = { statusCode: HttpStatus.OK, message: 'Success', data };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  @Post('/webhook')
  async processWebhook(
    @Body() payload: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Res() res: Response
  ): Promise<Response> {
    const data = await this.marketplaceService.processWebhook(payload, authorization);
    const finalResponse: IResponse = { statusCode: HttpStatus.OK, message: 'Success', data };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  @Get('/orgs/:orgId/entitlements')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  async getEntitlements(@Param('orgId') orgId: string, @User() reqUser: user, @Res() res: Response): Promise<Response> {
    if (this.isPlatformAdmin(reqUser)) {
      const data = {
        orgId,
        features: {
          schemaCreate: true,
          credentialDefinitionCreate: true,
          issuance: true,
          bulkIssuance: true,
          verification: true,
          apiAccess: true
        },
        limits: {},
        usage: {},
        blockedReason: null
      };
      const finalResponse: IResponse = { statusCode: HttpStatus.OK, message: 'Success', data };
      return res.status(HttpStatus.OK).json(finalResponse);
    }

    const data = await this.marketplaceService.getEntitlements(orgId, reqUser.id);
    const finalResponse: IResponse = { statusCode: HttpStatus.OK, message: 'Success', data };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  @Get('/orgs/:orgId/usage-summary')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  async getUsageSummary(
    @Param('orgId') orgId: string,
    @Query() query: MarketplaceUsagePeriodDto,
    @User() reqUser: user,
    @Res() res: Response
  ): Promise<Response> {
    const data = await this.marketplaceService.getUsageSummary(orgId, query.period, reqUser.id);
    const finalResponse: IResponse = { statusCode: HttpStatus.OK, message: 'Success', data };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  @Get('/orgs/:orgId/metering-events')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  async getMeteringEvents(
    @Param('orgId') orgId: string,
    @User() reqUser: user,
    @Res() res: Response
  ): Promise<Response> {
    const data = await this.marketplaceService.getMeteringEvents(orgId, reqUser.id);
    const finalResponse: IResponse = { statusCode: HttpStatus.OK, message: 'Success', data };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  private isPlatformAdmin(user: user & { userOrgRoles?: { orgRole?: { name?: string } }[] }): boolean {
    const platformAdminEmail = process.env.PLATFORM_ADMIN_EMAIL;
    if (platformAdminEmail && user?.email === platformAdminEmail) {
      return true;
    }

    return Boolean(
      Array.isArray(user?.userOrgRoles) &&
      user.userOrgRoles.some((orgDetails) => orgDetails?.orgRole?.name === OrgRoles.PLATFORM_ADMIN)
    );
  }
}
