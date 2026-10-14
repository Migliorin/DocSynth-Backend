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
  Query,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiBearerAuth,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiParam,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiQuery,
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
import { GenerateDocumentDto, ListDocumentsQueryDto, ListSummariesQueryDto, UploadDocumentDto } from './dtos/documents-request.dto.js';
import {
  CancelGenerationResponseDto,
  DocumentDetailsResponseDto,
  DocumentResponseDto,
  ListDocumentsResponseDto,
  ListSummariesResponseDto,
  SummaryResponseDto,
} from './dtos/documents-response.dto.js';

@Controller('documents')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('USER', 'ADMIN')
@ApiBearerAuth()
@ApiTags('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar documentos do usuário autenticado' })
  @ApiQuery({ name: 'type', required: false, enum: ['PUR', 'RDA'] })
  @ApiQuery({ name: 'search', required: false, description: 'Busca por título, nome ou descrição do documento.' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    minimum: 1,
    maximum: 50,
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'ID do último documento da página anterior.',
  })
  @ApiOkResponse({ type: ListDocumentsResponseDto })
  findAll(
    @Req() request: Request & { user: TokenPayload },
    @Query() query: ListDocumentsQueryDto,
  ): Promise<ListDocumentsResponseDto> {
    return this.documents.findAll(request.user.sub, query);
  }

  @Post()
  @ApiOperation({ summary: 'Enviar um documento PDF' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'type'],
      properties: {
        file: { type: 'string', format: 'binary' },
        type: { type: 'string', enum: ['PUR', 'RDA'] },
        title: { type: 'string', maxLength: 120 },
        description: { type: 'string', maxLength: 4000 },
      },
    },
  })
  @ApiCreatedResponse({ type: DocumentResponseDto, description: 'PDF salvo no MinIO e registrado.' })
  @ApiResponse({ status: 400, description: 'Arquivo ausente ou PDF inválido.' })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }),
  )
  upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: UploadDocumentDto,
    @Req() request: Request & { user: TokenPayload },
  ): Promise<DocumentResponseDto> {
    return this.documents.upload(file, body, request.user.sub);
  }

  @Post(':id/generate')
  @ApiOperation({
    summary: 'Gerar síntese do documento com tópicos informados',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ type: DocumentResponseDto })
  generate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: GenerateDocumentDto,
    @Req() request: Request & { user: TokenPayload },
  ): Promise<DocumentResponseDto> {
    return this.documents.generate(id, request.user.sub, body ?? {});
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Parar a geração da síntese do documento' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ type: CancelGenerationResponseDto })
  cancelGeneration(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request & { user: TokenPayload },
  ): Promise<CancelGenerationResponseDto> {
    return this.documents.cancelGeneration(id, request.user.sub);
  }

  @Post(':id/summaries')
  @ApiOperation({ summary: 'Salvar a síntese concluída no histórico' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ type: SummaryResponseDto })
  saveSummary(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request & { user: TokenPayload },
  ): Promise<SummaryResponseDto> {
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
  @ApiOkResponse({ type: DocumentDetailsResponseDto, description: 'Documento, status e prévia da síntese.' })
  getOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request & { user: TokenPayload },
  ): Promise<DocumentDetailsResponseDto> {
    return this.documents.findDetails(id, request.user.sub);
  }

  @Get(':id/summaries')
  @ApiOperation({ summary: 'Listar sínteses salvas do documento' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 50 })
  @ApiQuery({ name: 'cursor', required: false, description: 'ID da última síntese da página anterior.' })
  @ApiOkResponse({ type: ListSummariesResponseDto })
  listSummaries(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request & { user: TokenPayload },
    @Query() query: ListSummariesQueryDto,
  ): Promise<ListSummariesResponseDto> {
    return this.documents.listSummaries(id, request.user.sub, query);
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
