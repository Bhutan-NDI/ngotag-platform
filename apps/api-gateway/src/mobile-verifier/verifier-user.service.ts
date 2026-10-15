import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { NATSClient } from '@credebl/common/NATSClient';
import { IResponse } from '@credebl/common/interfaces/response.interface';
import { CreateVerifierUser } from './dto/create-verifier-user.dto';
import { UpdateVerifierUser } from './dto/update-verifier-user.dto';
import { InviteVerifierUser } from './dto/invite-verifier-user.dto';

@Injectable()
export class VerifierUserService {
  constructor(
    @Inject('NATS_CLIENT') private readonly mobileVerifierProxy: ClientProxy,
    private readonly natsClient: NATSClient
  ) {}

  async createVerifierUser(
    userPayload: CreateVerifierUser,
    loginOrgId: string,
    authorization: string
  ): Promise<IResponse> {
    return this.natsClient.sendNatsMessage(this.mobileVerifierProxy, 'create-verifier-user', {
      userPayload,
      loginOrgId,
      authorization
    });
  }

  async getVerifierUsers(
    data: { id?: string; page?: number; pageSize?: number },
    loginOrgId: string
  ): Promise<IResponse> {
    return this.natsClient.sendNatsMessage(this.mobileVerifierProxy, 'get-verifier-users', { data, loginOrgId });
  }

  async updateVerifierUser(
    id: string,
    userPayload: UpdateVerifierUser,
    loginOrgId: string,
    authorization: string
  ): Promise<IResponse> {
    return this.natsClient.sendNatsMessage(this.mobileVerifierProxy, 'update-verifier-user', {
      id,
      userPayload,
      loginOrgId,
      authorization
    });
  }

  async updateVerifierUserStatus(
    id: string,
    status: string,
    loginOrgId: string,
    authorization: string
  ): Promise<IResponse> {
    return this.natsClient.sendNatsMessage(this.mobileVerifierProxy, 'update-verifier-user-status', {
      id,
      status,
      loginOrgId,
      authorization
    });
  }

  async sendCredentialIssuance(id: string, loginOrgId: string, authorization: string): Promise<IResponse> {
    return this.natsClient.sendNatsMessage(this.mobileVerifierProxy, 'send-verifier-user-issuance', {
      id,
      loginOrgId,
      authorization
    });
  }

  async inviteVerifierUser(
    invitePayload: InviteVerifierUser,
    loginOrgId: string,
    authorization: string
  ): Promise<IResponse> {
    return this.natsClient.sendNatsMessage(this.mobileVerifierProxy, 'invite-verifier-user', {
      invitePayload,
      loginOrgId,
      authorization
    });
  }
}
