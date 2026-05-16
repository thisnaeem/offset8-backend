import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from './cloudinary.service';
import { ExtractionService } from './extraction.service';
import { EmbeddingsService } from './embeddings.service';

interface UploadJob {
  file: Express.Multer.File;
  userId: string;
  title: string;
  category?: string;
  visibleTo: string[];
}

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    private prisma:      PrismaService,
    private cloudinary:  CloudinaryService,
    private extraction:  ExtractionService,
    private embeddings:  EmbeddingsService,
  ) {}

  async enqueue(job: UploadJob): Promise<string> {
    const fileType = this.detectFileType(job.file.mimetype);
    const db = this.prisma.db;

    const doc = await db.knowledgeDoc.create({
      data: {
        title:            job.title || job.file.originalname,
        category:         job.category ?? 'General',
        content:          'Processing...',
        visibleTo:        job.visibleTo as any,
        processingStatus: 'PROCESSING',
        fileType,
        createdById:      job.userId,
      },
    });

    // Fire-and-forget — returns docId immediately
    this.process(doc.id, job).catch(err =>
      this.logger.error(`Processing failed for doc ${doc.id}`, err),
    );

    return doc.id;
  }

  async getStatus(docId: string) {
    const doc = await this.prisma.db.knowledgeDoc.findUnique({
      where: { id: docId },
      select: { id: true, processingStatus: true, title: true, fileType: true, cloudinaryUrl: true },
    });
    return doc ?? { error: 'Not found' };
  }

  // ── Background processing pipeline ──────────────────────────────────────
  private async process(docId: string, job: UploadJob) {
    this.logger.log(`[${docId}] Starting pipeline: ${job.file.originalname}`);
    const db = this.prisma.db;

    try {
      // Step 1: Upload to Cloudinary
      this.logger.log(`[${docId}] Uploading to Cloudinary…`);
      const { url, publicId } = await this.cloudinary.upload(
        job.file.buffer, job.file.originalname, job.file.mimetype,
      );

      // Step 2: Extract text
      this.logger.log(`[${docId}] Extracting text…`);
      const rawText = await this.extraction.extract(
        job.file.buffer, job.file.mimetype, job.file.originalname,
      );

      // Step 3: Chunk + embed
      this.logger.log(`[${docId}] Chunking and embedding…`);
      const chunks = this.embeddings.chunkText(rawText);
      this.logger.log(`[${docId}] ${chunks.length} chunks`);

      const allEmbeddings: number[][] = [];
      for (let i = 0; i < chunks.length; i += 20) {
        const vecs = await this.embeddings.embed(chunks.slice(i, i + 20));
        allEmbeddings.push(...vecs);
      }

      // Step 4: Replace old chunks
      await db.knowledgeChunk.deleteMany({ where: { docId } });
      await db.knowledgeChunk.createMany({
        data: chunks.map((content, idx) => ({
          docId,
          content,
          chunkIndex: idx,
          embedding: JSON.stringify(allEmbeddings[idx] ?? []),
        })),
      });

      // Step 5: Mark doc as READY
      await db.knowledgeDoc.update({
        where: { id: docId },
        data: {
          content:             rawText.slice(0, 8000),
          cloudinaryUrl:       url,
          cloudinaryPublicId:  publicId,
          processingStatus:    'READY',
        },
      });

      // Step 6: Notify user
      await db.notification.create({
        data: {
          userId:  job.userId,
          type:    'KB_PROCESSED',
          title:   '📚 Knowledge doc ready',
          message: `"${job.title || job.file.originalname}" has been processed and is now searchable (${chunks.length} chunks indexed).`,
        },
      });

      this.logger.log(`[${docId}] ✅ Done — ${chunks.length} chunks stored`);
    } catch (err) {
      this.logger.error(`[${docId}] ❌ Pipeline failed`, err);
      await db.knowledgeDoc.update({
        where: { id: docId },
        data: { processingStatus: 'FAILED', content: `Processing failed: ${(err as Error).message}` },
      }).catch(() => {});

      await db.notification.create({
        data: {
          userId:  job.userId,
          type:    'KB_FAILED',
          title:   '❌ Knowledge doc failed',
          message: `Failed to process "${job.title || job.file.originalname}": ${(err as Error).message}`,
        },
      }).catch(() => {});
    }
  }

  private detectFileType(mime: string): string {
    if (mime === 'application/pdf') return 'pdf';
    if (mime.includes('word')) return 'docx';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('image/')) return 'image';
    return 'text';
  }
}
