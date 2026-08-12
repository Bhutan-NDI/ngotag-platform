import { IResponse } from '@credebl/common/interfaces/response.interface';
import { ResponseMessages } from '@credebl/common/response-messages';
import {
  Controller,
  Post,
  Logger,
  Body,
  HttpStatus,
  Res,
  UseFilters,
  UseGuards,
  Get,
  Param,
  Query,
  ParseBoolPipe,
  ParseUUIDPipe,
  BadRequestException,
  Delete,
  Patch
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiForbiddenResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse
} from '@nestjs/swagger';
import { ForbiddenErrorDto } from '../dtos/forbidden-error.dto';
import { UnauthorizedErrorDto } from '../dtos/unauthorized-error.dto';
import { CloudWalletService } from './cloud-wallet.service';
import {
  AcceptOfferDto,
  BasicMessageDTO,
  CreateCloudWalletDidDto,
  CreateCloudWalletDto,
  CredentialListDto,
  ExportCloudWalletDto,
  GetAllCloudWalletConnectionsDto,
  ImportCloudWalletDto,
  ReceiveInvitationUrlDTO,
  UpdateBaseWalletDto
} from './dtos/cloudWallet.dto';
import { Response } from 'express';
import { CustomExceptionFilter } from 'apps/api-gateway/common/exception-handler';
import { ApiResponseDto } from '../dtos/apiResponse.dto';
import { CloudBaseWalletConfigureDto } from './dtos/configure-base-wallet.dto';
import { AuthGuard } from '@nestjs/passport';
import { User } from '../authz/decorators/user.decorator';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { user } from '@prisma/client';
import { Validator } from '@credebl/common/validator';
import { CommonConstants } from '@credebl/common/common.constant';
import { UserRoleGuard } from '../authz/guards/user-role.guard';
import { OrgRolesGuard } from '../authz/guards/org-roles.guard';
import { OrgRoles } from 'libs/org-roles/enums';
import { Roles } from '../authz/decorators/roles.decorator';
import { AcceptProofRequestDto } from './dtos/accept-proof-request.dto';
import {
  IBasicMessage,
  IConnectionDetailsById,
  ICredentialDetails,
  IGetProofPresentation,
  IGetProofPresentationById,
  IProofPresentationDetails,
  IWalletDetailsForDidList,
  IW3cCredentials,
  ICheckCloudWalletStatus,
  IDeleteCloudWallet,
  IWalletPortabilityJobStatus
} from '@credebl/common/interfaces/cloud-wallet.interface';
import { CreateConnectionDto } from './dtos/create-connection.dto';
// ProofWithCredDto/DeclineProofRequestDto/SelfAttestedCredentialDto: only used by handlers
// currently gated with NOT_IMPLEMENTED below (no microservice handler exists yet) -- restore
// these imports alongside each handler's real body once a handler exists. See the #71 review.

@UseFilters(CustomExceptionFilter)
@Controller()
@ApiTags('cloud-wallet')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Unauthorized', type: UnauthorizedErrorDto })
@ApiForbiddenResponse({ description: 'Forbidden', type: ForbiddenErrorDto })
export class CloudWalletController {
  private readonly logger = new Logger('cloud-wallet');
  constructor(private readonly cloudWalletService: CloudWalletService) {}

