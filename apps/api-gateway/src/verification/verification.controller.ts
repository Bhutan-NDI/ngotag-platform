/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-param-reassign */
/* eslint-disable camelcase */
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiBody,
  ApiQuery,
  ApiExcludeEndpoint
} from '@nestjs/swagger';
import {
  Controller,
  Logger,
  Post,
  Body,
  Get,
  Query,
  HttpStatus,
  Res,
  UseGuards,
  Param,
  UseFilters,
  BadRequestException,
  NotFoundException,
  ParseUUIDPipe,
  Delete,
  Patch,
  Version,
  Headers
} from '@nestjs/common';
import { ApiResponseDto } from '../dtos/apiResponse.dto';
import { UnauthorizedErrorDto } from '../dtos/unauthorized-error.dto';
import { ForbiddenErrorDto } from '../dtos/forbidden-error.dto';
import { SendProofRequestPayload, RequestProofDtoV1, RequestProofDtoV2 } from './dto/request-proof.dto';
import { VerificationService } from './verification.service';
import IResponseType, { IResponse } from '@credebl/common/interfaces/response.interface';
import { Response } from 'express';
import { ResponseMessages } from '@credebl/common/response-messages';
import { IUserRequest } from '@credebl/user-request/user-request.interface';
import { Roles } from '../authz/decorators/roles.decorator';
import { OrgRoles } from 'libs/org-roles/enums';
import { AuthGuard } from '@nestjs/passport';
import { OrgRolesGuard } from '../authz/guards/org-roles.guard';
import { WebhookPresentationProofDto } from './dto/webhook-proof.dto';
import { CustomExceptionFilter } from 'apps/api-gateway/common/exception-handler';
import { User } from '../authz/decorators/user.decorator';
import { GetAllProofRequestsDto } from './dto/get-all-proof-requests.dto';
import { RegisterRedirectUrisDto, UpdateRedirectUrisDto } from './dto/redirect-uris.dto';
import { IProofRequestSearchCriteria } from './interfaces/verification.interface';
import { API_Version, ProofRequestType, SortFields } from './enum/verification.enum';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { user } from '@prisma/client';
import { TrimStringParamPipe } from '@credebl/common/cast.helper';
import { Validator } from '@credebl/common/validator';
import { IWebhookUrlInfo } from '@credebl/common/interfaces/webhook.interface';
import { RequiresMarketplaceFeature } from '../marketplace/decorators/requires-marketplace-feature.decorator';
import { MarketplaceEntitlementGuard } from '../marketplace/guards/marketplace-entitlement.guard';
import { MarketplaceService } from '../marketplace/marketplace.service';
import { RateLimit } from 'nestjs-rate-limiter';
import { isMarketplaceMeteringEnabled } from '../marketplace/utils/marketplace-config.util';

/**
 * The global limit is per IP, and many citizens share one carrier or office IP; the real limit for these routes is per
 * hostedId, in the verification service (DL-008). This only replaces the global per-IP ceiling with a looser one.
 */
export const HOSTED_PAGE_IP_RATE_LIMIT = { keyPrefix: 'verification-hosted', points: 500, duration: 1 };

/** A scan token is 32 random bytes in hex (64 characters); anything else is reported as not found. */
function checkedScanToken(scanToken: string): string {
  const value = scanToken?.trim();
  if (!/^[0-9a-f]{64}$/.test(value ?? '')) {
    throw new NotFoundException(ResponseMessages.verification.error.hostedSessionNotFound);
  }
  return value;
}

/** Only the wallet asks for JSON; a browser or a link preview fetching the link must not mark the request scanned. */
export function isWalletFetch(accept: string | undefined): boolean {
  return Boolean(accept?.toLowerCase().includes('application/json'));
}

/** A hostedId is 32 random bytes in base64url (43 characters); anything else is reported as not found. */
function checkedHostedId(hostedId: string): string {
  const value = hostedId?.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(value ?? '')) {
    throw new NotFoundException(ResponseMessages.verification.error.hostedSessionNotFound);
  }
  return value;
}

