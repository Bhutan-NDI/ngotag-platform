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
import { VerifierRoleService } from './verifier-role.service';
import { CreateRole } from './dto/create-role.dto';
import { UpdateRole } from './dto/update-role.dto';
import { resolveNgotagOrgId } from './functions';

@ApiBearerAuth()
@ApiTags('Verifier Roles')
@Controller('verifier-role')
export class VerifierRoleController {
  constructor(private readonly verifierRoleService: VerifierRoleService) {}

  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Creates a verifier role' })
  @ApiQuery({ name: 'orgId', required: false, description: 'Required if not present in the request body' })
  @Post('verifier-roles')
  async createVerifierRole(
    @Body() rolePayload: CreateRole,
    @Query('orgId') orgId: string,
    @Headers('authorization') authorization: string,
    @Req() req: Request,
    @Res() res: Response
  ): Promise<Response> {
    const loginOrgId = resolveNgotagOrgId(req.user as Record<string, unknown>, rolePayload.orgId ?? orgId);
    const data = await this.verifierRoleService.createVerifierRole(rolePayload, loginOrgId, authorization);
    return res.status(data.statusCode ?? HttpStatus.CREATED).json(data);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Updates a verifier role' })
  @ApiQuery({ name: 'orgId', required: false, description: 'Required if not present in the request body' })
  @Patch(':id')
  async updateVerifierRole(
    @Param('id') id: string,
    @Body() rolePayload: UpdateRole,
    @Query('orgId') orgId: string,
    @Headers('authorization') authorization: string,
    @Req() req: Request,
    @Res() res: Response
  ): Promise<Response> {
    const loginOrgId = resolveNgotagOrgId(req.user as Record<string, unknown>, rolePayload.orgId ?? orgId);
    const data = await this.verifierRoleService.updateVerifierRole(id, rolePayload, loginOrgId, authorization);
    return res.status(data.statusCode ?? HttpStatus.OK).json(data);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get()
  @ApiQuery({ name: 'orgId', required: true })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'pageSize', required: false })
  @ApiQuery({ name: 'id', required: false })
  async getVerifierRole(
    @Query() data: { id?: string; orgId?: string; page?: number; pageSize?: number },
    @Req() req: Request,
    @Res() res: Response
  ): Promise<Response> {
    const loginOrgId = resolveNgotagOrgId(req.user as Record<string, unknown>, data.orgId);
    const result = await this.verifierRoleService.getVerifierRoles(data, loginOrgId);
    return res.status(result.statusCode ?? HttpStatus.OK).json(result);
  }
}
