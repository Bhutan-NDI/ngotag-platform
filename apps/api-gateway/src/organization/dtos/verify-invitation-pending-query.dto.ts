import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';
import { toLowerCase, trim } from '@credebl/common/cast.helper';

export class VerifyInvitationPendingQueryDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsNotEmpty()
  @IsUUID()
  invitationId: string;

  @ApiProperty({ example: 'user@example.com' })
  @Transform(({ value }) => trim(value))
  @Transform(({ value }) => toLowerCase(value))
  @IsNotEmpty()
  @IsEmail({}, { message: 'Please provide a valid email' })
  email: string;
}
