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
import { IResponse } from '@credebl/common/interfaces/response.interface';
import { ProofTemplateService } from './proof-template.service';
import { ProofTemplateDto } from './dto/proof-template.dto';
import { UpdateProofTemplateDto } from './dto/update-proof-template.dto';
import { ProofTemplateQueryDto } from './dto/proof-template-query.dto';
import { resolveNgotagOrgId } from './functions';

@ApiBearerAuth()
@ApiTags('Proof Template')
@Controller('proof-template')
export class ProofTemplateController {
  constructor(private readonly proofTemplateService: ProofTemplateService) {}

  @UseGuards(AuthGuard('jwt'))
  @Post()
  @ApiOperation({ summary: 'Creates a Proof Template and map with verifier role if roleIds provided' })
  @ApiQuery({ name: 'orgId', required: false, description: 'Required if not present in the request body' })
  async createProofTemplate(
    @Body() proofTemplateDto: ProofTemplateDto,
    @Query('orgId') orgId: string,
    @Headers('authorization') authorization: string,
    @Req() req: Request,
    @Res() res: Response
  ): Promise<Response> {
    const loginOrgId = resolveNgotagOrgId(req.user as Record<string, unknown>, proofTemplateDto.orgId ?? orgId);
    const data = await this.proofTemplateService.createProofTemplate(proofTemplateDto, loginOrgId, authorization);
    return res.status(data.statusCode ?? HttpStatus.CREATED).json(data);
  }

  @UseGuards(AuthGuard('jwt'))
  @Patch(':id')
  @ApiOperation({ summary: 'Updates a Proof Template and re-maps verifier roles if roleIds provided' })
  @ApiQuery({ name: 'orgId', required: false, description: 'Required if not present in the request body' })
  async updateProofTemplate(
    @Param('id') id: string,
    @Body() proofTemplateDto: UpdateProofTemplateDto,
    @Query('orgId') orgId: string,
    @Headers('authorization') authorization: string,
    @Req() req: Request,
    @Res() res: Response
  ): Promise<Response> {
    const loginOrgId = resolveNgotagOrgId(req.user as Record<string, unknown>, proofTemplateDto.orgId ?? orgId);
    const data = await this.proofTemplateService.updateProofTemplate(id, proofTemplateDto, loginOrgId, authorization);
    return res.status(data.statusCode ?? HttpStatus.OK).json(data);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('role')
  @ApiQuery({ name: 'orgId', required: true })
  @ApiQuery({ name: 'roleId', required: true })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'pageSize', required: false })
  @ApiQuery({ name: 'search', required: false })
  async getRoleProofTemplates(
    @Query() proofTemplateQueryDto: ProofTemplateQueryDto,
    @Query('orgId') orgId: string,
    @Req() req: Request,
    @Res() res: Response
  ): Promise<Response> {
    const loginOrgId = resolveNgotagOrgId(req.user as Record<string, unknown>, orgId);
    const data: IResponse = await this.proofTemplateService.getRoleProofTemplates(proofTemplateQueryDto, loginOrgId);
    return res.status(data.statusCode ?? HttpStatus.OK).json(data);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get()
  @ApiQuery({ name: 'orgId', required: true })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'pageSize', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'templateId', required: false })
  @ApiQuery({ name: 'id', required: false })
  async getProofTemplates(
    @Query() data: { id?: string; templateId?: string; search?: string; page?: number; pageSize?: number },
    @Query('orgId') orgId: string,
    @Req() req: Request,
    @Res() res: Response
  ): Promise<Response> {
    const loginOrgId = resolveNgotagOrgId(req.user as Record<string, unknown>, orgId);
    const result = await this.proofTemplateService.getProofTemplates(data, loginOrgId);
    return res.status(result.statusCode ?? HttpStatus.OK).json(result);
  }
}
