import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { VerifierUserService } from './verifier-user.service';
import { CreateVerifierUser } from './dto/create-verifier-user.dto';
import { UpdateVerifierUser } from './dto/update-verifier-user.dto';
import { InviteVerifierUser } from './dto/invite-verifier-user.dto';
import { UpdateVerifierUserStatus } from './dto/update-verifier-user-status.dto';
import { resolveNgotagOrgId } from './functions';

@ApiBearerAuth()
@ApiTags('Verifier Users')
@Controller('verifier-user')
export class VerifierUserController {
  constructor(private readonly verifierUserService: VerifierUserService) {}

  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Creates a verifier user' })
  @ApiQuery({ name: 'orgId', required: false, description: 'Required if not present in the request body' })
  @Post('verifier-users')
  async createVerifierUser(
    @Body() userPayload: CreateVerifierUser,
    @Query('orgId') orgId: string,
    @Headers('authorization') authorization: string,
    @Req() req: Request,
    @Res() res: Response
  ): Promise<Response> {
    const loginOrgId = resolveNgotagOrgId(req.user as Record<string, unknown>, userPayload.orgId ?? orgId);
    const data = await this.verifierUserService.createVerifierUser(userPayload, loginOrgId, authorization);
    return res.status(data.statusCode ?? HttpStatus.CREATED).json(data);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get()
  @ApiQuery({ name: 'orgId', required: true })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'pageSize', required: false })
  @ApiQuery({ name: 'id', required: false })
  async getVerifierUsers(
    @Query() data: { id?: string; orgId?: string; page?: number; pageSize?: number },
    @Req() req: Request,
    @Res() res: Response
  ): Promise<Response> {
    const loginOrgId = resolveNgotagOrgId(req.user as Record<string, unknown>, data.orgId);
    const result = await this.verifierUserService.getVerifierUsers(data, loginOrgId);
    return res.status(result.statusCode ?? HttpStatus.OK).json(result);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Updates a verifier user' })
  @ApiQuery({ name: 'orgId', required: false, description: 'Required if not present in the request body' })
  @Patch(':id')
  async updateVerifierUser(
    @Param('id') id: string,
    @Body() userPayload: UpdateVerifierUser,
    @Query('orgId') orgId: string,
    @Headers('authorization') authorization: string,
    @Req() req: Request,
    @Res() res: Response
  ): Promise<Response> {
    const loginOrgId = resolveNgotagOrgId(req.user as Record<string, unknown>, userPayload.orgId ?? orgId);
    const data = await this.verifierUserService.updateVerifierUser(id, userPayload, loginOrgId, authorization);
    return res.status(data.statusCode ?? HttpStatus.OK).json(data);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: "Updates a verifier user's revocation status (ACTIVE, SUSPENDED or REVOKED)" })
  @ApiQuery({ name: 'orgId', required: false })
  @Patch(':id/status')
  async updateVerifierUserStatus(
    @Param('id') id: string,
    @Body() statusPayload: UpdateVerifierUserStatus,
    @Query('orgId') orgId: string,
    @Headers('authorization') authorization: string,
    @Req() req: Request,
    @Res() res: Response
  ): Promise<Response> {
    const loginOrgId = resolveNgotagOrgId(req.user as Record<string, unknown>, orgId);
    const data = await this.verifierUserService.updateVerifierUserStatus(
      id,
      statusPayload.status,
      loginOrgId,
      authorization
    );
    return res.status(data.statusCode ?? HttpStatus.OK).json(data);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: "Sends a Mobile Verifier credential issuance invitation to a verifier user's email" })
  @ApiQuery({ name: 'orgId', required: false })
  @Post(':id/send-issuance')
  async sendCredentialIssuance(
    @Param('id') id: string,
    @Query('orgId') orgId: string,
    @Headers('authorization') authorization: string,
    @Req() req: Request,
    @Res() res: Response
  ): Promise<Response> {
    const loginOrgId = resolveNgotagOrgId(req.user as Record<string, unknown>, orgId);
    const data = await this.verifierUserService.sendCredentialIssuance(id, loginOrgId, authorization);
    return res.status(data.statusCode ?? HttpStatus.OK).json(data);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: "Invites a verifier user via the organization's registered webhook" })
  @ApiQuery({ name: 'orgId', required: false })
  @Post('invite')
  async inviteVerifierUser(
    @Body() invitePayload: InviteVerifierUser,
    @Query('orgId') orgId: string,
    @Headers('authorization') authorization: string,
    @Req() req: Request,
    @Res() res: Response
  ): Promise<Response> {
    const loginOrgId = resolveNgotagOrgId(req.user as Record<string, unknown>, orgId);
    const data = await this.verifierUserService.inviteVerifierUser(invitePayload, loginOrgId, authorization);
    return res.status(data.statusCode ?? HttpStatus.CREATED).json(data);
  }
}
