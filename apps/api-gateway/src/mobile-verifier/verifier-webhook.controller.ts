import { Body, Controller, Get, Headers, HttpStatus, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { VerifierWebhookService } from './verifier-webhook.service';
import { CreateVerifierWebhook } from './dto/create-verifier-webhook.dto';
import { resolveNgotagOrgId } from './functions';

@ApiBearerAuth()
@ApiTags('Verifier Webhook')
@Controller('verifier-webhook')
export class VerifierWebhookController {
  constructor(private readonly verifierWebhookService: VerifierWebhookService) {}

  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Registers (or updates) mobile-verifier’s webhook for this organization' })
  @ApiQuery({ name: 'orgId', required: false, description: 'Required if not present in the request body' })
  @Post()
  async registerVerifierWebhook(
    @Body() webhookPayload: CreateVerifierWebhook,
    @Query('orgId') orgId: string,
    @Headers('authorization') authorization: string,
    @Req() req: Request,
    @Res() res: Response
  ): Promise<Response> {
    const loginOrgId = resolveNgotagOrgId(req.user as Record<string, unknown>, webhookPayload.orgId ?? orgId);
    const data = await this.verifierWebhookService.registerVerifierWebhook(webhookPayload, loginOrgId, authorization);
    return res.status(data.statusCode ?? HttpStatus.CREATED).json(data);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({
    summary: 'Gets mobile-verifier’s webhook registration for this organization (secrets are masked)'
  })
  @ApiQuery({ name: 'orgId', required: true })
  @ApiQuery({ name: 'webhookId', required: false })
  @Get()
  async getVerifierWebhook(
    @Query() data: { orgId?: string; webhookId?: string },
    @Headers('authorization') authorization: string,
    @Req() req: Request,
    @Res() res: Response
  ): Promise<Response> {
    const loginOrgId = resolveNgotagOrgId(req.user as Record<string, unknown>, data.orgId);
    const result = await this.verifierWebhookService.getVerifierWebhook(loginOrgId, authorization, data.webhookId);
    return res.status(result.statusCode ?? HttpStatus.OK).json(result);
  }
}
