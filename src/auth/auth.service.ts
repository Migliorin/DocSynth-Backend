import {
  BadRequestException,
  ConflictException,
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
export type TokenPayload = { sub: string; email: string; role: 'USER' | 'ADMIN'; exp: number; jti: string };

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthService.name);
  private readonly secret = process.env.JWT_SECRET;
  private readonly redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });

  constructor(private readonly prisma: PrismaService) {
    if (!this.secret || this.secret.length < 32)
      throw new Error('JWT_SECRET must contain at least 32 characters');
    this.redis.on('error', (error) => this.logger.error(`Redis error: ${error.message}`));
  }

  async onModuleInit() {
    await this.redis.connect();
  }

  async onModuleDestroy() {
    if (this.redis.isOpen) await this.redis.quit();
  }

  async register(input?: { name?: unknown; email?: unknown; password?: unknown }) {
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

  async login(input?: { email?: unknown; password?: unknown; remember?: unknown }) {
    const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
    const user = email ? await this.prisma.user.findUnique({ where: { email } }) : null;
    if (!user || !(await this.verifyPassword(input?.password, user.passwordHash)))
      throw new UnauthorizedException('E-mail ou senha incorretos.');
    const { passwordHash: _, ...safeUser } = user;
    return this.session(safeUser, input?.remember === true);
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

  private session(user: { id: string; name: string; email: string; role: 'USER' | 'ADMIN' }, remember: boolean) {
    const expiresIn = remember ? 30 * 24 * 60 * 60 : 60 * 60;
    const payload: TokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      exp: Math.floor(Date.now() / 1000) + expiresIn,
      jti: randomUUID(),
    };
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const unsigned = `${header}.${body}`;
    return { accessToken: `${unsigned}.${this.sign(unsigned)}`, tokenType: 'Bearer', expiresIn, user };
  }

  private sign(value: string) {
    return createHmac('sha256', this.secret!).update(value).digest('base64url');
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
