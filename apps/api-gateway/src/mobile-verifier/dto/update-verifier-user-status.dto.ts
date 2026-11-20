import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty } from 'class-validator';
import { VerifierUserStatus } from './verifier-user-status.enum';

export class UpdateVerifierUserStatus {
  @ApiProperty({ enum: VerifierUserStatus, example: VerifierUserStatus.SUSPENDED })
  @IsNotEmpty()
  @IsEnum(VerifierUserStatus)
  status: VerifierUserStatus;
}
