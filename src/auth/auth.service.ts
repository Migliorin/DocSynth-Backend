import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createClient } from 'redis';
import { PrismaService } from '../prisma/prisma.service.js';

const scrypt = promisify(scryptCallback);
const publicUser = { id: true, name: true, email: true, role: true } as const;
const exampleSecret = 'replace-with-random-secret-of-at-least-32-characters';
const rateLimitScript = "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return count";
export type TokenPayload = { sub: string; email: string; role: 'USER' | 'ADMIN'; exp: number; jti: string; sid?: string };

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthService.name);
  private readonly secret = process.env.JWT_SECRET;
  private readonly redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });

  constructor(private readonly prisma: PrismaService) {
    if (!this.secret || this.secret.length < 32 || this.secret === exampleSecret)
      throw new Error('JWT_SECRET must be a unique secret of at least 32 characters');
    this.redis.on('error', (error) => this.logger.error(`Redis error: ${error.message}`));
  }

  async onModuleInit() {
    await this.redis.connect();
  }

  async onModuleDestroy() {
    if (this.redis.isOpen) await this.redis.quit();
  }

  async register(input: { name?: unknown; email?: unknown; password?: unknown } | undefined, ip: string) {
    await this.rateLimit('register:ip', ip, 20, 3600);
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
    const password = input?.password;
    if (!name || name.length > 120 || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new BadRequestException('Nome ou e-mail inválido.');
    if (!this.validPassword(password))
      throw new BadRequestException('A senha deve ter ao menos 8 caracteres, uma letra e um número.');

    const exists = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (exists) throw new ConflictException('Este e-mail já está cadastrado.');
    const passwordHash = await this.hashPassword(password);
    const user = await this.prisma.user.create({
      data: { name, email, passwordHash, role: 'USER' },
      select: publicUser,
    });
    return this.session(user, false);
  }

  async login(input: { email?: unknown; password?: unknown; remember?: unknown } | undefined, ip: string) {
    const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
    await this.rateLimit('login:ip', ip, 60, 900);
    if (email) await this.rateLimit('login:account', `${ip}:${email}`, 10, 900);
    const user = email ? await this.prisma.user.findUnique({ where: { email } }) : null;
    if (!user || !(await this.verifyPassword(input?.password, user.passwordHash)))
      throw new UnauthorizedException('E-mail ou senha incorretos.');
    const { passwordHash: _, ...safeUser } = user;
    return this.session(safeUser, input?.remember === true);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true, role: true },
    });
    if (!user) throw new UnauthorizedException('Usuário não encontrado.');
    return user;
  }

  async refresh(token: unknown) {
    const claims = this.verifyRefreshToken(token);
    const user = await this.prisma.user.findUnique({ where: { id: claims.sub }, select: { ...publicUser, refreshTokenHash: true } });
    const storedToken = `${claims.sid}:${this.hashToken(token as string)}`;
    if (!user || user.refreshTokenHash !== storedToken)
      throw new UnauthorizedException('Refresh token inválido ou expirado.');

    return this.issueSession(user, claims.sid, claims.durationSeconds, storedToken);
  }

  async verifyToken(token: string): Promise<TokenPayload> {
    let decoded = {} as TokenPayload;
    try {
      const [header, payload, signature, extra] = token.split('.');
      if (!header || !payload || !signature || extra) throw new Error('Malformed token');
      if (JSON.parse(Buffer.from(header, 'base64url').toString()).alg !== 'HS256')
        throw new Error('Invalid algorithm');
      const expected = this.sign(`${header}.${payload}`);
      const actualBytes = Buffer.from(signature);
      const expectedBytes = Buffer.from(expected);
      if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes))
        throw new Error('Invalid signature');
      decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as TokenPayload;
      if (!Number.isFinite(decoded.exp) || decoded.exp <= Math.floor(Date.now() / 1000) || !decoded.sub || !decoded.jti || !['USER', 'ADMIN'].includes(decoded.role))
        throw new Error('Expired or invalid token');
    } catch {
      throw new UnauthorizedException('Token inválido ou expirado.');
    }
    if (await this.redis.exists(`docsynth:auth:revoked:${decoded.jti}`))
      throw new UnauthorizedException('Token inválido ou revogado.');
    return decoded;
  }

  async revokeToken(payload: Pick<TokenPayload, 'jti' | 'exp'>) {
    const ttl = payload.exp - Math.floor(Date.now() / 1000);
    if (ttl > 0) await this.redis.set(`docsynth:auth:revoked:${payload.jti}`, '1', { EX: ttl });
  }

  async revokeSession(payload: TokenPayload) {
    await this.revokeToken(payload);
    if (payload.sid) {
      await this.prisma.user.updateMany({
        where: { id: payload.sub, refreshTokenHash: { startsWith: `${payload.sid}:` } },
        data: { refreshTokenHash: null },
      });
    }
  }

  private async session(user: { id: string; name: string; email: string; role: 'USER' | 'ADMIN' }, remember: boolean) {
    const durationSeconds = (remember ? 30 : 7) * 24 * 60 * 60;
    return this.issueSession(user, randomUUID(), durationSeconds);
  }

  private async issueSession(
    user: { id: string; name: string; email: string; role: 'USER' | 'ADMIN' },
    sid: string,
    durationSeconds: number,
    expectedRefreshToken?: string,
  ) {
    const refreshExpiresAt = new Date(Date.now() + durationSeconds * 1000);
    const refreshTokenJwt = this.makeRefreshToken(user.id, sid, durationSeconds, refreshExpiresAt);
    const data = { refreshTokenHash: `${sid}:${this.hashToken(refreshTokenJwt)}` };
    if (expectedRefreshToken) {
      const result = await this.prisma.user.updateMany({ where: { id: user.id, refreshTokenHash: expectedRefreshToken }, data });
      if (result.count !== 1) throw new UnauthorizedException('Refresh token inválido ou expirado.');
    } else {
      await this.prisma.user.update({ where: { id: user.id }, data });
    }
    return this.issueAccessToken(user, sid, refreshTokenJwt, refreshExpiresAt);
  }

  private issueAccessToken(
    user: { id: string; name: string; email: string; role: 'USER' | 'ADMIN' },
    sid: string,
    refreshToken: string,
    refreshExpiresAt: Date,
  ) {
    const expiresIn = 60 * 60;
    const payload: TokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      exp: Math.floor(Date.now() / 1000) + expiresIn,
      jti: randomUUID(),
      sid,
    };
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const unsigned = `${header}.${body}`;
    return {
      accessToken: `${unsigned}.${this.sign(unsigned)}`,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn,
      refreshExpiresAt,
    };
  }

  private hashToken(token: string) {
    return createHmac('sha256', this.secret!).update(token).digest('hex');
  }

  private makeRefreshToken(sub: string, sid: string, durationSeconds: number, expiresAt: Date) {
    const payload = Buffer.from(JSON.stringify({ sub, sid, durationSeconds, exp: Math.floor(expiresAt.getTime() / 1000) })).toString('base64url');
    const unsigned = `refresh.${payload}`;
    return `${unsigned}.${this.sign(unsigned)}`;
  }

  private verifyRefreshToken(token: unknown): { sub: string; sid: string; durationSeconds: number } {
    try {
      if (typeof token !== 'string') throw new Error();
      const [kind, encoded, signature, extra] = token.split('.');
      const unsigned = `${kind}.${encoded}`;
      const expected = Buffer.from(this.sign(unsigned));
      const actual = Buffer.from(signature ?? '');
      if (kind !== 'refresh' || !encoded || !signature || extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string' ||
          !Number.isInteger(payload.durationSeconds) || !Number.isFinite(payload.exp) ||
          payload.exp <= Math.floor(Date.now() / 1000)) throw new Error();
      return payload;
    } catch {
      throw new UnauthorizedException('Refresh token inválido ou expirado.');
    }
  }

  private sign(value: string) {
    return createHmac('sha256', this.secret!).update(value).digest('base64url');
  }

  private async rateLimit(scope: string, identity: string, limit: number, windowSeconds: number) {
    const key = `docsynth:auth:rate:${scope}:${createHmac('sha256', this.secret!).update(identity).digest('hex')}`;
    const count = Number(await this.redis.eval(rateLimitScript, {
      keys: [key],
      arguments: [String(windowSeconds)],
    }));
    if (count > limit)
      throw new HttpException(
        'Muitas tentativas. Aguarde antes de tentar novamente.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
  }

  private validPassword(password: unknown): password is string {
    return typeof password === 'string' && password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password);
  }

  private async hashPassword(password: string) {
    const salt = randomBytes(16).toString('hex');
    const key = (await scrypt(password, salt, 64)) as Buffer;
    return `${salt}:${key.toString('hex')}`;
  }

  private async verifyPassword(password: unknown, stored: string) {
    if (typeof password !== 'string') return false;
    const [salt, hash] = stored.split(':');
    if (!salt || !hash) return false;
    const expected = Buffer.from(hash, 'hex');
    const actual = (await scrypt(password, salt, expected.length)) as Buffer;
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
