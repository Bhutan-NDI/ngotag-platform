import { IResponse } from '@credebl/common/interfaces/response.interface';
import { ResponseMessages } from '@credebl/common/response-messages';
import { Controller, Post, Logger, Body, UseGuards, HttpStatus, Res, Get, Param, UseFilters, Query, Inject } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiForbiddenResponse, ApiOperation, ApiQuery, ApiResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { User } from '../authz/decorators/user.decorator';
import { ForbiddenErrorDto } from '../dtos/forbidden-error.dto';
import { UnauthorizedErrorDto } from '../dtos/unauthorized-error.dto';
import { ConnectionService } from './connection.service';
import { ConnectionDto, CreateConnectionDto, CreateOutOfBandConnectionInvitation, ReceiveInvitationDto, ReceiveInvitationUrlDto } from './dtos/connection.dto';
import { IUserRequestInterface } from './interfaces';
import { Response } from 'express';
import { IUserRequest } from '@credebl/user-request/user-request.interface';
import { CustomExceptionFilter } from 'apps/api-gateway/common/exception-handler';
import { OrgRoles } from 'libs/org-roles/enums';
import { Roles } from '../authz/decorators/roles.decorator';
import { OrgRolesGuard } from '../authz/guards/org-roles.guard';
import { GetAllAgentConnectionsDto, GetAllConnectionsDto } from './dtos/get-all-connections.dto';
import { ApiResponseDto } from '../dtos/apiResponse.dto';
import { IConnectionSearchCriteria } from '../interfaces/IConnectionSearch.interface';
import { SortFields } from 'apps/connection/src/enum/connection.enum';
import { ClientProxy} from '@nestjs/microservices';
import { QuestionAnswerWebhookDto, QuestionDto} from './dtos/question-answer.dto';

@UseFilters(CustomExceptionFilter)
@Controller()
@ApiTags('connections')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Unauthorized', type: UnauthorizedErrorDto })
@ApiForbiddenResponse({ status: HttpStatus.FORBIDDEN, description: 'Forbidden', type: ForbiddenErrorDto })
export class ConnectionController {

    private readonly logger = new Logger('Connection');
    constructor(private readonly connectionService: ConnectionService,
        @Inject('NATS_CLIENT') private readonly connectionServiceProxy: ClientProxy
    ) { }

    /**
        * Get connection details by connectionId
        * @param connectionId
        * @param orgId
        * @returns connection details by connection Id
    */
    @Get('orgs/:orgId/connections/:connectionId')
    @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
    @Roles(OrgRoles.OWNER, OrgRoles.ADMIN, OrgRoles.ISSUER, OrgRoles.VERIFIER, OrgRoles.MEMBER)
    @ApiOperation({
        summary: `Get connections by connection Id`,
        description: `Get connections by connection Id`
    })
    @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
    async getConnectionsById(
        @User() user: IUserRequest,
        @Param('connectionId') connectionId: string,
        @Param('orgId') orgId: string,
        @Res() res: Response
    ): Promise<Response> {
        const connectionsDetails = await this.connectionService.getConnectionsById(user, connectionId, orgId);
        const finalResponse: IResponse = {
            statusCode: HttpStatus.OK,
            message: ResponseMessages.connection.success.fetchConnection,
            data: connectionsDetails
        };
        return res.status(HttpStatus.OK).json(finalResponse);
    }

    /**
    * Description: Get all connections
    * @param user
    * @param orgId
    * 
    */
    @Get('/orgs/:orgId/connections')
    @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
    @Roles(OrgRoles.OWNER, OrgRoles.ADMIN, OrgRoles.ISSUER, OrgRoles.VERIFIER, OrgRoles.MEMBER)
    @ApiOperation({
        summary: `Fetch all connections by orgId`,
        description: `Fetch all connections by orgId`
    })
    @ApiQuery({
        name: 'sortField',
        enum: SortFields,
        required: false
    })
    @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
    async getConnections(
        @Query() getAllConnectionsDto: GetAllConnectionsDto,
        @User() user: IUserRequest,
        @Param('orgId') orgId: string,
        @Res() res: Response
    ): Promise<Response> {

        const { pageSize, searchByText, pageNumber, sortField, sortBy } = getAllConnectionsDto;
        const connectionSearchCriteria: IConnectionSearchCriteria = {
            pageNumber,
            searchByText,
            pageSize,
            sortField,
            sortBy
        };
        const connectionDetails = await this.connectionService.getConnections(connectionSearchCriteria, user, orgId);

        const finalResponse: IResponse = {
            statusCode: HttpStatus.OK,
            message: ResponseMessages.connection.success.fetch,
            data: connectionDetails
        };
        return res.status(HttpStatus.OK).json(finalResponse);
    }