  /**
   * Configure cloud base wallet
   * @param cloudBaseWalletConfigure
   * @param user
   * @param res
   * @returns Success message
   */
  @Post('/configure/base-wallet')
  @ApiOperation({ summary: 'Configure base wallet', description: 'Configure base wallet' })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Created', type: ApiResponseDto })
  @UseGuards(AuthGuard('jwt'))
  async configureBaseWallet(
    @Res() res: Response,
    @Body() cloudBaseWalletConfigure: CloudBaseWalletConfigureDto,
    @User() user: user
  ): Promise<Response> {
    const { id, email } = user;

    cloudBaseWalletConfigure.userId = id;
    cloudBaseWalletConfigure.email = email;

    const configureBaseWalletData = await this.cloudWalletService.configureBaseWallet(cloudBaseWalletConfigure);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.CREATED,
      message: ResponseMessages.cloudWallet.success.configureBaseWallet,
      data: configureBaseWalletData
    };
    return res.status(HttpStatus.CREATED).json(finalResponse);
  }

  /**
   * Create cloud wallet
   * @param cloudWalletDetails
   * @param res
   * @returns Success message and wallet details
   */
  @Post('/create-wallet')
  @ApiOperation({ summary: 'Create cloud wallet', description: 'Create cloud wallet' })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Created', type: ApiResponseDto })
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  async createCloudWallet(
    @Res() res: Response,
    @Body() cloudWalletDetails: CreateCloudWalletDto,
    @User() user: user
  ): Promise<Response> {
    const { email, id } = user;
    cloudWalletDetails.email = email;
    cloudWalletDetails.userId = id;
    const cloudWalletData = await this.cloudWalletService.createCloudWallet(cloudWalletDetails);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.CREATED,
      message: ResponseMessages.cloudWallet.success.create,
      data: cloudWalletData
    };
    return res.status(HttpStatus.CREATED).json(finalResponse);
  }

  /**
   * Delete cloud wallet
   * @param res
   * @returns Success message
   */
  @Delete('/delete-wallet')
  @ApiOperation({ summary: 'Delete cloud wallet', description: 'Delete cloud wallet' })
  @ApiResponse({ status: HttpStatus.OK, type: ApiResponseDto })
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  async deleteCloudWallet(
    @Res() res: Response,
    @User() user: user,
    // Query params always arrive as strings. Without ParseBoolPipe, ?deleteHolder=false becomes
    // the string 'false', which is truthy — a caller explicitly opting OUT of holder deletion had
    // their user record (and, per this PR's onDelete: Cascade, their org-role/role-mapping rows)
    // destroyed instead.
    @Query('deleteHolder', new ParseBoolPipe({ optional: true })) deleteHolder = false
  ): Promise<Response> {
    const { id } = user;

    const cloudWalletDetails: IDeleteCloudWallet = {
      userId: id,
      deleteHolder
    };

    await this.cloudWalletService.deleteCloudWallet(cloudWalletDetails);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.cloudWallet.success.delete
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Check cloud wallet status
   * @returns success message
   */
  @Get('/check-cloud-wallet-status')
  @ApiOperation({ summary: 'Accept proof request', description: 'Accept proof request' })
  // 200, not 201: this is a GET that reads existing status, it doesn't create anything.
  // Decorator/body/actual all agreed on 201 before -- now they all agree on 200. See the #71
  // review.
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  async checkCloudWalletStatus(@Res() res: Response, @User() user: user): Promise<Response> {
    const { id, email } = user;

    const checkCloudWalletStatus: ICheckCloudWalletStatus = {
      userId: id,
      email
    };
    try {
      const checkCloudWalletStatusRes = await this.cloudWalletService.checkCloudWalletStatus(checkCloudWalletStatus);
      const finalResponse: IResponse = {
        statusCode: HttpStatus.OK,
        message: ResponseMessages.cloudWallet.success.checkCloudWalletStatus,
        data: checkCloudWalletStatusRes
      };
      return res.status(HttpStatus.OK).json(finalResponse);
    } catch (error) {
      if ('P2025' === error?.code) {
        return res.status(HttpStatus.NOT_FOUND).json({ message: 'Not found' });
      }
      throw error;
    }
  }

  @Get('get-active-base-wallet')
  @ApiOperation({ summary: 'Get active base wallets', description: 'Get active base wallets' })
  // 200, not 201: this is a GET, it doesn't create anything. See checkCloudWalletStatus's
  // identical comment above.
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @ApiBearerAuth()
  // Platform-admin only: exposes every base wallet's internal agentEndpoint + capacity. See the #71 review.
  @Roles(OrgRoles.PLATFORM_ADMIN)
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  async getBaseWalletDetails(@Res() res: Response, @User() user: user): Promise<Response> {
    const baseWalletData = await this.cloudWalletService.getBaseWalletDetails(user);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.cloudWallet.success.getBaseWalletInfo,
      data: baseWalletData
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  @Patch('/base-wallet/:walletId')
  @ApiOperation({ summary: 'Update base wallet', description: 'Update base wallet' })
  // 200, not 201: this is a PATCH updating an existing row, it doesn't create anything. See
  // checkCloudWalletStatus's identical comment above.
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @ApiBearerAuth()
  // Platform-admin only: changing isActive/maxSubWallets on every base wallet is a DoS primitive
  // otherwise. See the #71 review. (RolesGuard is a separate, pre-existing no-op -- not used here.)
  @Roles(OrgRoles.PLATFORM_ADMIN)
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  async updateBaseWalletDetails(
    // ParseUUIDPipe, not a bare string: cloud_wallet_user_info.id is @db.Uuid, and Prisma rejects
    // a malformed UUID at the query layer (PrismaClientKnownRequestError) rather than returning no
    // rows -- without this, a typo'd id 500s with an internal Prisma message instead of the clean
    // 404 the not-found guard below was written to produce. See the #71 review.
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
    @Body() updateBaseWalletDto: UpdateBaseWalletDto,
    @User() user: user,
    @Res() res: Response
  ): Promise<Response> {
    const { email, id } = user;
    updateBaseWalletDto.email = email;
    updateBaseWalletDto.userId = id;
    updateBaseWalletDto.walletId = walletId;
    const baseWalletData = await this.cloudWalletService.updateBaseWalletDetails(updateBaseWalletDto);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.cloudWallet.success.getBaseWalletInfo,
      data: baseWalletData
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Accept proof request
   * @param acceptProofRequest
   * @returns success message
   */
  @Post('/proofs/accept-request')
  @ApiOperation({ summary: 'Accept proof request', description: 'Accept proof request' })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Created', type: ApiResponseDto })
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  async acceptProofRequest(
    @Res() res: Response,
    @Body() acceptProofRequest: AcceptProofRequestDto,
    @User() user: user
  ): Promise<Response> {
    const { id, email } = user;
    acceptProofRequest.userId = id;
    acceptProofRequest.email = email;

    const acceptProofRequestDetails = await this.cloudWalletService.acceptProofRequest(acceptProofRequest);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.CREATED,
      message: ResponseMessages.cloudWallet.success.acceptProofRequest,
      data: acceptProofRequestDetails
    };
    return res.status(HttpStatus.CREATED).json(finalResponse);
  }

  /**
   * Decline proof request
   * @param DeclineProofRequest
   * @returns success message
   */
  @Post('/proofs/decline-request')
  @ApiOperation({ summary: 'Accept proof request', description: 'Accept proof request' })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Created', type: ApiResponseDto })
  @ApiExcludeEndpoint()
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  // decline-proof-request-by-holder has no microservice handler anywhere yet -- returning early
  // here (before publishing to NATS) instead of shipping a route that reads as supported API but
  // always hangs until the NATS timeout. See the #71 review. Remove this guard once a real
  // handler exists.
  async declineProofRequest(@Res() res: Response): Promise<Response> {
    return res
      .status(HttpStatus.NOT_IMPLEMENTED)
      .json({ statusCode: HttpStatus.NOT_IMPLEMENTED, message: ResponseMessages.cloudWallet.error.notImplemented });
  }

  /**
   * Get proof presentation by proof id
   * @param proofRecordId
   * @param res
   * @returns success message
   */
  @Post('/proofs/acceptRequestWithCred')
  @ApiOperation({ summary: 'Get proof presentation by Id', description: 'Get proof presentation by Id' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @ApiExcludeEndpoint()
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  // submit-proof-with-cred has no microservice handler anywhere yet -- see declineProofRequest's
  // identical comment above.
  async acceptRequestWithCred(@Res() res: Response): Promise<Response> {
    return res
      .status(HttpStatus.NOT_IMPLEMENTED)
      .json({ statusCode: HttpStatus.NOT_IMPLEMENTED, message: ResponseMessages.cloudWallet.error.notImplemented });
  }

  /**
   * Get proof presentation by Id
   * @param proofRecordId
   * @param res
   * @returns success message
   */
  @Get('/proofs/:proofRecordId')
  @ApiOperation({ summary: 'Get proof presentation by Id', description: 'Get proof presentation by Id' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  async getProofById(
    @Param('proofRecordId') proofRecordId: string,
    @Res() res: Response,
    @User() user: user
  ): Promise<Response> {
    const { id, email } = user;

    const proofPresentationByIdPayload: IGetProofPresentationById = {
      userId: id,
      email,
      proofRecordId
    };

    const getProofDetails = await this.cloudWalletService.getProofById(proofPresentationByIdPayload);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.cloudWallet.success.getProofById,
      data: getProofDetails
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Get Credentials for request by proof id
   * @param proofRecordId
   * @param res
   * @returns success message
   */
  @Get('/credentialsForRequest/:proofRecordId')
  @ApiOperation({ summary: 'Get proof presentation by Id', description: 'Get proof presentation by Id' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @ApiExcludeEndpoint()
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  // get-credentials-for-request has no microservice handler anywhere yet -- see
  // declineProofRequest's identical comment above.
  async getCredentialsForRequest(@Res() res: Response): Promise<Response> {
    return res
      .status(HttpStatus.NOT_IMPLEMENTED)
      .json({ statusCode: HttpStatus.NOT_IMPLEMENTED, message: ResponseMessages.cloudWallet.error.notImplemented });
  }

  /**
   * Get proof presentations
   * @param threadId
   * @param res
   * @returns success message
   */
  @Get('/proofs')
  @ApiOperation({ summary: 'Get proof presentation', description: 'Get proof presentation' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  @ApiQuery({
    name: 'threadId',
    required: false
  })
  async getProofPresentation(
    @Res() res: Response,
    @User() user: user,
    @Query('threadId') threadId?: string
  ): Promise<Response> {
    const { id, email } = user;

    const proofPresentationPayload: IGetProofPresentation = {
      userId: id,
      email,
      threadId
    };

    const getProofDetails = await this.cloudWalletService.getProofPresentation(proofPresentationPayload);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.cloudWallet.success.getProofPresentation,
      data: getProofDetails
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Get credential Format data by credential id
   * @param credentialListQueryOptions
   * @param res
   * @returns Credential list
   */
  @Get('/credentialFormatData/:credentialRecordId')
  @ApiOperation({
    summary: 'Get credential by credential record Id',
    description: 'Get credential by credential record Id'
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  async getCredentialFormatDataByCredentialRecordId(
    @Param('credentialRecordId') credentialRecordId: string,
    @Res() res: Response,
    @User() user: user
  ): Promise<Response> {
    const { id, email } = user;

    const credentialDetails: ICredentialDetails = {
      userId: id,
      email,
      credentialRecordId
    };

    const credentialsDetailResponse =
      await this.cloudWalletService.getCredentialFormatDataByCredentialRecordId(credentialDetails);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.cloudWallet.success.credentialByRecordId,
      data: credentialsDetailResponse
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Receive invitation by URL
   * @param receiveInvitation
   * @param res
   * @returns Response from agent
   */
  @Post('/receive-invitation-url')
  @ApiOperation({ summary: 'Receive inviation using URL', description: 'Receive inviation using URL' })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Created', type: ApiResponseDto })
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  async receiveInvitationByUrl(
    @Res() res: Response,
    @Body() receiveInvitation: ReceiveInvitationUrlDTO,
    @User() user: user
  ): Promise<Response> {
    const { email, id } = user;
    receiveInvitation.email = email;
    receiveInvitation.userId = id;
    const receiveInvitationData = await this.cloudWalletService.receiveInvitationByUrl(receiveInvitation);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.CREATED,
      message: ResponseMessages.cloudWallet.success.receive,
      data: receiveInvitationData
    };
    return res.status(HttpStatus.CREATED).json(finalResponse);
  }

  /**
   * Accept offer
   * @param acceptOffer
   * @param res
   * @returns Response from agent
   */
  @Post('/accept-offer')
  @ApiOperation({ summary: 'Accept credential offer', description: 'Accept credential offer' })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Created', type: ApiResponseDto })
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  async acceptOffer(@Res() res: Response, @Body() acceptOffer: AcceptOfferDto, @User() user: user): Promise<Response> {
    const { email, id } = user;
    acceptOffer.email = email;
    acceptOffer.userId = id;
    const receiveInvitationData = await this.cloudWalletService.acceptOffer(acceptOffer);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.CREATED,
      message: ResponseMessages.cloudWallet.success.receive,
      data: receiveInvitationData
    };
    return res.status(HttpStatus.CREATED).json(finalResponse);
  }

  /**
   * Create did
   * @param orgId
   * @returns did
   */
  @Post('/did')
  @ApiOperation({
    summary: 'Create new did',
    description: 'Create new did for cloud wallet'
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Success', type: ApiResponseDto })
  async createDid(
    @Body() createDidDto: CreateCloudWalletDidDto,
    @User() user: user,
    @Res() res: Response
  ): Promise<Response> {
    Validator.validateDid(createDidDto);
    const { email, id } = user;
    createDidDto.email = email;
    createDidDto.userId = id;
    if (createDidDto.seed && CommonConstants.SEED_LENGTH !== createDidDto.seed.length) {
      throw new BadRequestException(ResponseMessages.agent.error.seedChar, {
        cause: new Error(),
        description: ResponseMessages.errorMessages.badRequest
      });
    }

    const didDetails = await this.cloudWalletService.createDid(createDidDto);

    const finalResponse: IResponse = {
      statusCode: HttpStatus.CREATED,
      message: ResponseMessages.agent.success.createDid,
      data: didDetails
    };

    return res.status(HttpStatus.CREATED).json(finalResponse);
  }

  /**
   * Export a cloud wallet. Async: returns { jobId, status } immediately — poll
   * GET /export-wallet/status/:jobId for the actual completion result (download URL + checksum).
   * @param exportWallet
   * @returns { jobId, status }
   */
  @Post('/export-wallet')
  @ApiOperation({
    summary: 'Export Wallet',
    description: 'Export Wallet'
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  // 202, not 200/201: this starts an async job, it doesn't create an addressable resource
  // (201) or return a completed result (200). Decorator/body/actual all agree on 202 now --
  // previously the decorator/body said 200 while the actual response was sent as 201. See the
  // #71 review.
  @ApiResponse({ status: HttpStatus.ACCEPTED, description: 'Export job started', type: ApiResponseDto })
  async exportWallet(
    @Body() exportWallet: ExportCloudWalletDto,
    @User() user: user,
    @Res() res: Response
  ): Promise<Response> {
    const { email, id } = user;
    exportWallet.email = email;
    exportWallet.userId = id;

    const exportWalletDetails = await this.cloudWalletService.exportWallet(exportWallet);

    const finalResponse: IResponse = {
      statusCode: HttpStatus.ACCEPTED,
      message: ResponseMessages.agent.success.exportWallet,
      data: exportWalletDetails
    };

    return res.status(HttpStatus.ACCEPTED).json(finalResponse);
  }

  /**
   * Poll the status of an export job started via POST /export-wallet. Export/import against
   * agent-controller's native WalletPortabilityService are async jobs — this is how completion
   * (the download URL + checksum) is actually observed.
   * @param jobId
   * @returns the export job's current status
   */
  @Get('/export-wallet/status/:jobId')
  @ApiOperation({ summary: 'Get export wallet job status', description: 'Get export wallet job status' })
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  async getExportWalletStatus(
    // ParseUUIDPipe, not a bare string: agent-controller's WalletPortabilityService mints jobId
    // via uuid() (see project_phase_c_cloud_wallet memory), and this value is interpolated
    // straight into a URL called with the base-wallet's own credential -- without validating the
    // expected opaque format first, encoded traversal/query/fragment characters could redirect
    // that privileged call to an unintended route on the same agent. See the #71 review.
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
    @Res() res: Response,
    @User() user: user
  ): Promise<Response> {
    const { id, email } = user;
    const jobStatusPayload: IWalletPortabilityJobStatus = { userId: id, email, jobId };
    const jobStatusResponse = await this.cloudWalletService.getExportWalletStatus(jobStatusPayload);

    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      // Neutral message, not exportWallet's "started successfully" -- this is a poll response,
      // and the job may be pending/in_progress/completed/failed. Actual state is in data.status.
      message: ResponseMessages.agent.success.jobStatusFetched,
      data: jobStatusResponse
    };

    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Import a wallet from a prior export. exportUrl/checksum/passKey are the values a completed
   * export job returned. Async: returns { jobId, status } immediately — poll the status endpoint
   * below for the actual completion result.
   * @param importWallet
   * @returns { jobId, status }
   */
  @Post('/import-wallet')
  @ApiOperation({
    summary: 'Import Wallet',
    description: 'Import Wallet'
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  async importWallet(
    @Body() importWallet: ImportCloudWalletDto,
    @User() user: user,
    @Res() res: Response
  ): Promise<Response> {
    const { email, id } = user;
    importWallet.email = email;
    importWallet.userId = id;

    const importWalletDetails = await this.cloudWalletService.importWallet(importWallet);

    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.agent.success.importWallet,
      data: importWalletDetails
    };

    return res.status(HttpStatus.CREATED).json(finalResponse);
  }

  /**
   * Poll the status of an import job started via POST /import-wallet. On completion, the
   * response carries backupProfile — the name the tenant's pre-import profile was renamed to
   * (never deleted automatically, see agent-controller's WalletPortabilityService).
   * @param jobId
   * @returns the import job's current status
   */
  @Get('/import-wallet/status/:jobId')
  @ApiOperation({ summary: 'Get import wallet job status', description: 'Get import wallet job status' })
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  async getImportWalletStatus(
    @Param('jobId') jobId: string,
    @Res() res: Response,
    @User() user: user
  ): Promise<Response> {
    const { id, email } = user;
    const jobStatusResponse = await this.cloudWalletService.getImportWalletStatus({ userId: id, email, jobId });

    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.agent.success.importWallet,
      data: jobStatusResponse
    };

    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Get DID list by tenant id
   * @param tenantId
   * @param res
   * @returns DID list
   */
  @Get('/did')
  @ApiOperation({ summary: 'Get DID list from wallet', description: 'Get DID list from wallet' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  async getDidList(
    @Res() res: Response,
    @User() user: user,
    // Path params are mandatory in Express and always strings — @Get('/did/:isDefault') both
    // 404'd the live GET /did (no default caller could omit the segment) and made isDefault the
    // string 'false' for GET /did/false, which is truthy. Query param + ParseBoolPipe fixes both.
    @Query('isDefault', new ParseBoolPipe({ optional: true })) isDefault = false
  ): Promise<Response> {
    const { id, email } = user;

    const walletDetails: IWalletDetailsForDidList = {
      userId: id,
      email,
      isDefault
    };

    const didListDetails = await this.cloudWalletService.getDidList(walletDetails);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.cloudWallet.success.didList,
      data: didListDetails
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Accept proof request
   * @param CreateConnectionDto
   * @returns success message
   */
  @Post('/connections/invitation')
  @ApiOperation({
    summary: 'Create connection invitation for cloud wallet',
    description: 'Create connection invitation'
  })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Created', type: ApiResponseDto })
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  async createConnection(
    @Res() res: Response,
    @Body() createConnection: CreateConnectionDto,
    @User() user: user
  ): Promise<Response> {
    const { id, email } = user;
    createConnection.userId = id;
    createConnection.email = email;

    const createConnectionDetails = await this.cloudWalletService.createConnection(createConnection);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.CREATED,
      message: ResponseMessages.cloudWallet.success.createConnection,
      data: createConnectionDetails
    };
    return res.status(HttpStatus.CREATED).json(finalResponse);
  }

  /**
   * Get connection list by tenant id and connection id
   * @param tenantId
   * @param connectionId
   * @param res
   * @returns DID list
   */
  @Get('/connection/:connectionId')
  @ApiOperation({ summary: 'Get connection by connection Id', description: 'Get connection by connection Id' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  async getconnectionById(
    @Param('connectionId') connectionId: string,
    @Res() res: Response,
    @User() user: user
  ): Promise<Response> {
    const { id, email } = user;

    const connectionDetails: IConnectionDetailsById = {
      userId: id,
      email,
      connectionId
    };

    const connectionDetailResponse = await this.cloudWalletService.getconnectionById(connectionDetails);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.cloudWallet.success.connectionById,
      data: connectionDetailResponse
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Get connection list by tenant id
   * @param res
   * @returns DID list
   */
  @Get('/connections')
  @ApiOperation({ summary: 'Get all wallet connections', description: 'Get all wallet connections' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  async getAllconnectionById(
    @Query() connectionListQueryOptions: GetAllCloudWalletConnectionsDto,
    @Res() res: Response,
    @User() user: user
  ): Promise<Response> {
    const { id, email } = user;

    connectionListQueryOptions.userId = id;
    connectionListQueryOptions.email = email;

    const connectionDetailResponse = await this.cloudWalletService.getAllconnectionById(connectionListQueryOptions);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.cloudWallet.success.connectionList,
      data: connectionDetailResponse
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Create self-attested credential
   * @param SelfAttestedCredentialDto
   * @returns success message
   */
  @Post('/credentials/w3c/self-attested')
  @ApiOperation({
    summary: 'Create self-attested W3C credential for cloud wallet',
    description: 'Create self-attested W3C credential for cloud wallet'
  })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Success', type: ApiResponseDto })
  @ApiExcludeEndpoint()
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  // create-self-attested-w3c-credential has no microservice handler on *this* branch -- that
  // lands on the stacked feat/cloud-wallet-self-attested-microservice branch, which restores this
  // handler's real body once it has one to call. Gated here too (not just the 5 genuinely
  // nowhere-implemented ones) since this branch can be merged to develop on its own timeline,
  // independent of when the microservice-side PR lands. See the #71 review.
  async createSelfAttestedW3cCredential(@Res() res: Response): Promise<Response> {
    return res
      .status(HttpStatus.NOT_IMPLEMENTED)
      .json({ statusCode: HttpStatus.NOT_IMPLEMENTED, message: ResponseMessages.cloudWallet.error.notImplemented });
  }

  /* Restored on feat/cloud-wallet-self-attested-microservice, once a real handler exists:
  async createSelfAttestedW3cCredential(
    @Res() res: Response,
    @Body() selfAttestedCredentialDto: SelfAttestedCredentialDto,
    @User() user: user
  ): Promise<Response> {
    const { id, email } = user;
    selfAttestedCredentialDto.userId = id;
    selfAttestedCredentialDto.email = email;

    const selfAttestedCredential =
      await this.cloudWalletService.createSelfAttestedW3cCredential(selfAttestedCredentialDto);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.CREATED,
      message: ResponseMessages.cloudWallet.success.createSelfAttestedW3cCredential,
      data: selfAttestedCredential
    };
    return res.status(HttpStatus.CREATED).json(finalResponse);
  }
  */

  /**
   * Get credential list by tenant id
   * @param credentialListQueryOptions
   * @param res
   * @returns Credential list
   */
  @Get('/credential')
  @ApiOperation({
    summary: 'Get credential list from cloud wallet',
    description: 'Get credential list from cloud wallet'
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  async getCredentialList(
    @Query() credentialListQueryOptions: CredentialListDto,
    @Res() res: Response,
    @User() user: user
  ): Promise<Response> {
    const { id, email } = user;

    credentialListQueryOptions.userId = id;
    credentialListQueryOptions.email = email;

    const connectionDetailResponse = await this.cloudWalletService.getCredentialList(credentialListQueryOptions);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.cloudWallet.success.credentials,
      data: connectionDetailResponse
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Get W3C credential list by tenant id
   * @param res
   * @returns Credential list
   */
  @Get('/credentials/w3c')
  @ApiOperation({
    summary: 'Get W3C credential list for cloud wallet',
    description: 'Get W3C credential list for cloud wallet'
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  async getAllW3cCredentials(@Res() res: Response, @User() user: user): Promise<Response> {
    const { id, email } = user;

    const credentialDetail: IW3cCredentials = {
      userId: id,
      email
    };

    const w3cCredentials = await this.cloudWalletService.getAllW3cCredentials(credentialDetail);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.cloudWallet.success.credentials,
      data: w3cCredentials
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Get credential list by tenant id
   * @param credentialListQueryOptions
   * @param res
   * @returns Credential list
   */
  @Get('/credential/:credentialRecordId')
  @ApiOperation({
    summary: 'Get credential by credential record Id',
    description: 'Get credential by credential record Id'
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  async getCredentialByCredentialRecordId(
    @Param('credentialRecordId') credentialRecordId: string,
    @Res() res: Response,
    @User() user: user
  ): Promise<Response> {
    const { id, email } = user;

    const credentialDetails: ICredentialDetails = {
      userId: id,
      email,
      credentialRecordId
    };

    const connectionDetailResponse = await this.cloudWalletService.getCredentialByCredentialRecordId(credentialDetails);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.cloudWallet.success.credentialByRecordId,
      data: connectionDetailResponse
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Get W3C credential by Record Id
   * @param credentialListQueryOptions
   * @param res
   * @returns Credential Detail
   */
  @Get('/credential/w3c/:credentialRecordId')
  @ApiOperation({
    summary: 'Get credential by credential record Id',
    description: 'Get credential by credential record Id'
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  async getW3cCredentialByCredentialRecordId(
    @Param('credentialRecordId') credentialRecordId: string,
    @Res() res: Response,
    @User() user: user
  ): Promise<Response> {
    const { id, email } = user;

    const credentialDetails: IW3cCredentials = {
      userId: id,
      email,
      credentialRecordId
    };

    const w3cCredential = await this.cloudWalletService.getW3cCredentialByCredentialRecordId(credentialDetails);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.cloudWallet.success.credentialByRecordId,
      data: w3cCredential
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }
  /**
   * Get credential Format data by credential id
   * @param credentialListQueryOptions
   * @param res
   * @returns Credential list
   */
  @Get('/proof-formdata/:proofRecordId')
  @ApiOperation({
    summary: 'Get proof presentation by record Id',
    description: 'Get proof presentation by record Id'
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  async getProofFormatDataByProofRecordId(
    @Param('proofRecordId') proofRecordId: string,
    @Res() res: Response,
    @User() user: user
  ): Promise<Response> {
    const { id, email } = user;

    const proofPresentationDetails: IProofPresentationDetails = {
      userId: id,
      email,
      proofRecordId
    };

    const proofDetailResponse =
      await this.cloudWalletService.getProofFormatDataByProofRecordId(proofPresentationDetails);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.cloudWallet.success.proofPresentationByRecordId,
      data: proofDetailResponse
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Delete credential by credential id
   * @param credentialListQueryOptions
   * @param res
   * @returns deleted credential
   */
  @Delete('/credential/:credentialRecordId')
  @ApiOperation({
    summary: 'Get credential by credential record Id',
    description: 'Get credential by credential record Id'
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @ApiExcludeEndpoint()
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  // delete-credential-by-record-id has no microservice handler anywhere yet -- see
  // declineProofRequest's identical comment above.
  async deleteCredentialByCredentialRecordId(@Res() res: Response): Promise<Response> {
    return res
      .status(HttpStatus.NOT_IMPLEMENTED)
      .json({ statusCode: HttpStatus.NOT_IMPLEMENTED, message: ResponseMessages.cloudWallet.error.notImplemented });
  }

  /**
   * Delete W3C credential by credential id
   * @param credentialListQueryOptions
   * @param res
   * @returns deleted W3C credential
   */
  @Delete('/credential/w3c/:credentialRecordId')
  @ApiOperation({
    summary: 'Get credential by credential record Id',
    description: 'Get credential by credential record Id'
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @ApiExcludeEndpoint()
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  // delete-w3c-credential-by-record-id has no microservice handler anywhere yet -- see
  // declineProofRequest's identical comment above.
  async deleteW3cCredentialByCredentialRecordId(@Res() res: Response): Promise<Response> {
    return res
      .status(HttpStatus.NOT_IMPLEMENTED)
      .json({ statusCode: HttpStatus.NOT_IMPLEMENTED, message: ResponseMessages.cloudWallet.error.notImplemented });
  }

  /**
   * Get basic-message by connection id
   * @param connectionId
   * @param res
   * @returns Credential list
   */
  @Get('/basic-message/:connectionId')
  @ApiOperation({ summary: 'Get basic message by connection id', description: 'Get basic message by connection id' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  async getBasicMessageByConnectionId(
    @Param('connectionId') connectionId: string,
    @Res() res: Response,
    @User() user: user
  ): Promise<Response> {
    const { id, email } = user;

    const connectionDetails: IBasicMessage = {
      userId: id,
      email,
      connectionId
    };

    const basicMessageDetailResponse = await this.cloudWalletService.getBasicMessageByConnectionId(connectionDetails);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.cloudWallet.success.basicMessageByConnectionId,
      data: basicMessageDetailResponse
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Get basic-message by connection id
   * @param credentialListQueryOptions
   * @param res
   * @returns Credential list
   */
  @Post('/basic-message/:connectionId')
  @ApiOperation({ summary: 'send question', description: 'send question' })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Created', type: ApiResponseDto })
  @UseGuards(AuthGuard('jwt'), UserRoleGuard)
  async sendBasicMessage(
    @Param('connectionId') connectionId: string,
    @Res() res: Response,
    @Body() messageDetails: BasicMessageDTO,
    @User() user: user
  ): Promise<Response> {
    const { id, email } = user;
    messageDetails.userId = id;
    messageDetails.email = email;
    messageDetails.connectionId = connectionId;
    const basicMessageDetails = await this.cloudWalletService.sendBasicMessage(messageDetails);
    const finalResponse: IResponse = {
      statusCode: HttpStatus.CREATED,
      message: ResponseMessages.cloudWallet.success.basicMessage,
      data: basicMessageDetails
    };
    return res.status(HttpStatus.CREATED).json(finalResponse);
  }
}
