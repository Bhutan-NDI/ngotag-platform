import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { NATSClient } from '@credebl/common/NATSClient';
import { IResponse } from '@credebl/common/interfaces/response.interface';
import { CreateRole } from './dto/create-role.dto';
import { UpdateRole } from './dto/update-role.dto';

@Injectable()
export class VerifierRoleService {
  constructor(
    @Inject('NATS_CLIENT') private readonly mobileVerifierProxy: ClientProxy,
    private readonly natsClient: NATSClient
  ) {}

  async createVerifierRole(rolePayload: CreateRole, loginOrgId: string, authorization: string): Promise<IResponse> {
    return this.natsClient.sendNatsMessage(this.mobileVerifierProxy, 'create-verifier-role', {
      rolePayload,
      loginOrgId,
      authorization
    });
  }

  async updateVerifierRole(
    id: string,
    rolePayload: UpdateRole,
    loginOrgId: string,
    authorization: string
  ): Promise<IResponse> {
    return this.natsClient.sendNatsMessage(this.mobileVerifierProxy, 'update-verifier-role', {
      id,
      rolePayload,
      loginOrgId,
      authorization
    });
  }

  async getVerifierRoles(
    data: { id?: string; page?: number; pageSize?: number },
    loginOrgId: string
  ): Promise<IResponse> {
    return this.natsClient.sendNatsMessage(this.mobileVerifierProxy, 'get-verifier-roles', { data, loginOrgId });
  }
}
