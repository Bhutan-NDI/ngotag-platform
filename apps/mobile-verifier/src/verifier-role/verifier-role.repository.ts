import { Injectable } from '@nestjs/common';
import { Prisma, mobile_verifier_role as VerifierRole } from '@prisma/client';
import { PrismaService } from '@credebl/prisma-service';

@Injectable()
export class VerifierRoleRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async createVerifierRole(rolePayload: Prisma.mobile_verifier_roleCreateInput): Promise<VerifierRole> {
    return this.prismaService.mobile_verifier_role.create({ data: rolePayload });
  }

  async getVerifierRoleByWhere(where: Prisma.mobile_verifier_roleWhereInput): Promise<VerifierRole> {
    return this.prismaService.mobile_verifier_role.findFirst({ where });
  }

  // Scoped by orgId so a role can never be updated across organizations.
  async updateVerifierRole(id: string, orgId: string, data: Prisma.mobile_verifier_roleUpdateInput): Promise<number> {
    const { count } = await this.prismaService.mobile_verifier_role.updateMany({ where: { id, orgId }, data });
    return count;
  }

  async getVerifierRoles(query: {
    skip?: number;
    take?: number;
    where?: Prisma.mobile_verifier_roleWhereInput;
  }): Promise<[number, VerifierRole[]]> {
    const [total, data] = await Promise.all([
      this.prismaService.mobile_verifier_role.count({ where: query.where }),
      this.prismaService.mobile_verifier_role.findMany({
        skip: query.skip,
        take: query.take,
        where: query.where
      })
    ]);
    return [total, data];
  }
}