@UseFilters(CustomExceptionFilter)
@Controller()
@ApiTags('verifications')
export class VerificationController {
  constructor(
    private readonly verificationService: VerificationService,
    private readonly marketplaceService: MarketplaceService
  ) {}

  private readonly logger = new Logger('VerificationController');

  /**
   * Get verified proof details
   * @param proofId The ID of the proof
   * @param orgId The ID of the organization
   * @returns Verified proof details
   */
  @Get('/orgs/:orgId/verified-proofs/:proofId')
  @ApiOperation({
    summary: 'Get verified proof details',
    description: 'Retrieve the details of a verified proof for a specific organization.'
  })
  @Roles(OrgRoles.OWNER, OrgRoles.ADMIN, OrgRoles.ISSUER, OrgRoles.VERIFIER, OrgRoles.MEMBER, OrgRoles.HOLDER)
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  @ApiBearerAuth()
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @ApiUnauthorizedResponse({ description: 'Unauthorized', type: UnauthorizedErrorDto })
  @ApiForbiddenResponse({ description: 'Forbidden', type: ForbiddenErrorDto })
  async getVerifiedProofDetails(
    @Res() res: Response,
    @User() user: IUserRequest,
    @Param('proofId') proofId: string,
    @Param('orgId') orgId: string
  ): Promise<Response> {
    const sendProofRequest = await this.verificationService.getVerifiedProofDetails(proofId, orgId, user);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.verification.success.verifiedProofDetails,
      data: sendProofRequest
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  @Get('/orgs/:orgId/verified-proofs/threads/:threadId')
  @ApiOperation({
    summary: 'Get a verified proof presentation by thread ID',
    description:
      'Returns the raw proof format data (proofData) of a verified proof presentation, fetched live from the agent. Only proofs of this organization in state done and verified are returned; other states get 409.'
  })
  @Roles(OrgRoles.OWNER, OrgRoles.ADMIN, OrgRoles.VERIFIER)
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  @ApiBearerAuth()
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'No proof with this thread ID for the organization' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'The proof is not in state done and verified' })
  @ApiUnauthorizedResponse({ description: 'Unauthorized', type: UnauthorizedErrorDto })
  @ApiForbiddenResponse({ description: 'Forbidden', type: ForbiddenErrorDto })
  async getProofPresentationByThreadId(
    @Param(
      'orgId',
      new ParseUUIDPipe({
        exceptionFactory: (): Error => {
          throw new BadRequestException(ResponseMessages.organisation.error.invalidOrgId);
        }
      })
    )
    orgId: string,
    @Param(
      'threadId',
      TrimStringParamPipe,
      new ParseUUIDPipe({
        exceptionFactory: (): Error => {
          throw new BadRequestException(ResponseMessages.verification.error.invalidThreadId);
        }
      })
    )
    threadId: string,
    @Res() res: Response
  ): Promise<Response> {
    const presentation = await this.verificationService.getProofPresentationByThreadId(orgId, threadId);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.verification.success.verifiedProofDetails,
      data: presentation
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Get proof presentation details by proofId
   * @param proofId The ID of the proof
   * @param orgId The ID of the organization
   * @returns Proof presentation details by proofId
   */
  @Get('/orgs/:orgId/proofs/:proofId')
  @ApiOperation({
    summary: 'Get proof presentation by proof Id',
    description: 'Retrieve the details of a proof presentation by its proof ID for a specific organization.'
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @ApiUnauthorizedResponse({ description: 'Unauthorized', type: UnauthorizedErrorDto })
  @ApiForbiddenResponse({ description: 'Forbidden', type: ForbiddenErrorDto })
  @Roles(OrgRoles.OWNER, OrgRoles.ADMIN, OrgRoles.ISSUER, OrgRoles.VERIFIER, OrgRoles.MEMBER, OrgRoles.HOLDER)
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  @ApiBearerAuth()
  async getProofPresentationById(
    @Res() res: Response,
    @User() user: IUserRequest,
    @Param(
      'proofId',
      TrimStringParamPipe,
      new ParseUUIDPipe({
        exceptionFactory: (): Error => {
          throw new BadRequestException(ResponseMessages.verification.error.invalidProofId);
        }
      })
    )
    proofId: string,
    @Param(
      'orgId',
      new ParseUUIDPipe({
        exceptionFactory: (): Error => {
          throw new BadRequestException(ResponseMessages.organisation.error.invalidOrgId);
        }
      })
    )
    orgId: string
  ): Promise<Response> {
    const getProofPresentationById = await this.verificationService.getProofPresentationById(proofId, orgId, user);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.verification.success.fetch,
      data: getProofPresentationById
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Get proof presentation details by issuerId
   * @param proofId The ID of the proof
   * @param issuerId The ID of the issuer
   * @returns Proof presentation details by issuerId
   */
  @Get('/orgs/proofs')
  @ApiOperation({
    summary: 'Get verified proof presentation details by issuer Id',
    description: 'Retrieve the details of a proof presentation by its issuer Id'
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @ApiUnauthorizedResponse({ description: 'Unauthorized', type: UnauthorizedErrorDto })
  @ApiForbiddenResponse({ description: 'Forbidden', type: ForbiddenErrorDto })
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  async getProofPresentationByIssuerId(
    @Res() res: Response,
    @User() user: IUserRequest,
    @Query('issuerId') issuerId: string
  ): Promise<Response> {
    const verifiedProofDetails = await this.verificationService.getPresentationDetailsByIssuerId(issuerId, user);

    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.verification.success.fetch,
      data: verifiedProofDetails
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Get all proof presentations
   * @param user The user making the request
   * @param orgId The ID of the organization
   * @returns All proof presentations details
   */
  @Get('/orgs/:orgId/proofs')
  @ApiOperation({
    summary: 'Get all proof presentations by orgId',
    description: 'Retrieve all proof presentations for a the organization. Supports pagination and sorting.'
  })
  @ApiQuery({
    name: 'sortField',
    enum: SortFields,
    required: false
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @ApiUnauthorizedResponse({ description: 'Unauthorized', type: UnauthorizedErrorDto })
  @ApiForbiddenResponse({ description: 'Forbidden', type: ForbiddenErrorDto })
  @ApiBearerAuth()
  @Roles(OrgRoles.OWNER, OrgRoles.ADMIN, OrgRoles.ISSUER, OrgRoles.VERIFIER, OrgRoles.MEMBER, OrgRoles.HOLDER)
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  async getProofPresentations(
    @Query() getAllProofRequests: GetAllProofRequestsDto,
    @Res() res: Response,
    @User() user: IUserRequest,
    @Param(
      'orgId',
      new ParseUUIDPipe({
        exceptionFactory: (): Error => {
          throw new BadRequestException(`Invalid format for orgId`);
        }
      })
    )
    orgId: string
  ): Promise<Response> {
    const { pageSize, search, pageNumber, sortField, sortBy } = getAllProofRequests;
    const proofRequestsSearchCriteria: IProofRequestSearchCriteria = {
      pageNumber,
      search,
      pageSize,
      sortField,
      sortBy
    };

    const proofPresentationDetails = await this.verificationService.getProofPresentations(
      proofRequestsSearchCriteria,
      user,
      orgId
    );
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.verification.success.fetch,
      data: proofPresentationDetails
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Send proof request
   * @param orgId The ID of the organization
   * @returns Requested proof presentation details
   */
  @Post('/orgs/:orgId/proofs')
  @ApiOperation({
    summary: 'Sends a proof request',
    description: 'Send a proof request to a specific organization.'
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @ApiUnauthorizedResponse({ description: 'Unauthorized', type: UnauthorizedErrorDto })
  @ApiForbiddenResponse({ description: 'Forbidden', type: ForbiddenErrorDto })
  @ApiBody({ type: RequestProofDtoV1 })
  @ApiQuery({
    name: 'requestType',
    enum: ProofRequestType
  })
  @ApiBearerAuth()
  @RequiresMarketplaceFeature('verification')
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard, MarketplaceEntitlementGuard)
  @Roles(OrgRoles.OWNER, OrgRoles.ADMIN, OrgRoles.VERIFIER)
  async sendPresentationRequest(
    @Res() res: Response,
    @User() user: IUserRequest,
    @Param(
      'orgId',
      new ParseUUIDPipe({
        exceptionFactory: (): Error => {
          throw new BadRequestException(`Invalid format for orgId`);
        }
      })
    )
    orgId: string,
    @Body() requestProof: RequestProofDtoV1,
    @Query('requestType') requestType: ProofRequestType = ProofRequestType.INDY
  ): Promise<Response> {
    if (requestType === ProofRequestType.INDY && !requestProof.proofFormats) {
      throw new BadRequestException(`type: ${requestType} requires proofFormats`);
    }

    if (requestType === ProofRequestType.PRESENTATIONEXCHANGE && !requestProof.presentationDefinition) {
      throw new BadRequestException(`type: ${requestType} requires presentationDefinition`);
    }

    if (requestType === ProofRequestType.INDY) {
      Validator.validateIndyProofAttributes(requestProof.proofFormats.indy.attributes);
    }
    const version = API_Version.version_neutral;
    requestProof.version = version;
    requestProof.orgId = orgId;
    requestProof.type = requestType;
    const proofData = await this.verificationService.sendProofRequest(requestProof, user);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.CREATED,
      message: ResponseMessages.verification.success.send,
      data: proofData
    };
    return res.status(HttpStatus.CREATED).json(finalResponse);
  }

  /**
   * Send proof request v1
   * @param orgId The ID of the organization
   * @returns Requested proof presentation details
   */
  @Version('2')
  @Post('/orgs/:orgId/proofs')
  @ApiOperation({
    summary: 'Sends a proof request',
    description: 'Send a proof request on multiple connections for a the organization.'
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @ApiUnauthorizedResponse({ description: 'Unauthorized', type: UnauthorizedErrorDto })
  @ApiForbiddenResponse({ description: 'Forbidden', type: ForbiddenErrorDto })
  @ApiBody({ type: RequestProofDtoV2 })
  @ApiQuery({
    name: 'requestType',
    enum: ProofRequestType
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  @Roles(OrgRoles.OWNER, OrgRoles.ADMIN, OrgRoles.VERIFIER)
  async sendPresentationRequestV1(
    @Res() res: Response,
    @User() user: IUserRequest,
    @Param(
      'orgId',
      new ParseUUIDPipe({
        exceptionFactory: (): Error => {
          throw new BadRequestException(`Invalid format for orgId`);
        }
      })
    )
    orgId: string,
    @Body() requestProof: RequestProofDtoV2,
    @Query('requestType') requestTypeV1: ProofRequestType = ProofRequestType.INDY
  ): Promise<Response> {
    if (requestTypeV1 === ProofRequestType.INDY && !requestProof.proofFormats) {
      throw new BadRequestException(`type: ${requestTypeV1} requires proofFormats`);
    }

    if (requestTypeV1 === ProofRequestType.PRESENTATIONEXCHANGE && !requestProof.presentationDefinition) {
      throw new BadRequestException(`type: ${requestTypeV1} requires presentationDefinition`);
    }

    if (requestTypeV1 === ProofRequestType.INDY) {
      Validator.validateIndyProofAttributes(requestProof.proofFormats.indy.attributes);
    }

    const version = API_Version.VERSION_1;
    requestProof.version = version;
    requestProof.orgId = orgId;
    requestProof.type = requestTypeV1;
    const proofData = await this.verificationService.sendProofRequest(requestProof, user);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.CREATED,
      message: ResponseMessages.verification.success.send,
      data: proofData
    };
    return res.status(HttpStatus.CREATED).json(finalResponse);
  }

  /**
   * Verify proof presentation
   * @param proofId The ID of the proof
   * @param orgId The ID of the organization
   * @returns Verified proof presentation details
   */
  @Post('/orgs/:orgId/proofs/:proofId/verify')
  @ApiOperation({
    summary: 'Verify presentation',
    description: 'Verify the proof presentation for a the organization.'
  })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Created', type: ApiResponseDto })
  @ApiUnauthorizedResponse({ description: 'Unauthorized', type: UnauthorizedErrorDto })
  @ApiForbiddenResponse({ description: 'Forbidden', type: ForbiddenErrorDto })
  @Roles(OrgRoles.OWNER, OrgRoles.ADMIN, OrgRoles.VERIFIER)
  @ApiBearerAuth()
  @RequiresMarketplaceFeature('verification')
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard, MarketplaceEntitlementGuard)
  async verifyPresentation(
    @Res() res: Response,
    @User() user: IUserRequest,
    @Param('proofId') proofId: string,
    @Param('orgId') orgId: string
  ): Promise<Response> {
    const verifyData = await this.verificationService.verifyPresentation(proofId, orgId, user);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.CREATED,
      message: ResponseMessages.verification.success.verified,
      data: verifyData
    };
    return res.status(HttpStatus.CREATED).json(finalResponse);
  }

  /**
   * Out-Of-Band Proof Presentation
   * @param orgId The ID of the organization
   * @returns Out-of-band requested proof presentation details
   */
  @Post('/orgs/:orgId/proofs/oob')
  @ApiOperation({
    summary: 'Sends a out-of-band proof request',
    description: 'Send an out-of-band proof request for a specific organization.'
  })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Success', type: ApiResponseDto })
  @ApiUnauthorizedResponse({ description: 'Unauthorized', type: UnauthorizedErrorDto })
  @ApiForbiddenResponse({ description: 'Forbidden', type: ForbiddenErrorDto })
  @ApiBody({ type: SendProofRequestPayload })
  @ApiQuery({
    name: 'requestType',
    enum: ProofRequestType
  })
  @Roles(OrgRoles.OWNER, OrgRoles.ADMIN, OrgRoles.VERIFIER)
  @ApiBearerAuth()
  @RequiresMarketplaceFeature('verification')
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard, MarketplaceEntitlementGuard)
  async sendOutOfBandPresentationRequest(
    @Res() res: Response,
    @User() user: IUserRequest,
    @Body() outOfBandRequestProof: SendProofRequestPayload,
    @Param('orgId') orgId: string,
    @Query('requestType') requestType: ProofRequestType = ProofRequestType.INDY
  ): Promise<Response> {
    user.orgId = orgId;
    outOfBandRequestProof.type = requestType;
    const result = await this.verificationService.sendOutOfBandPresentationRequest(outOfBandRequestProof, user);
    const finalResponse: IResponseType = {
      statusCode: HttpStatus.CREATED,
      message: ResponseMessages.verification.success.send,
      data: result
    };
    return res.status(HttpStatus.CREATED).json(finalResponse);
  }

  /**
   * Receive webhook proof presentation
   * @param orgId The ID of the organization
   * @returns Proof presentation details
   */
  @Post('wh/:orgId/proofs')
  @ApiOperation({
    summary: 'Receive webhook proof presentation',
    description: 'Handle proof presentations for a specified organization via a webhook.'
  })
  @ApiExcludeEndpoint()
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Created', type: ApiResponseDto })
  @ApiUnauthorizedResponse({ description: 'Unauthorized', type: UnauthorizedErrorDto })
  @ApiForbiddenResponse({ description: 'Forbidden', type: ForbiddenErrorDto })
  async webhookProofPresentation(
    @Param('orgId') orgId: string,
    @Body() proofPresentationPayload: WebhookPresentationProofDto,
    @Res() res: Response
  ): Promise<Response> {
    proofPresentationPayload.type = 'Verification';
    proofPresentationPayload.contextCorrelationId = proofPresentationPayload.contextCorrelationId?.replace(
      /^tenant-/,
      ''
    );
    if (orgId && 'default' === proofPresentationPayload.contextCorrelationId) {
      proofPresentationPayload.orgId = orgId;
    }

    const webhookProofPresentation = await this.verificationService
      .webhookProofPresentation(orgId, proofPresentationPayload)
      .catch((error) => {
        this.logger.debug(`error in saving verification webhook ::: ${JSON.stringify(error)}`);
      });

    // Best-effort marketplace usage capture on verification completion. Never blocks the webhook.
    // proofPresentationPayload is already typed as WebhookPresentationProofDto — no separate cast needed.
    // orgId is resolved from webhookProofPresentation (the persisted presentations row) because
    // the DTO orgId may not be set for shared/cloud agents; the microservice resolves it correctly.
    const resolvedOrgId = (webhookProofPresentation as { orgId?: string } | undefined)?.orgId;
    const verificationSourceId = proofPresentationPayload.presentationId || proofPresentationPayload.threadId;
    if (
      isMarketplaceMeteringEnabled() &&
      resolvedOrgId &&
      verificationSourceId &&
      (proofPresentationPayload.isVerified ||
        'verified' === `${proofPresentationPayload.state}`.toLowerCase() ||
        'done' === `${proofPresentationPayload.state}`.toLowerCase())
    ) {
      void this.marketplaceService
        .recordUsageEvent({
          orgId: resolvedOrgId,
          eventType: 'verification_completed',
          sourceTable: 'presentations',
          sourceId: verificationSourceId,
          quantity: 1,
          metadata: {
            threadId: proofPresentationPayload.threadId,
            state: proofPresentationPayload.state,
            isVerified: proofPresentationPayload.isVerified
          }
        })
        .catch((error) =>
          this.logger.warn(`error in recording marketplace verification usage ::: ${JSON.stringify(error)}`)
        );
    }

    const finalResponse: IResponse = {
      statusCode: HttpStatus.CREATED,
      message: ResponseMessages.verification.success.create,
      data: webhookProofPresentation
    };

    void this.verificationService
      ._getWebhookUrl(proofPresentationPayload?.contextCorrelationId, orgId)
      .then((webhookUrlInfo: IWebhookUrlInfo | null) => {
        if (!webhookUrlInfo?.webhookUrl) {
          return;
        }
        return this.verificationService._postWebhookResponse(
          webhookUrlInfo.webhookUrl,
          { data: proofPresentationPayload },
          webhookUrlInfo.webhookSecret
        );
      })
      .catch((error) => {
        this.logger.error(
          `error in webhook dispatch flow ::: ${error?.message ?? error?.stack ?? JSON.stringify(error)}`
        );
      });
    return res.status(HttpStatus.CREATED).json(finalResponse);
  }

  @Post('/orgs/:orgId/verification/redirect-uris')
  @ApiOperation({
    summary: 'Register redirect URIs',
    description:
      'Register the URIs a same-device out-of-band proof request may return the holder to (redirectUri). Replaces any existing list; at least one URI is required.'
  })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Created', type: ApiResponseDto })
  @ApiUnauthorizedResponse({ description: 'Unauthorized', type: UnauthorizedErrorDto })
  @ApiForbiddenResponse({ description: 'Forbidden', type: ForbiddenErrorDto })
  @ApiBearerAuth()
  @Roles(OrgRoles.OWNER, OrgRoles.ADMIN)
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  async registerRedirectUris(
    @Param(
      'orgId',
      new ParseUUIDPipe({
        exceptionFactory: (): Error => {
          throw new BadRequestException(ResponseMessages.organisation.error.invalidOrgId);
        }
      })
    )
    orgId: string,
    @Body() redirectUrisDto: RegisterRedirectUrisDto,
    @User() user: user,
    @Res() res: Response
  ): Promise<Response> {
    const redirectUris = await this.verificationService.setRedirectUris(orgId, redirectUrisDto.redirectUris, user.id);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.CREATED,
      message: ResponseMessages.verification.success.redirectUrisRegistered,
      data: { redirectUris }
    };
    return res.status(HttpStatus.CREATED).json(finalResponse);
  }

  @Patch('/orgs/:orgId/verification/redirect-uris')
  @ApiOperation({
    summary: 'Update redirect URIs',
    description:
      'Replace the registered redirect URIs for the organization. An empty list disables same-device redirects: any redirectUri is then rejected with 400.'
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @ApiUnauthorizedResponse({ description: 'Unauthorized', type: UnauthorizedErrorDto })
  @ApiForbiddenResponse({ description: 'Forbidden', type: ForbiddenErrorDto })
  @ApiBearerAuth()
  @Roles(OrgRoles.OWNER, OrgRoles.ADMIN)
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  async updateRedirectUris(
    @Param(
      'orgId',
      new ParseUUIDPipe({
        exceptionFactory: (): Error => {
          throw new BadRequestException(ResponseMessages.organisation.error.invalidOrgId);
        }
      })
    )
    orgId: string,
    @Body() redirectUrisDto: UpdateRedirectUrisDto,
    @User() user: user,
    @Res() res: Response
  ): Promise<Response> {
    const redirectUris = await this.verificationService.setRedirectUris(orgId, redirectUrisDto.redirectUris, user.id);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.verification.success.redirectUrisUpdated,
      data: { redirectUris }
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  @Get('/orgs/:orgId/verification/redirect-uris')
  @ApiOperation({
    summary: 'Get redirect URIs',
    description: 'Get the redirect URIs registered for the organization.'
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @ApiUnauthorizedResponse({ description: 'Unauthorized', type: UnauthorizedErrorDto })
  @ApiForbiddenResponse({ description: 'Forbidden', type: ForbiddenErrorDto })
  @ApiBearerAuth()
  @Roles(OrgRoles.OWNER, OrgRoles.ADMIN, OrgRoles.VERIFIER)
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  async getRedirectUris(
    @Param(
      'orgId',
      new ParseUUIDPipe({
        exceptionFactory: (): Error => {
          throw new BadRequestException(ResponseMessages.organisation.error.invalidOrgId);
        }
      })
    )
    orgId: string,
    @Res() res: Response
  ): Promise<Response> {
    const redirectUris = await this.verificationService.getRedirectUris(orgId);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.verification.success.redirectUrisFetched,
      data: { redirectUris }
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Unauthenticated by design: possession of the single-use, short-lived response_code
   * is the authorization.
   */
  @Get('/verification/callback-result')
  @ApiOperation({
    summary: 'Get proof result by response_code',
    description:
      'Poll the result of a same-device out-of-band proof request using the response_code appended to the redirectUri. Returns pending until the proof finishes. completed only means it finished: fetch the outcome with the authenticated proof endpoint. expired with a threadId means the request ran out before the holder answered. A completed, failed or expired result can be read only once, so read it once and keep the outcome in your own state (a retried or duplicated read gets 410).'
  })
  @ApiQuery({ name: 'response_code', required: true })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Pending, completed, failed, or expired with a threadId (the request ran out)',
    type: ApiResponseDto
  })
  @ApiResponse({ status: HttpStatus.GONE, description: 'Unknown, expired or already used response_code' })
  async getProofCallbackResult(@Query('response_code') responseCode: string, @Res() res: Response): Promise<Response> {
    // Set first so error responses (e.g. 503) are not cached either.
    res.setHeader('Cache-Control', 'no-store');
    const callbackResult = await this.verificationService.getProofCallbackResult(responseCode?.trim());
    // An expired result with a threadId is the request's outcome; without one the code itself is unknown or used.
    if ('expired' === callbackResult.status && !callbackResult.threadId) {
      return res.status(HttpStatus.GONE).json({
        statusCode: HttpStatus.GONE,
        message: ResponseMessages.verification.error.responseCodeExpired,
        data: callbackResult
      });
    }
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.verification.success.callbackResultFetched,
      data: callbackResult
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Public and read-only, for the NDI hosted verification page (HVP-SD §5.3). The opaque, 256-bit hostedId is the only
   * input; unknown and expired ids get the same 404.
   */
  @Get('/verification/hosted/:hostedId')
  @RateLimit(HOSTED_PAGE_IP_RATE_LIMIT)
  @ApiOperation({
    summary: 'Get a hosted verification page session',
    description:
      'For the NDI hosted page: the QR invitation, the deep link (with returnUrl, as the relying party gets it), the return host, redirectUri without the response_code, and the request deadline (expiresAt).'
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Session found', type: ApiResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Unknown or expired hostedId' })
  async getHostedPage(@Param('hostedId') hostedId: string, @Res() res: Response): Promise<Response> {
    res.setHeader('Cache-Control', 'no-store');
    const data = await this.verificationService.getHostedPage(checkedHostedId(hostedId));
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.verification.success.hostedSessionFetched,
      data
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Polled by the hosted page. Never consumes the response_code, and has its own limit per hostedId (DL-008).
   */
  @Get('/verification/hosted/:hostedId/status')
  @RateLimit(HOSTED_PAGE_IP_RATE_LIMIT)
  @ApiOperation({
    summary: 'Get a hosted verification page status',
    description:
      'pending, scanned, completed, failed or expired. On completed or failed, also returnUrl (redirectUri with the response_code). Rate limited per hostedId.'
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Current status', type: ApiResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Unknown or expired hostedId' })
  @ApiResponse({ status: HttpStatus.TOO_MANY_REQUESTS, description: 'Too many status reads for this hostedId' })
  async getHostedStatus(@Param('hostedId') hostedId: string, @Res() res: Response): Promise<Response> {
    res.setHeader('Cache-Control', 'no-store');
    const data = await this.verificationService.getHostedStatus(checkedHostedId(hostedId));
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.verification.success.hostedStatusFetched,
      data
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * The hosted page's scan link: its QR code and deep link point here. Answers the full `?oob=` invitation URL as a
   * bare JSON string, which is what the Bhutan NDI app expects from a short link, and marks the request scanned when
   * the wallet fetches it.
   */
  @Get('/verification/hosted/i/:scanToken')
  @RateLimit(HOSTED_PAGE_IP_RATE_LIMIT)
  @ApiExcludeEndpoint()
  async getHostedInvitation(
    @Param('scanToken') scanToken: string,
    @Headers('accept') accept: string | undefined,
    @Res() res: Response
  ): Promise<Response> {
    res.setHeader('Cache-Control', 'no-store');
    const oobUrl = await this.verificationService.getHostedInvitation(
      checkedScanToken(scanToken),
      isWalletFetch(accept)
    );
    return res.status(HttpStatus.OK).type('application/json').send(JSON.stringify(oobUrl));
  }

  /**
   * Delete verification record
   * @param orgId The ID of the organization
   * @param user The user making the request
   * @param res The response object
   * @returns Success message
   */
  @Delete('/orgs/:orgId/verification-records')
  @ApiOperation({
    summary: 'Delete verification record',
    description:
      'Delete all verification records associated with a specific organization by its orgId. This operation is restricted to users with the OWNER role.'
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @ApiBearerAuth()
  @Roles(OrgRoles.OWNER)
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  async deleteVerificationRecordsByOrgId(
    @Param(
      'orgId',
      new ParseUUIDPipe({
        exceptionFactory: (): Error => {
          throw new BadRequestException(ResponseMessages.organisation.error.invalidOrgId);
        }
      })
    )
    orgId: string,
    @User() user: user,
    @Res() res: Response
  ): Promise<Response> {
    await this.verificationService.deleteVerificationRecords(orgId, user);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.verification.success.deleteVerificationRecord
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }
}
