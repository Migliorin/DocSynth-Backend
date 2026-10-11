import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DocumentsService } from './documents.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { StorageService } from '../storage/storage.service.js';
import type { OcrQueueService } from './ocr-queue.service.js';

describe('DocumentsService.cancelGeneration', () => {
  const document = {
    id: 'document-id',
    userId: 'owner-id',
    markdownKey: 'document.md',
    ocrStatus: 'SUMMARIZING',
  };
  const prisma = {
    document: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  const queue = {
    requestCancellation: vi.fn(),
    generatedSummary: vi.fn(),
  };
  const service = new DocumentsService(
    prisma as unknown as PrismaService,
    {} as StorageService,
    queue as unknown as OcrQueueService,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.document.findFirst.mockResolvedValue(document);
    prisma.document.updateMany.mockResolvedValue({ count: 1 });
    queue.requestCancellation.mockResolvedValue('OK');
    queue.generatedSummary.mockResolvedValue('Texto parcial');
  });

  it('checks ownership and records cancellation before changing status', async () => {
    await expect(service.cancelGeneration(document.id, document.userId)).resolves.toEqual({ status: 'CANCELLING' });
    expect(prisma.document.findFirst).toHaveBeenCalledWith({ where: { id: document.id, userId: document.userId } });
    expect(queue.requestCancellation).toHaveBeenCalledWith(document.id);
    expect(prisma.document.updateMany).toHaveBeenCalledWith({
      where: { id: document.id, userId: document.userId, ocrStatus: { in: ['QUEUED', 'SUMMARIZING'] } },
      data: { ocrStatus: 'CANCELLING' },
    });
    expect(queue.requestCancellation.mock.invocationCallOrder[0]).toBeLessThan(prisma.document.updateMany.mock.invocationCallOrder[0]);
  });

  it('rejects access to another user document', async () => {
    prisma.document.findFirst.mockResolvedValue(null);
    await expect(service.cancelGeneration(document.id, 'other-user')).rejects.toBeInstanceOf(NotFoundException);
    expect(queue.requestCancellation).not.toHaveBeenCalled();
  });

  it('does not cancel OCR extraction', async () => {
    prisma.document.findFirst.mockResolvedValue({ ...document, markdownKey: null, ocrStatus: 'EXTRACTING' });
    await expect(service.cancelGeneration(document.id, document.userId)).rejects.toBeInstanceOf(ConflictException);
    expect(queue.requestCancellation).not.toHaveBeenCalled();
  });

  it('does not save a cancelled or incomplete synthesis', async () => {
    prisma.document.findFirst.mockResolvedValue({ ...document, ocrStatus: 'CANCELLED' });
    await expect(service.saveSummary(document.id, document.userId)).rejects.toBeInstanceOf(ConflictException);
  });

  it('includes the cancelled partial preview when listing documents', async () => {
    prisma.document.findMany.mockResolvedValue([{ ...document, ocrStatus: 'CANCELLED' }]);
    await expect(service.findAll(document.userId)).resolves.toEqual([
      { ...document, ocrStatus: 'CANCELLED', generatedSummary: 'Texto parcial' },
    ]);
  });

  it('keeps the database state when Redis cannot accept cancellation', async () => {
    queue.requestCancellation.mockRejectedValue(new Error('Redis unavailable'));
    await expect(service.cancelGeneration(document.id, document.userId)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.document.updateMany).not.toHaveBeenCalled();
  });
});
