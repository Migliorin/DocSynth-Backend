import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { OcrQueueService } from './ocr-queue.service.js';

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
    const objectKey = `${userId}/${id}.pdf`;
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
          type,
          userId,
          ocrStatus: 'QUEUED',
        },
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
        objectKey,
        markdownKey: null,
        type,
      });
    } catch (error) {
      await this.prisma.document.update({
        where: { id },
        data: { ocrStatus: 'FAILED', ocrError: 'Could not enqueue OCR job' },
      });
      throw new ServiceUnavailableException('Serviço de OCR indisponível.', {
        cause: error,
      });
    }

    return document;
  }

  async findAll(userId: string) {
    const documents = await this.prisma.document.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { summaries: { orderBy: { createdAt: 'desc' } } },
    });
    return Promise.all(
      documents.map(async (document) => ({
        ...document,
        generatedSummary:
          ['COMPLETED', 'CANCELLED'].includes(document.ocrStatus)
            ? await this.ocrQueue.generatedSummary(document.id)
            : null,
      })),
    );
  }

  async saveSummary(id: string, userId: string) {
    const document = await this.findOne(id, userId);
    if (document.ocrStatus !== 'COMPLETED')
      throw new ConflictException('A síntese ainda não foi concluída.');
    const content = await this.ocrQueue.generatedSummary(id);
    if (!content?.trim())
      throw new ConflictException('Não há uma síntese concluída para salvar.');

    const summary = await this.prisma.documentSummary.create({
      data: {
        documentId: id,
        content,
        topics: document.topics,
        questions: document.questions,
        summaryLevel: document.summaryLevel,
      },
    });
    await this.ocrQueue.clearGeneratedSummary(id);
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

    const update = await this.prisma.document.update({
      where: { id },
      data: {
        topics,
        questions,
        summaryLevel: String(summaryLevel),
        ocrStatus: 'QUEUED',
        ocrError: null,
      },
    });
    try {
      await this.ocrQueue.clearCancellation(id);
      await this.ocrQueue.enqueue({
        action: 'SUMMARIZE',
        documentId: id,
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
          ocrStatus: 'FAILED',
          ocrError: 'Could not enqueue summary job',
        },
      });
      throw new ServiceUnavailableException(
        'Serviço de geração indisponível.',
        { cause: error },
      );
    }
    return update;
  }

  async cancelGeneration(id: string, userId: string) {
    const document = await this.findOne(id, userId);
    if (!document.markdownKey || !['QUEUED', 'SUMMARIZING'].includes(document.ocrStatus))
      throw new ConflictException('Não há uma síntese em geração para interromper.');

    try {
      await this.ocrQueue.requestCancellation(id);
    } catch (error) {
      throw new ServiceUnavailableException('Não foi possível interromper a geração.', { cause: error });
    }
    const { count } = await this.prisma.document.updateMany({
      where: { id, userId, ocrStatus: { in: ['QUEUED', 'SUMMARIZING'] } },
      data: { ocrStatus: 'CANCELLING' },
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
    });
    if (!document) throw new NotFoundException('Documento não encontrado');
    return document;
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
    return this.ocrQueue.stream(id, document.ocrStatus, response);
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
}
