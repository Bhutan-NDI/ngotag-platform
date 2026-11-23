import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { ResponseType } from '../common/response';
import { VerifierRoleService } from './verifier-role.service';
import { CreateRole } from './dto/create-role.dto';
import { UpdateRole } from './dto/update-role.dto';

@Controller()
export class VerifierRoleController {
  constructor(private readonly verifierRoleService: VerifierRoleService) {}

  @MessagePattern({ cmd: 'create-verifier-role' })
  async createVerifierRole(payload: {
    rolePayload: CreateRole;
    loginOrgId: string;
    authorization: string;
  }): Promise<ResponseType> {
    return this.verifierRoleService.createVerifierRole(payload.rolePayload, payload.loginOrgId, payload.authorization);
  }

  @MessagePattern({ cmd: 'update-verifier-role' })
  async updateVerifierRole(payload: {
    id: string;
    rolePayload: UpdateRole;
    loginOrgId: string;
    authorization: string;
  }): Promise<ResponseType> {
    return this.verifierRoleService.updateVerifierRole(
      payload.id,
      payload.rolePayload,
      payload.loginOrgId,
      payload.authorization
    );
  }

  @MessagePattern({ cmd: 'get-verifier-roles' })
  async getVerifierRoles(payload: {
    data: { id?: string; page?: number; pageSize?: number };
    loginOrgId: string;
  }): Promise<ResponseType> {
    return this.verifierRoleService.getVerifierRoles(payload.data, payload.loginOrgId);
  }
}
