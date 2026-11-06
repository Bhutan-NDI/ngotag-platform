import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { ResponseType } from '../common/response';
import { VerifierUserService } from './verifier-user.service';
import { CreateVerifierUser } from './dto/create-verifier-user.dto';
import { UpdateVerifierUser } from './dto/update-verifier-user.dto';
import { InviteVerifierUser } from './dto/invite-verifier-user.dto';

@Controller()
export class VerifierUserController {
  constructor(private readonly verifierUserService: VerifierUserService) {}

  @MessagePattern({ cmd: 'create-verifier-user' })
  async createVerifierUser(payload: {
    userPayload: CreateVerifierUser;
    loginOrgId: string;
    authorization: string;
  }): Promise<ResponseType> {
    return this.verifierUserService.createVerifierUser(payload.userPayload, payload.loginOrgId, payload.authorization);
  }

  @MessagePattern({ cmd: 'get-verifier-users' })
  async getVerifierUsers(payload: {
    data: { id?: string; page?: number; pageSize?: number };
    loginOrgId: string;
  }): Promise<ResponseType> {
    return this.verifierUserService.getVerifierUsers(payload.data, payload.loginOrgId);
  }

  @MessagePattern({ cmd: 'update-verifier-user' })
  async updateVerifierUser(payload: {
    id: string;
    userPayload: UpdateVerifierUser;
    loginOrgId: string;
    authorization: string;
  }): Promise<ResponseType> {
    return this.verifierUserService.updateVerifierUser(
      payload.id,
      payload.userPayload,
      payload.loginOrgId,
      payload.authorization
    );
  }

  @MessagePattern({ cmd: 'update-verifier-user-status' })
  async updateVerifierUserStatus(payload: {
    id: string;
    status: string;
    loginOrgId: string;
    authorization: string;
  }): Promise<ResponseType> {
    return this.verifierUserService.updateVerifierUserStatus(
      payload.id,
      payload.status,
      payload.loginOrgId,
      payload.authorization
    );
  }

  @MessagePattern({ cmd: 'send-verifier-user-issuance' })
  async sendCredentialIssuance(payload: {
    id: string;
    loginOrgId: string;
    authorization: string;
  }): Promise<ResponseType> {
    return this.verifierUserService.sendCredentialIssuance(payload.id, payload.loginOrgId, payload.authorization);
  }

  @MessagePattern({ cmd: 'invite-verifier-user' })
  async inviteVerifierUser(payload: {
    invitePayload: InviteVerifierUser;
    loginOrgId: string;
    authorization: string;
  }): Promise<ResponseType> {
    return this.verifierUserService.inviteVerifierUser(
      payload.invitePayload.email,
      payload.loginOrgId,
      payload.authorization
    );
  }
}
