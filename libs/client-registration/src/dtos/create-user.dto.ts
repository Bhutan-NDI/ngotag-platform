/* eslint-disable camelcase */
import { ApiExtraModels } from '@nestjs/swagger';
// import { Role } from 'apps/platform-service/src/entities/role.entity';

@ApiExtraModels()
export class CreateUserDto {
  id?: string;
  username?: string;
  // Optional — required for the email-based flow (createUser), but createUserByUsername (the
  // username-based signup flow) has no email at all and never reads this field.
  email?: string;
  password: string;
  logo_uri?: string;
  token_lifetime?: number;
  is_active?: boolean;
  firstName?: string;
  lastName?: string;
  // role?: Role;
  isEmailVerified?: boolean;
  createdBy?: string;
  clientId?: string;
  clientSecret?: string;
  supabaseUserId?: string;
  isHolder?: boolean;
}
