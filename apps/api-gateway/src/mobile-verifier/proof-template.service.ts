import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { NATSClient } from '@credebl/common/NATSClient';
import { IResponse } from '@credebl/common/interfaces/response.interface';
import { ProofTemplateDto } from './dto/proof-template.dto';
import { UpdateProofTemplateDto } from './dto/update-proof-template.dto';
import { ProofTemplateQueryDto } from './dto/proof-template-query.dto';

@Injectable()
export class ProofTemplateService {
  constructor(
    @Inject('NATS_CLIENT') private readonly mobileVerifierProxy: ClientProxy,
    private readonly natsClient: NATSClient
  ) {}

  async createProofTemplate(
    proofTemplateDto: ProofTemplateDto,
    loginOrgId: string,
    authorization: string
  ): Promise<IResponse> {
    return this.natsClient.sendNatsMessage(this.mobileVerifierProxy, 'create-proof-template', {
      proofTemplateDto,
      loginOrgId,
      authorization
    });
  }

  async updateProofTemplate(
    id: string,
    proofTemplateDto: UpdateProofTemplateDto,
    loginOrgId: string,
    authorization: string
  ): Promise<IResponse> {
    return this.natsClient.sendNatsMessage(this.mobileVerifierProxy, 'update-proof-template', {
      id,
      proofTemplateDto,
      loginOrgId,
      authorization
    });
  }

  async getRoleProofTemplates(proofTemplateQueryDto: ProofTemplateQueryDto, loginOrgId: string): Promise<IResponse> {
    return this.natsClient.sendNatsMessage(this.mobileVerifierProxy, 'get-role-proof-templates', {
      proofTemplateQueryDto,
      loginOrgId
    });
  }

  async getProofTemplates(
    data: { id?: string; templateId?: string; roleId?: string; search?: string; page?: number; pageSize?: number },
    loginOrgId: string
  ): Promise<IResponse> {
    return this.natsClient.sendNatsMessage(this.mobileVerifierProxy, 'get-proof-templates', { data, loginOrgId });
  }
}
