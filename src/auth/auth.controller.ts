import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService, type TokenPayload } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { LoginDto } from './dtos/login.dto.js';
import { LoginResponseDto } from './dtos/login-response.dto.js';
import { LogoutResponseDto } from './dtos/logout-response.dto.js';
import { MeResponseDto } from './dtos/me-response.dto.js';
import { RefreshDto } from './dtos/refresh.dto.js';
import { RegisterDto } from './dtos/register.dto.js';
import { RegisterResponseDto } from './dtos/register-response.dto.js';

@Controller('auth')
@ApiTags('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @ApiCreatedResponse({ type: RegisterResponseDto })
  register(
    @Body() body: RegisterDto,
    @Req() request: Request,
  ): Promise<RegisterResponseDto> {
    return this.auth.register(body, request.ip ?? request.socket.remoteAddress ?? 'unknown');
  }

  @Post('login')
  @ApiCreatedResponse({ type: LoginResponseDto })
  login(
    @Body() body: LoginDto,
    @Req() request: Request,
  ): Promise<LoginResponseDto> {
    return this.auth.login(body, request.ip ?? request.socket.remoteAddress ?? 'unknown');
  }

  @Post('refresh')
  @ApiCreatedResponse({ type: LoginResponseDto })
  refresh(@Body() body: RefreshDto) {
    return this.auth.refresh(body.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOkResponse({ type: MeResponseDto })
  me(@Req() request: Request & { user: TokenPayload }): Promise<MeResponseDto> {
    return this.auth.me(request.user.sub);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiCreatedResponse({ type: LogoutResponseDto })
  async logout(@Req() request: Request & { user: TokenPayload }): Promise<LogoutResponseDto> {
    await this.auth.revokeSession(request.user);
    return { message: 'Sessão encerrada.' };
  }
}
