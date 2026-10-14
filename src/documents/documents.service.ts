import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { OcrQueueService } from './ocr-queue.service.js';
import type { DocumentType } from '../generated/prisma/enums.js';

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly ocrQueue: OcrQueueService,
  ) {}

  async upload(
    file: Express.Multer.File | undefined,
    body:
      { type?: unknown; title?: unknown; description?: unknown } | undefined,
    userId: string,
  ) {
    if (!file)
      throw new BadRequestException('Envie um arquivo PDF no campo "file"');
    const type = body?.type;
    if (type !== 'PUR' && type !== 'RDA')
      throw new BadRequestException('O tipo do documento deve ser PUR ou RDA.');
    const title = this.cleanText(body?.title, 'nome', 120);
    const description = this.cleanText(body?.description, 'contexto', 4000);
    if (
      !file.originalname.toLowerCase().endsWith('.pdf') ||
      !file.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))
    ) {
      throw new BadRequestException('O arquivo enviado não é um PDF válido');
    }

    const id = randomUUID();
    const jobId = randomUUID();
    const objectKey = `${userId}/${id}.pdf`;
    const statusId = await this.statusId('QUEUED');
    await this.storage.upload(objectKey, file.buffer);
    const document = await this.prisma.document
      .create({
        data: {
          id,
          objectKey,
          originalName: file.originalname,
          title,
          description,
          mimeType: 'application/pdf',
          size: file.size,
          jobId,
          type,
          userId,
          ocrStatusId: statusId,
        },
        include: { status: true },
      })
      .catch(async (error) => {
        // ponytail: S3 + PostgreSQL não compartilham transação; adicione limpeza de órfãos se quedas durante upload forem relevantes.
        await this.storage.delete(objectKey);
        throw error;
      });

    try {
      await this.ocrQueue.enqueue({
        action: 'EXTRACT',
        documentId: id,
        jobId,
        objectKey,
        markdownKey: null,
        type,
      });
    } catch (error) {
      await this.prisma.document.update({
        where: { id },
        data: {
          ocrStatusId: await this.statusId('FAILED'),
          ocrError: 'Could not enqueue OCR job',
        },
      });
      throw new ServiceUnavailableException('Serviço de OCR indisponível.', {
        cause: error,
      });
    }

    return this.presentStatus(document);
  }

  async findAll(userId: string, query: { type?: unknown; cursor?: unknown; limit?: unknown; search?: unknown }) {
    const type = query.type as DocumentType | undefined;
    if (type !== undefined && type !== 'PUR' && type !== 'RDA')
      throw new BadRequestException('O tipo do documento deve ser PUR ou RDA.');
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new BadRequestException('O limite deve ser um número entre 1 e 50.');
    if (query.search !== undefined && (typeof query.search !== 'string' || query.search.length > 120))
      throw new BadRequestException('A busca deve ter até 120 caracteres.');
    const search = typeof query.search === 'string' ? query.search.trim() : '';
    const where = {
      userId,
      ...(type ? { type } : {}),
      ...(search ? {
        OR: [
          { title: { contains: search, mode: 'insensitive' as const } },
          { originalName: { contains: search, mode: 'insensitive' as const } },
          { description: { contains: search, mode: 'insensitive' as const } },
        ],
      } : {}),
    };
    let cursor: string | undefined;
    if (query.cursor !== undefined) {
      if (typeof query.cursor !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(query.cursor))
        throw new BadRequestException('Cursor inválido.');
      const found = await this.prisma.document.findFirst({
        where: { id: query.cursor, ...where },
        select: { id: true },
      });
      if (!found) throw new BadRequestException('Cursor inválido.');
      cursor = found.id;
    }
    const documents = await this.prisma.document.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: limit + 1,
      include: { status: true },
    });
    const hasMore = documents.length > limit;
    if (hasMore) documents.pop();
    const nextCursor = hasMore ? documents.at(-1)?.id ?? null : null;
    const items = documents.map((document) => this.presentStatus(document));
    return { items, nextCursor, total: await this.prisma.document.count({ where }) };
  }

  async findDetails(id: string, userId: string) {
    const document = await this.findOne(id, userId);
    return {
      ...document,
      generatedSummary: ['COMPLETED', 'CANCELLED'].includes(document.ocrStatus)
        ? await this.ocrQueue.generatedSummary(id, document.jobId)
        : null,
    };
  }

  async listSummaries(id: string, userId: string, query: { limit?: unknown; cursor?: unknown }) {
    await this.findOne(id, userId);
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new BadRequestException('O limite deve ser um número entre 1 e 50.');
    let cursor: string | undefined;
    if (query.cursor !== undefined) {
      if (typeof query.cursor !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(query.cursor))
        throw new BadRequestException('Cursor inválido.');
      const found = await this.prisma.documentSummary.findFirst({
        where: { id: query.cursor, documentId: id },
        select: { id: true },
      });
      if (!found) throw new BadRequestException('Cursor inválido.');
      cursor = found.id;
    }
    const summaries = await this.prisma.documentSummary.findMany({
      where: { documentId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: limit + 1,
    });
    const hasMore = summaries.length > limit;
    if (hasMore) summaries.pop();
    return {
      items: summaries,
      nextCursor: hasMore ? summaries.at(-1)?.id ?? null : null,
      total: await this.prisma.documentSummary.count({ where: { documentId: id } }),
    };
  }

  async saveSummary(id: string, userId: string) {
    const document = await this.findOne(id, userId);
    if (document.ocrStatus !== 'COMPLETED')
      throw new ConflictException('A síntese ainda não foi concluída.');
    const generationId = document.jobId ?? document.id;
    const content = await this.ocrQueue.generatedSummary(id, document.jobId);
    if (!content?.trim()) {
      const saved = await this.prisma.documentSummary.findUnique({
        where: { documentId_generationId: { documentId: id, generationId } },
      });
      if (saved) return saved;
      throw new ConflictException('Não há uma síntese concluída para salvar.');
    }

    const summary = await this.prisma.documentSummary.create({
      data: {
        documentId: id, generationId, content,
        topics: document.topics, questions: document.questions,
        summaryLevel: document.summaryLevel,
      },
    }).catch(async (error: unknown) => {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
        throw error;
      return this.prisma.documentSummary.findUniqueOrThrow({
        where: { documentId_generationId: { documentId: id, generationId } },
      });
    });
    await this.ocrQueue.clearGeneratedSummary(id, document.jobId);
    return summary;
  }

  async generate(
    id: string,
    userId: string,
    input: { topics?: unknown; questions?: unknown; summaryLevel?: unknown },
  ) {
    const document = await this.findOne(id, userId);
    if (['QUEUED', 'EXTRACTING', 'SUMMARIZING', 'CANCELLING'].includes(document.ocrStatus))
      throw new ConflictException(
        'A geração deste documento já está em andamento.',
      );
    if (!document.markdownKey)
      throw new ConflictException('A extração do PDF ainda não foi concluída.');
    const topics = this.cleanList(input.topics, 'topics', 30, 200);
    const questions = this.cleanList(
      input.questions ?? [],
      'questions',
      20,
      500,
    );
    const summaryLevel = input.summaryLevel ?? 'balanced';
    if (!['concise', 'balanced', 'deep'].includes(String(summaryLevel)))
      throw new BadRequestException('Nível de síntese inválido.');

    const [activeStatusIds, queuedStatusId] = await Promise.all([
      this.statusIds(['QUEUED', 'EXTRACTING', 'SUMMARIZING', 'CANCELLING']),
      this.statusId('QUEUED'),
    ]);
    const jobId = randomUUID();
    const { count } = await this.prisma.document.updateMany({
      where: {
        id,
        userId,
        ocrStatusId: { notIn: activeStatusIds },
      },
      data: {
        topics,
        questions,
        summaryLevel: String(summaryLevel),
        jobId,
        ocrStatusId: queuedStatusId,
        ocrError: null,
      },
    });
    if (!count)
      throw new ConflictException(
        'A geração deste documento já está em andamento.',
      );
    try {
      await this.ocrQueue.enqueue({
        action: 'SUMMARIZE',
        documentId: id,
        jobId,
        objectKey: document.objectKey,
        markdownKey: document.markdownKey,
        type: document.type,
        topics,
        questions,
        summaryLevel: String(summaryLevel),
        description: document.description,
      });
    } catch (error) {
      await this.prisma.document.update({
        where: { id },
        data: {
          ocrStatusId: await this.statusId('FAILED'),
          ocrError: 'Could not enqueue summary job',
        },
      });
      throw new ServiceUnavailableException(
        'Serviço de geração indisponível.',
        { cause: error },
      );
    }
    return {
      ...document,
      topics,
      questions,
      summaryLevel: String(summaryLevel),
      jobId,
      ocrStatus: 'QUEUED',
      ocrError: null,
    };
  }

  async cancelGeneration(id: string, userId: string) {
    const document = await this.findOne(id, userId);
    if (!document.markdownKey || !['QUEUED', 'SUMMARIZING'].includes(document.ocrStatus))
      throw new ConflictException('Não há uma síntese em geração para interromper.');

    try {
      await this.ocrQueue.requestCancellation(id, document.jobId);
    } catch (error) {
      throw new ServiceUnavailableException('Não foi possível interromper a geração.', { cause: error });
    }
    const [cancellableStatusIds, cancellingStatusId] = await Promise.all([
      this.statusIds(['QUEUED', 'SUMMARIZING']),
      this.statusId('CANCELLING'),
    ]);
    const { count } = await this.prisma.document.updateMany({
      where: { id, userId, ocrStatusId: { in: cancellableStatusIds } },
      data: { ocrStatusId: cancellingStatusId },
    });
    if (!count) {
      if ((await this.findOne(id, userId)).ocrStatus === 'CANCELLED')
        return { status: 'CANCELLED' };
      throw new ConflictException('A geração já terminou ou foi interrompida.');
    }
    return { status: 'CANCELLING' };
  }

  async download(id: string, userId: string) {
    const document = await this.findOne(id, userId);
    const object = await this.storage.get(document.objectKey);
    return { document, body: object.Body };
  }

  async findOne(id: string, userId: string) {
    const document = await this.prisma.document.findFirst({
      where: { id, userId },
      include: { status: true },
    });
    if (!document) throw new NotFoundException('Documento não encontrado');
    return this.presentStatus(document);
  }

  async downloadMarkdown(id: string, userId: string) {
    const document = await this.findOne(id, userId);
    if (!document.markdownKey)
      throw new ConflictException(
        `Markdown ainda não está disponível (status: ${document.ocrStatus})`,
      );
    const object = await this.storage.get(document.markdownKey);
    return { document, body: object.Body };
  }

  async streamEvents(id: string, userId: string, response: Response) {
    const document = await this.findOne(id, userId);
    return this.ocrQueue.stream(id, document.jobId, document.ocrStatus, response);
  }

  private cleanList(
    value: unknown,
    field: string,
    maxItems: number,
    maxLength: number,
  ) {
    if (
      !Array.isArray(value) ||
      value.length > maxItems ||
      value.some((item) => typeof item !== 'string')
    )
      throw new BadRequestException(`Campo ${field} inválido.`);
    const items = value.map((item: string) => item.trim()).filter(Boolean);
    if (items.some((item) => item.length > maxLength))
      throw new BadRequestException(
        `Itens de ${field} excedem o limite de caracteres.`,
      );
    if (field === 'topics' && !items.length)
      throw new BadRequestException('Informe ao menos um tópico.');
    return [...new Set(items)];
  }

  private cleanText(value: unknown, field: string, maxLength: number) {
    if (value === undefined || value === '') return null;
    if (typeof value !== 'string' || value.length > maxLength)
      throw new BadRequestException(`Campo ${field} inválido.`);
    return value.trim() || null;
  }

  private async statusId(code: string) {
    const status = await this.prisma.documentStatus.findUnique({
      where: { code },
      select: { id: true },
    });
    if (!status) throw new Error(`Document status ${code} is missing`);
    return status.id;
  }

  private async statusIds(codes: string[]) {
    const statuses = await this.prisma.documentStatus.findMany({
      where: { code: { in: codes } },
      select: { id: true },
    });
    if (statuses.length !== codes.length)
      throw new Error('A document status is missing');
    return statuses.map(({ id }) => id);
  }

  private presentStatus<T extends { status: { code: string }; ocrStatusId: number }>(document: T) {
    const { status, ocrStatusId: _statusId, ...fields } = document;
    return { ...fields, ocrStatus: status.code };
  }
}