    /**
   * Description: Get all connections from agent
   * @param user
   * @param orgId
   *
   */
  @Get('/orgs/:orgId/agent/connections')
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  @Roles(OrgRoles.OWNER, OrgRoles.ADMIN, OrgRoles.ISSUER, OrgRoles.VERIFIER, OrgRoles.MEMBER)
  @ApiOperation({
    summary: `Fetch all connections from agent by orgId`,
    description: `Fetch all connections from agent by orgId`
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  async getConnectionListFromAgent(
    @Query() getAllConnectionsDto: GetAllAgentConnectionsDto,
    @Param('orgId') orgId: string,
    @Res() res: Response
  ): Promise<Response> {

    const connectionDetails = await this.connectionService.getConnectionListFromAgent(
      getAllConnectionsDto,
      orgId
    );

    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.connection.success.fetch,
      data: connectionDetails
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }


    @Get('orgs/:orgId/question-answer/question')
    @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
    @Roles(OrgRoles.OWNER, OrgRoles.ADMIN, OrgRoles.ISSUER, OrgRoles.VERIFIER, OrgRoles.MEMBER, OrgRoles.HOLDER, OrgRoles.SUPER_ADMIN, OrgRoles.PLATFORM_ADMIN)
    @ApiOperation({
        summary: `Get question-answer record`,
        description: `Get question-answer record`
    })
    @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
    async getQuestionAnswersRecord(
        @Param('orgId') orgId: string,
        @Res() res: Response
    ): Promise<Response> {
        const record = await this.connectionService.getQuestionAnswersRecord(orgId);
        const finalResponse: IResponse = {
            statusCode: HttpStatus.OK,
            message: ResponseMessages.connection.success.questionAnswerRecord,
            data: record
        };
        return res.status(HttpStatus.OK).json(finalResponse);
    }

    /**
        * Create out-of-band connection legacy invitation
        * @param connectionDto 
        * @param res 
        * @returns Created out-of-band connection invitation url
    */
    @Post('/orgs/:orgId/connections')
    @ApiOperation({ summary: 'Create outbound out-of-band connection (Legacy Invitation)', description: 'Create outbound out-of-band connection (Legacy Invitation)' })
    @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
    @Roles(OrgRoles.OWNER, OrgRoles.ADMIN, OrgRoles.ISSUER, OrgRoles.VERIFIER, OrgRoles.MEMBER)
    @ApiResponse({ status: HttpStatus.CREATED, description: 'Created', type: ApiResponseDto })
    async createLegacyConnectionInvitation(
        @Param('orgId') orgId: string,
        @Body() connectionDto: CreateConnectionDto,
        @User() reqUser: IUserRequestInterface,
        @Res() res: Response
    ): Promise<Response> {

        connectionDto.orgId = orgId;
        const connectionData = await this.connectionService.createLegacyConnectionInvitation(connectionDto, reqUser);
        const finalResponse: IResponse = {
            statusCode: HttpStatus.CREATED,
            message: ResponseMessages.connection.success.create,
            data: connectionData
        };
        return res.status(HttpStatus.CREATED).json(finalResponse);

    }

     /**
        * Create out-of-band connection invitation
        * @param connectionDto 
        * @param res 
        * @returns Created out-of-band connection invitation url
    */
     @Post('/orgs/:orgId/connection-invitation')
     @ApiOperation({ summary: 'Create outbound out-of-band connection invitation', description: 'Create outbound out-of-band connection invitation' })
     @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
     @Roles(OrgRoles.OWNER, OrgRoles.ADMIN, OrgRoles.ISSUER, OrgRoles.VERIFIER, OrgRoles.MEMBER)
     @ApiResponse({ status: HttpStatus.CREATED, description: 'Created', type: ApiResponseDto })
     async createConnectionInvitation(
         @Param('orgId') orgId: string,
         @Body() createOutOfBandConnectionInvitation: CreateOutOfBandConnectionInvitation,
         @User() reqUser: IUserRequestInterface,
         @Res() res: Response
     ): Promise<Response> {
 
        createOutOfBandConnectionInvitation.orgId = orgId;
         const connectionData = await this.connectionService.createConnectionInvitation(createOutOfBandConnectionInvitation, reqUser);
         const finalResponse: IResponse = {
             statusCode: HttpStatus.CREATED,
             message: ResponseMessages.connection.success.create,
             data: connectionData
         };
         return res.status(HttpStatus.CREATED).json(finalResponse);
 
     }

    @Post('/orgs/:orgId/question-answer/question/:connectionId')
    @ApiOperation({ summary: '', description: 'send question' })
    @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
    @Roles(OrgRoles.OWNER, OrgRoles.ADMIN, OrgRoles.ISSUER, OrgRoles.VERIFIER, OrgRoles.MEMBER, OrgRoles.HOLDER, OrgRoles.SUPER_ADMIN, OrgRoles.PLATFORM_ADMIN)
    @ApiResponse({ status: HttpStatus.CREATED, description: 'Created', type: ApiResponseDto })
    async sendQuestion(
        @Param('orgId') orgId: string,
        @Param('connectionId') connectionId: string,
        @Body() questionDto: QuestionDto,
        @User() reqUser: IUserRequestInterface,
        @Res() res: Response
    ): Promise<Response> {

        questionDto.orgId = orgId;
        questionDto.connectionId = connectionId;
        const questionData = await this.connectionService.sendQuestion(questionDto);
        const finalResponse: IResponse = {
            statusCode: HttpStatus.CREATED,
            message: ResponseMessages.connection.success.questionSend,
            data: questionData
        };
        return res.status(HttpStatus.CREATED).json(finalResponse);

    }

    @Post('/orgs/:orgId/receive-invitation-url')
    @ApiOperation({ summary: 'Receive Invitation URL', description: 'Receive Invitation URL' })
    @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
    @Roles(OrgRoles.OWNER, OrgRoles.ADMIN)
    @ApiResponse({ status: HttpStatus.CREATED, description: 'Created', type: ApiResponseDto })
    async receiveInvitationUrl(
        @Param('orgId') orgId: string,
        @Body() receiveInvitationUrl: ReceiveInvitationUrlDto,
        @User() user: IUserRequestInterface,
        @Res() res: Response
    ): Promise<Response> {

        const connectionData = await this.connectionService.receiveInvitationUrl(receiveInvitationUrl, orgId, user);
        const finalResponse: IResponse = {
            statusCode: HttpStatus.CREATED,
            message: ResponseMessages.connection.success.receivenvitation,
            data: connectionData
        };
        return res.status(HttpStatus.CREATED).json(finalResponse);
    }

    @Post('/orgs/:orgId/receive-invitation')
    @ApiOperation({ summary: 'Receive Invitation', description: 'Receive Invitation' })
    @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
    @Roles(OrgRoles.OWNER, OrgRoles.ADMIN)
    @ApiResponse({ status: HttpStatus.CREATED, description: 'Created', type: ApiResponseDto })
    async receiveInvitation(
        @Param('orgId') orgId: string,
        @Body() receiveInvitation: ReceiveInvitationDto,
        @User() user: IUserRequestInterface,
        @Res() res: Response
    ): Promise<Response> {

        const connectionData = await this.connectionService.receiveInvitation(receiveInvitation, orgId, user);
        const finalResponse: IResponse = {
            statusCode: HttpStatus.CREATED,
            message: ResponseMessages.connection.success.receivenvitation,
            data: connectionData
        };
        return res.status(HttpStatus.CREATED).json(finalResponse);
    }

    /**
   * Catch connection webhook responses.
   * @Body connectionDto
   * @param orgId
   * @returns Callback URL for connection and created connections details
   */
  @Post('wh/:orgId/connections/')
  @ApiExcludeEndpoint()
  @ApiOperation({
    summary: 'Catch connection webhook responses',
    description: 'Callback URL for connection'
  })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Created', type: ApiResponseDto })
  async getConnectionWebhook(
    @Body() connectionDto: ConnectionDto,
    @Param('orgId') orgId: string,
    @Res() res: Response
  ): Promise<Response> {
    connectionDto.type = 'Connection';
    this.logger.debug(`connectionDto ::: ${JSON.stringify(connectionDto)} ${orgId}`);
  
    const connectionData = await this.connectionService.getConnectionWebhook(connectionDto, orgId).catch(error => {
        this.logger.debug(`error in saving connection webhook ::: ${JSON.stringify(error)}`);
     });
    const finalResponse: IResponse = {
      statusCode: HttpStatus.CREATED,
      message: ResponseMessages.connection.success.create,
      data: connectionData
    };
    const webhookUrl = await this.connectionService._getWebhookUrl(connectionDto.contextCorrelationId).catch(error => {
        this.logger.debug(`error in getting webhook url ::: ${JSON.stringify(error)}`);
  
    });
    if (webhookUrl) {
        await this.connectionService._postWebhookResponse(webhookUrl, { data: connectionDto }).catch(error => {
            this.logger.debug(`error in posting webhook  response to webhook url ::: ${JSON.stringify(error)}`);
        });
    } 
    return res.status(HttpStatus.CREATED).json(finalResponse);
  }


  @Post('wh/:orgId/question-answer/')
  @ApiExcludeEndpoint()
  @ApiOperation({
    summary: 'Catch question-answer webhook responses',
    description: 'Callback URL for question-answer'
  })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Created', type: ApiResponseDto })
  async getQuestionAnswerWebhook(
    @Body() questionAnswerWebhookDto:QuestionAnswerWebhookDto,
    @Param('orgId') orgId: string,
    @Res() res: Response
  ): Promise<Response> {
    questionAnswerWebhookDto.type = 'question-answer';
    this.logger.debug(`questionAnswer ::: ${JSON.stringify(questionAnswerWebhookDto)} ${orgId}`);
  
    const finalResponse: IResponse = {
      statusCode: HttpStatus.CREATED,
      message: ResponseMessages.connection.success.create,
      data: ''
    };
    const webhookUrl = await this.connectionService._getWebhookUrl(questionAnswerWebhookDto.contextCorrelationId).catch(error => {
        this.logger.debug(`error in getting webhook url ::: ${JSON.stringify(error)}`);
  
    });
    if (webhookUrl) {
        await this.connectionService._postWebhookResponse(webhookUrl, { data: questionAnswerWebhookDto }).catch(error => {
            this.logger.debug(`error in posting webhook  response to webhook url ::: ${JSON.stringify(error)}`);
        });
    } 
    return res.status(HttpStatus.CREATED).json(finalResponse);
  }
}
