import { ApiProperty } from '@nestjs/swagger';

export class LoginResponseDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: string;

  @ApiProperty({ example: 3600 })
  expiresIn!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  refreshExpiresAt!: Date;
}
