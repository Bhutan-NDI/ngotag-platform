import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseFilters,
  UseGuards
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiForbiddenResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Response } from 'express';
import { user } from '@prisma/client';
import { OrgRoles } from 'libs/org-roles/enums';
import { ResponseMessages } from '@credebl/common/response-messages';
import { IResponse } from '@credebl/common/interfaces/response.interface';
import { TrimStringParamPipe } from '@credebl/common/cast.helper';
import { CustomExceptionFilter } from 'apps/api-gateway/common/exception-handler';
import { ApiResponseDto } from '../dtos/apiResponse.dto';
import { ForbiddenErrorDto } from '../dtos/forbidden-error.dto';
import { UnauthorizedErrorDto } from '../dtos/unauthorized-error.dto';
import { Roles } from '../authz/decorators/roles.decorator';
import { User } from '../authz/decorators/user.decorator';
import { OrgRolesGuard } from '../authz/guards/org-roles.guard';
import { StepUpAuthGuard } from '../authz/guards/step-up.guard';
import {
  CreateOrgAgentMigrationDto,
  DisasterRestoreDto,
  ListOrgAgentMigrationsDto,
  PreflightOrgAgentMigrationDto,
  StartOrgAgentMigrationDto,
  WebhookProbeDto
} from './dto/org-agent-migration.dto';
import { OrgAgentMigrationService } from './org-agent-migration.service';

const orgIdPipes = [
  TrimStringParamPipe,
  new ParseUUIDPipe({
    exceptionFactory: (): Error => {
      throw new BadRequestException(ResponseMessages.organisation.error.invalidOrgId);
    }
  })
];

/**
 * Moving an organisation's wallet from the shared agent to its own agent. Owners run every step; any member can
 * see where it stands, and platform admins list moves across organisations. The agent API key travels in these
 * bodies, so nothing here logs a request body.
 */
@UseFilters(CustomExceptionFilter)
@Controller()
@ApiTags('agents')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Unauthorized', type: UnauthorizedErrorDto })
@ApiForbiddenResponse({ description: 'Forbidden', type: ForbiddenErrorDto })
export class OrgAgentMigrationController {
  constructor(private readonly migrationService: OrgAgentMigrationService) {}

