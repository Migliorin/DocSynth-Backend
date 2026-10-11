import { OcrQueueService } from './ocr-queue.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

it('replaces the previous summary snapshot before queueing a new generation', async () => {
  const transaction = {
    del: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    lPush: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
  const queue = new OcrQueueService({} as PrismaService);
  Object.defineProperty(queue, 'producer', { value: { multi: () => transaction } });
  const job = {
    action: 'SUMMARIZE' as const,
    documentId: 'document-id',
    objectKey: 'document.pdf',
    markdownKey: 'document.md',
    type: 'PUR' as const,
  };

  await queue.enqueue(job);

  expect(transaction.del).toHaveBeenCalledWith('docsynth:ocr:summary:document-id');
  expect(transaction.set).toHaveBeenCalledWith(
    'docsynth:ocr:progress:document-id',
    JSON.stringify({ documentId: 'document-id', kind: 'status', status: 'QUEUED' }),
    { EX: 3600 },
  );
  expect(transaction.lPush).toHaveBeenCalledWith('docsynth:ocr:jobs', JSON.stringify(job));
  expect(transaction.exec).toHaveBeenCalledOnce();
});

it('returns a cancelled generation as a partial preview', async () => {
  const queue = new OcrQueueService({} as PrismaService);
  const get = vi.fn(async (key: string) => key.includes(':progress:')
    ? JSON.stringify({ status: 'CANCELLED' })
    : 'Texto parcial');
  Object.defineProperty(queue, 'producer', { value: { get } });

  await expect(queue.generatedSummary('document-id')).resolves.toBe('Texto parcial');
  expect(get).toHaveBeenCalledWith('docsynth:ocr:summary:document-id');
});
