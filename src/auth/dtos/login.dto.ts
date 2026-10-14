import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'user@example.com' })
  email!: string;

  @ApiProperty({ example: 'Senha123' })
  password!: string;

  @ApiPropertyOptional({ example: true, default: false })
  remember?: boolean;
}
