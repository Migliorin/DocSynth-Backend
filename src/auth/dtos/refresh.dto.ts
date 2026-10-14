import { ApiProperty } from '@nestjs/swagger';

export class RefreshDto {
  @ApiProperty({ description: 'Refresh token retornado no login ou cadastro.' })
  refreshToken!: string;
}
