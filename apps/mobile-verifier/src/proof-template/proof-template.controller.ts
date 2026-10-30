import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { ResponseType } from '../common/response';
import { ProofTemplateService } from './proof-template.service';
import { ProofTemplateDto } from './dto/proof-template.dto';
import { UpdateProofTemplateDto } from './dto/update-proof-template.dto';
import { ProofTemplateQueryDto } from './dto/proof-template-query.dto';

@Controller()
export class ProofTemplateController {
  constructor(private readonly proofTemplateService: ProofTemplateService) {}

  @MessagePattern({ cmd: 'create-proof-template' })
  async createProofTemplate(payload: {
    proofTemplateDto: ProofTemplateDto;
    loginOrgId: string;
    authorization: string;
  }): Promise<ResponseType> {
    return this.proofTemplateService.createProofTemplate(
      payload.proofTemplateDto,
      payload.loginOrgId,
      payload.authorization
    );
  }

  @MessagePattern({ cmd: 'update-proof-template' })
  async updateProofTemplate(payload: {
    id: string;
    proofTemplateDto: UpdateProofTemplateDto;
    loginOrgId: string;
    authorization: string;
  }): Promise<ResponseType> {
    return this.proofTemplateService.updateProofTemplate(
      payload.id,
      payload.proofTemplateDto,
      payload.loginOrgId,
      payload.authorization
    );
  }

  @MessagePattern({ cmd: 'get-role-proof-templates' })
  async getRoleProofTemplates(payload: {
    proofTemplateQueryDto: ProofTemplateQueryDto;
    loginOrgId: string;
  }): Promise<ResponseType> {
    return this.proofTemplateService.getRoleProofTemplates(payload.proofTemplateQueryDto, payload.loginOrgId);
  }

  @MessagePattern({ cmd: 'get-proof-templates' })
  async getProofTemplates(payload: {
    data: { id?: string; templateId?: string; roleId?: string; search?: string; page?: number; pageSize?: number };
    loginOrgId: string;
  }): Promise<ResponseType> {
    return this.proofTemplateService.getProofTemplates(payload.data, payload.loginOrgId);
  }
}
