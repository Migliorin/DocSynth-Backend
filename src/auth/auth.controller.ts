import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService, type TokenPayload } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

@Controller('auth')
@ApiTags('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Body() body: { name: string; email: string; password: string }) {
    return this.auth.register(body);
  }

  @Post('login')
  login(@Body() body: { email: string; password: string; remember?: boolean }) {
    return this.auth.login(body);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  me(@Req() request: Request & { user: unknown }) {
    return request.user;
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async logout(@Req() request: Request & { user: TokenPayload }) {
    await this.auth.revokeToken(request.user);
    return { message: 'Sessão encerrada.' };
  }
}