  /**
   * Starts a move and runs the first checks. The owner must have signed in within the last five minutes.
   */
  @Post('/orgs/:orgId/agents/migrate')
  @ApiOperation({
    summary: 'Start moving the wallet to a dedicated agent',
    description:
      'Creates the move and runs the preflight checks. Requires an owner who signed in with email and password within the last 5 minutes; otherwise 401 STEP_UP_REQUIRED.'
  })
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard, StepUpAuthGuard)
  @Roles(OrgRoles.OWNER)
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Created', type: ApiResponseDto })
  async createMigration(
    @Param('orgId', ...orgIdPipes) orgId: string,
    @Body() dto: CreateOrgAgentMigrationDto,
    @User() reqUser: user,
    @Res() res: Response
  ): Promise<Response> {
    const data = await this.migrationService.create(orgId, reqUser.id, dto);

    const finalResponse: IResponse = {
      statusCode: HttpStatus.CREATED,
      message: ResponseMessages.agent.success.migrationCreated,
      data
    };
    return res.status(HttpStatus.CREATED).json(finalResponse);
  }

  @Post('/orgs/:orgId/agents/migrate/preflight')
  @ApiOperation({
    summary: 'Re-run the move checks',
    description: 'Runs every preflight check again, for example after the owner fixed something on their server.'
  })
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  @Roles(OrgRoles.OWNER)
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  async runPreflight(
    @Param('orgId', ...orgIdPipes) orgId: string,
    @Body() dto: PreflightOrgAgentMigrationDto,
    @User() reqUser: user,
    @Res() res: Response
  ): Promise<Response> {
    const data = await this.migrationService.preflight(orgId, reqUser.id, dto);

    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.agent.success.migrationChecked,
      data
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  @Post('/orgs/:orgId/agents/migrate/rehearse')
  @ApiOperation({
    summary: 'Rehearse the move',
    description:
      'Starts a dry run in the background: a real export of the wallet that is merged into the new agent and rolled back. Poll the move for the result. The owners and the platform admins are alerted.'
  })
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  @Roles(OrgRoles.OWNER)
  @ApiResponse({ status: HttpStatus.ACCEPTED, description: 'Accepted', type: ApiResponseDto })
  async rehearseMigration(
    @Param('orgId', ...orgIdPipes) orgId: string,
    @User() reqUser: user,
    @Res() res: Response
  ): Promise<Response> {
    const data = await this.migrationService.rehearse(orgId, reqUser.id);

    const finalResponse: IResponse = {
      statusCode: HttpStatus.ACCEPTED,
      message: ResponseMessages.agent.success.migrationRehearsalStarted,
      data
    };
    return res.status(HttpStatus.ACCEPTED).json(finalResponse);
  }

  @Post('/orgs/:orgId/agents/migrate/start')
  @ApiOperation({
    summary: 'Confirm the move and book its slot',
    description:
      'After a finished rehearsal, the owner types the organisation name and picks a slot within 14 days, or starts at once. Confirming again before the slot moves it. The final checks run just before the move starts.'
  })
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  @Roles(OrgRoles.OWNER)
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  async startMigration(
    @Param('orgId', ...orgIdPipes) orgId: string,
    @Body() dto: StartOrgAgentMigrationDto,
    @User() reqUser: user,
    @Res() res: Response
  ): Promise<Response> {
    const data = await this.migrationService.start(orgId, reqUser.id, dto);

    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.agent.success.migrationStarted,
      data
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  @Post('/orgs/:orgId/agents/migrate/cancel')
  @ApiOperation({
    summary: 'Cancel the wallet move',
    description:
      'Calls the move off before it starts. The organisation stays exactly as it was. Once the move has started it can no longer be cancelled.'
  })
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  @Roles(OrgRoles.OWNER)
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  async cancelMigration(
    @Param('orgId', ...orgIdPipes) orgId: string,
    @User() reqUser: user,
    @Res() res: Response
  ): Promise<Response> {
    const data = await this.migrationService.cancel(orgId, reqUser.id);

    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.agent.success.migrationCancelled,
      data
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  @Get(['/orgs/:orgId/agents/migrate', '/orgs/:orgId/agents/migrate/status'])
  @ApiOperation({
    summary: 'Get the wallet move',
    description: 'The active move for the organisation, or the latest finished one. `/status` is the same route.'
  })
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  @Roles(
    OrgRoles.OWNER,
    OrgRoles.ADMIN,
    OrgRoles.HOLDER,
    OrgRoles.ISSUER,
    OrgRoles.SUPER_ADMIN,
    OrgRoles.MEMBER,
    OrgRoles.VERIFIER
  )
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  async getMigration(@Param('orgId', ...orgIdPipes) orgId: string, @Res() res: Response): Promise<Response> {
    const data = await this.migrationService.get(orgId);

    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.agent.success.migrationFetched,
      data
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * The org filter is `targetOrgId` in the path for the same reason as in the list: the role guard treats an `orgId`
   * as "check membership of that org", which would refuse a platform admin who is not a member.
   */
  @Post('/agents/migrations/:targetOrgId/disaster-restore')
  @ApiOperation({
    summary: 'Roll a wallet move back to the shared agent',
    description:
      'For platform admins, during the stabilisation window only, when the new agent is lost for good. The organisation goes back to the shared agent and the wallet it kept. Lossy: what the new agent recorded since the switch is gone, and connections made since then break.'
  })
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  @Roles(OrgRoles.PLATFORM_ADMIN)
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  async disasterRestore(
    @Param(
      'targetOrgId',
      TrimStringParamPipe,
      new ParseUUIDPipe({
        exceptionFactory: (): Error => {
          throw new BadRequestException(ResponseMessages.organisation.error.invalidOrgId);
        }
      })
    )
    targetOrgId: string,
    @Body() _dto: DisasterRestoreDto,
    @User() reqUser: user,
    @Res() res: Response
  ): Promise<Response> {
    const data = await this.migrationService.disasterRestore(targetOrgId, reqUser.id);

    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.agent.success.migrationRestored,
      data
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * Platform admins see moves across organisations. The org filter is `targetOrgId`, not `orgId`: the role guard
   * treats an `orgId` as "check membership of that org", which would refuse an admin who is not a member.
   */
  @Get('/agents/migrations')
  @ApiOperation({
    summary: 'List wallet moves across organisations',
    description: 'For platform admins. Filter by targetOrgId and status.'
  })
  @UseGuards(AuthGuard('jwt'), OrgRolesGuard)
  @Roles(OrgRoles.PLATFORM_ADMIN)
  @ApiResponse({ status: HttpStatus.OK, description: 'Success', type: ApiResponseDto })
  async listMigrations(@Query() query: ListOrgAgentMigrationsDto, @Res() res: Response): Promise<Response> {
    const data = await this.migrationService.list(query);

    const finalResponse: IResponse = {
      statusCode: HttpStatus.OK,
      message: ResponseMessages.agent.success.migrationsFetched,
      data
    };
    return res.status(HttpStatus.OK).json(finalResponse);
  }

  /**
   * The dedicated agent's webhook test event. Open like the other webhook routes, so it answers only for the live
   * one-time probe of this organisation's unfinished move, and with nothing more for anything else.
   */
  @Post('/wh/:orgId/probe')
  @ApiExcludeEndpoint()
  async confirmWebhookProbe(
    @Param('orgId', ...orgIdPipes) orgId: string,
    @Body() body: WebhookProbeDto,
    @Res() res: Response
  ): Promise<Response> {
    const { confirmed } = await this.migrationService.confirmWebhook(orgId, body.probeId);
    return res.status(confirmed ? HttpStatus.OK : HttpStatus.NOT_FOUND).json({ confirmed });
  }
}
