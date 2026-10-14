import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createClient } from 'redis';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';

const JOBS = 'docsynth:ocr:jobs';
const RESULTS = 'docsynth:ocr:results';
const RESULTS_PROCESSING = 'docsynth:ocr:results:processing';
const jobKey = (documentId: string, jobId?: string | null) => jobId ? `${documentId}:${jobId}` : documentId;

type OcrResult = {
  documentId: string;
  jobId?: string | null;
  status: 'EXTRACTING' | 'EXTRACTED' | 'SUMMARIZING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  markdownKey?: string;
  summary?: string;
  error?: string;
};

type OcrJob = {
  action: 'EXTRACT' | 'SUMMARIZE';
  documentId: string;
  jobId: string;
  objectKey: string;
  markdownKey: string | null;
  type: 'PUR' | 'RDA';
  topics?: string[];
  questions?: string[];
  summaryLevel?: string;
  description?: string | null;
};

@Injectable()
export class OcrQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OcrQueueService.name);
  private readonly producer = createClient({
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  });
  private readonly consumer = this.producer.duplicate();
  private running = true;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    this.producer.on('error', (error) => this.logger.error(error.message));
    this.consumer.on('error', (error) => this.logger.error(error.message));
    await Promise.all([this.producer.connect(), this.consumer.connect()]);

    // ponytail: process one backend instance; use Redis consumer groups before horizontal scaling.
    while (
      await this.consumer.lMove(RESULTS_PROCESSING, RESULTS, 'RIGHT', 'LEFT')
    ) {}
    void this.consumeResults();
  }

  async onModuleDestroy() {
    this.running = false;
    this.consumer.disconnect();
    await this.producer.quit();
  }

  async enqueue(job: OcrJob): Promise<void> {
    const key = jobKey(job.documentId, job.jobId);
    if (job.action === 'SUMMARIZE')
      await this.producer
        .multi()
        .del(`docsynth:ocr:summary:${key}`)
        .set(
          `docsynth:ocr:progress:${key}`,
          JSON.stringify({ documentId: job.documentId, jobId: job.jobId, kind: 'status', status: 'QUEUED' }),
          { EX: 3600 },
        )
        .lPush(JOBS, JSON.stringify(job))
        .exec();
    else await this.producer.lPush(JOBS, JSON.stringify(job));
  }

  requestCancellation(documentId: string, jobId: string | null) {
    // shortcut: keep the flag until the worker reaches the job; add expiry when queued jobs have a maximum age.
    return this.producer.set(`docsynth:ocr:cancel:${jobKey(documentId, jobId)}`, '1');
  }

  async generatedSummary(documentId: string, jobId: string | null) {
    const key = jobKey(documentId, jobId);
    const progress = await this.producer.get(`docsynth:ocr:progress:${key}`);
    if (!progress || !['COMPLETED', 'CANCELLED'].includes((JSON.parse(progress) as { status?: string }).status ?? ''))
      return null;
    return this.producer.get(`docsynth:ocr:summary:${key}`);
  }

  clearGeneratedSummary(documentId: string, jobId: string | null) {
    return this.producer.del(`docsynth:ocr:summary:${jobKey(documentId, jobId)}`);
  }

  async stream(documentId: string, jobId: string | null, initialStatus: string, response: Response) {
    const subscriber = this.producer.duplicate();
    const key = jobKey(documentId, jobId);
    const channel = `docsynth:ocr:events:${key}`;
    let lastSequence = 0;
    let closed = false;
    const send = (raw: string, snapshot = false) => {
      try {
        const event = JSON.parse(raw) as {
          sequence?: number;
          status?: string;
          kind?: string;
        };
        if (event.sequence && event.sequence <= lastSequence) return;
        if (event.sequence) lastSequence = event.sequence;
        if (snapshot && event.kind === 'summary_delta') {
          void this.producer
            .get(`docsynth:ocr:summary:${key}`)
            .then((summary) => {
              if (!closed)
                response.write(`data: ${JSON.stringify({ ...event, kind: 'summary_snapshot', summary })}\n\n`);
            });
          return;
        }
        response.write(`data: ${raw}\n\n`);
        if (['EXTRACTED', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(event.status ?? '')) {
          closed = true;
          response.end();
        }
      } catch {
        this.logger.warn(`Ignoring malformed progress event for ${documentId}`);
      }
    };

    await subscriber.connect();
    await subscriber.subscribe(channel, (message) => send(message));
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    response.on('close', () => {
      closed = true;
      void subscriber.unsubscribe(channel).finally(() => subscriber.disconnect());
    });

    const latest = await this.producer.get(`docsynth:ocr:progress:${key}`);
    if (latest) send(latest, true);
    else {
      response.write(`data: ${JSON.stringify({ kind: 'status', status: initialStatus })}\n\n`);
      if (['EXTRACTED', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(initialStatus)) {
        closed = true;
        response.end();
      }
    }

    const heartbeat = setInterval(() => {
      if (!closed) response.write(': keep-alive\n\n');
    }, 20_000);
    response.on('close', () => clearInterval(heartbeat));
  }

  private async consumeResults() {
    while (this.running) {
      let raw: string | null;
      try {
        raw = await this.consumer.blMove(
          RESULTS,
          RESULTS_PROCESSING,
          'RIGHT',
          'LEFT',
          0,
        );
      } catch (error) {
        if (this.running)
          this.logger.error(`Redis result queue error: ${String(error)}`);
        continue;
      }
      if (!raw) continue;

      try {
        await this.applyResult(raw);
        await this.consumer.lRem(RESULTS_PROCESSING, 1, raw);
      } catch (error) {
        this.logger.error(`Could not save OCR result: ${String(error)}`);
        try {
          await this.consumer.lPush(RESULTS, raw);
          await this.consumer.lRem(RESULTS_PROCESSING, 1, raw);
        } catch (queueError) {
          this.logger.error(
            `Could not restore OCR result: ${String(queueError)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async applyResult(raw: string) {
    let result: OcrResult;
    try {
      result = JSON.parse(raw) as OcrResult;
    } catch {
      this.logger.error('Ignoring malformed OCR result from Redis');
      return;
    }

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.documentId) ||
      (result.jobId != null && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(result.jobId)) ||
      !['EXTRACTING', 'EXTRACTED', 'SUMMARIZING', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(result.status)
    ) {
      this.logger.error('Ignoring invalid OCR result from Redis');
      return;
    }

    if (
      ((result.status === 'COMPLETED' && (!result.markdownKey || !result.summary)) ||
        (result.status === 'EXTRACTED' && !result.markdownKey))
    ) {
      this.logger.error(
        'Ignoring completed OCR result without Markdown or summary',
      );
      return;
    }

    const status = await this.prisma.documentStatus.findUnique({
      where: { code: result.status },
      select: { id: true },
    });
    if (!status) throw new Error(`Document status ${result.status} is missing`);
    const cancelledStatusIds = result.status === 'SUMMARIZING'
      ? (await this.prisma.documentStatus.findMany({
          where: { code: { in: ['CANCELLING', 'CANCELLED'] } },
          select: { id: true },
        })).map(({ id }) => id)
      : [];

    const data =
      result.status === 'COMPLETED' || result.status === 'EXTRACTED'
        ? {
            ocrStatusId: status.id,
            markdownKey: result.markdownKey,
            ocrError: null,
          }
        : result.status === 'FAILED'
          ? {
              ocrStatusId: status.id,
              markdownKey: result.markdownKey,
              ocrError: result.error ?? 'OCR failed',
            }
          : {
              ocrStatusId: status.id,
              markdownKey: result.markdownKey,
              ocrError: null,
            };

    const { count } = await this.prisma.document.updateMany({
      where: {
        id: result.documentId,
        // Jobs enfileirados antes desta versão não têm jobId.
        jobId: result.jobId ?? null,
        ...(result.status === 'SUMMARIZING'
          ? { ocrStatusId: { notIn: cancelledStatusIds } }
          : {}),
      },
      data,
    });
    if (!count)
      this.logger.warn(
        `Discarding OCR result for missing or stale document job ${result.documentId}`,
      );
  }
}
