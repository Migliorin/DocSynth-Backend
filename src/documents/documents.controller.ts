import {
  Controller,
  Body,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
  UseGuards,
  Req,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiBearerAuth,
  ApiConsumes,
  ApiParam,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { Request } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DocumentsService } from './documents.service.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { TokenPayload } from '../auth/auth.service.js';

@Controller('documents')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('USER', 'ADMIN')
@ApiBearerAuth()
@ApiTags('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar documentos do usuário autenticado' })
  findAll(@Req() request: Request & { user: TokenPayload }) {
    return this.documents.findAll(request.user.sub);
  }

  @Post()
  @ApiOperation({ summary: 'Enviar um documento PDF' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        type: { type: 'string', enum: ['PUR', 'RDA'] },
        title: { type: 'string', maxLength: 120 },
        description: { type: 'string', maxLength: 4000 },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'PDF salvo no MinIO e registrado.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        objectKey: { type: 'string', example: '{userId}/{documentId}.pdf' },
        originalName: { type: 'string' },
        mimeType: { type: 'string', example: 'application/pdf' },
        size: { type: 'integer' },
        ocrStatus: { type: 'string', example: 'QUEUED' },
        markdownKey: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Arquivo ausente ou PDF inválido.' })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }),
  )
  upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { type?: unknown; title?: unknown; description?: unknown },
    @Req() request: Request & { user: TokenPayload },
  ) {
    return this.documents.upload(file, body, request.user.sub);
  }

  @Post(':id/generate')
  @ApiOperation({
    summary: 'Gerar síntese do documento com tópicos informados',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  generate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body()
    body: { topics?: unknown; questions?: unknown; summaryLevel?: unknown },
    @Req() request: Request & { user: TokenPayload },
  ) {
    return this.documents.generate(id, request.user.sub, body ?? {});
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Parar a geração da síntese do documento' })
  @ApiParam({ name: 'id', format: 'uuid' })
  cancelGeneration(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request & { user: TokenPayload },
  ) {
    return this.documents.cancelGeneration(id, request.user.sub);
  }

  @Post(':id/summaries')
  @ApiOperation({ summary: 'Salvar a síntese concluída no histórico' })
  @ApiParam({ name: 'id', format: 'uuid' })
  saveSummary(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request & { user: TokenPayload },
  ) {
    return this.documents.saveSummary(id, request.user.sub);
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Baixar um PDF pelo UUID' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiProduces('application/pdf')
  @ApiResponse({ status: 200, description: 'Arquivo PDF.' })
  @ApiResponse({ status: 404, description: 'Documento não encontrado.' })
  async download(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() response: Response,
    @Req() request: Request & { user: TokenPayload },
  ) {
    const { document, body } = await this.documents.download(
      id,
      request.user.sub,
    );
    response.setHeader('Content-Type', document.mimeType);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(document.originalName)}`,
    );
    if (body)
      await pipeline(
        Readable.fromWeb(
          body.transformToWebStream() as unknown as import('node:stream/web').ReadableStream,
        ),
        response,
      );
    else response.end();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Consultar status da extração OCR' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Documento e status da extração.' })
  getOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request & { user: TokenPayload },
  ) {
    return this.documents.findOne(id, request.user.sub);
  }

  @Get(':id/events')
  @ApiOperation({ summary: 'Acompanhar extração e síntese em tempo real' })
  @ApiParam({ name: 'id', format: 'uuid' })
  streamEvents(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request & { user: TokenPayload },
    @Res() response: Response,
  ) {
    return this.documents.streamEvents(id, request.user.sub, response);
  }

  @Get(':id/markdown')
  @ApiOperation({ summary: 'Baixar o Markdown extraído' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiProduces('text/markdown')
  @ApiResponse({ status: 200, description: 'Markdown gerado pelo OCR.' })
  @ApiResponse({
    status: 409,
    description: 'Extração OCR ainda não concluída.',
  })
  async downloadMarkdown(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() response: Response,
    @Req() request: Request & { user: TokenPayload },
  ) {
    const { document, body } = await this.documents.downloadMarkdown(
      id,
      request.user.sub,
    );
    response.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(document.originalName.replace(/\.pdf$/i, '.md'))}`,
    );
    if (body)
      await pipeline(
        Readable.fromWeb(
          body.transformToWebStream() as unknown as import('node:stream/web').ReadableStream,
        ),
        response,
      );
    else response.end();
  }
}
