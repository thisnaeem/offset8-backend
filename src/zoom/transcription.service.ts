import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as path from 'path';
import * as fs from 'fs';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmpeg: typeof import('fluent-ffmpeg') = require('fluent-ffmpeg');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker: string;
}

@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);
  private readonly uploadDir = path.join(process.cwd(), 'uploads', 'zoom');
  private _openai: OpenAI | null = null;

  private get openai(): OpenAI {
    if (!this._openai) {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY environment variable is not set.');
      }
      this._openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return this._openai;
  }

  constructor(private readonly prisma: PrismaService) {
    fs.mkdirSync(this.uploadDir, { recursive: true });
  }

  // ─── Save uploaded file and kick off pipeline ─────────────────────────────
  async startPipeline(meetingId: string, file: Express.Multer.File) {
    const filePath = path.join(this.uploadDir, `${meetingId}_${Date.now()}_${file.originalname}`);
    fs.writeFileSync(filePath, file.buffer);

    // Upsert audio file record
    await this.prisma.zoomAudioFile.upsert({
      where: { meetingId },
      create: {
        meetingId,
        originalName: file.originalname,
        filePath,
        fileSize: file.size,
        mimeType: file.mimetype,
        status: 'UPLOADING',
      },
      update: { filePath, originalName: file.originalname, fileSize: file.size, mimeType: file.mimetype, status: 'UPLOADING', errorMsg: null },
    });

    // Run pipeline async (don't await — frontend polls status)
    this.runPipeline(meetingId, filePath, file.originalname).catch(err => {
      this.logger.error(`Pipeline failed for ${meetingId}: ${err.message}`);
      this.setStatus(meetingId, 'FAILED', err.message);
    });

    return { status: 'UPLOADING' };
  }

  private async runPipeline(meetingId: string, filePath: string, originalName: string) {
    // Step 1: Extract audio
    await this.setStatus(meetingId, 'EXTRACTING');
    const audioPath = filePath.replace(/\.[^.]+$/, '.mp3');
    await this.extractAudio(filePath, audioPath);
    await this.prisma.zoomAudioFile.update({ where: { meetingId }, data: { audioPath } });

    // Step 2: Transcribe
    await this.setStatus(meetingId, 'TRANSCRIBING');
    const segments = await this.transcribeWithWhisper(audioPath);

    // Step 3: Save transcript
    const fullText = segments.map(s => s.text).join(' ');
    const duration = segments.length > 0 ? segments[segments.length - 1].end : 0;

    await this.prisma.zoomTranscript.upsert({
      where: { meetingId },
      create: { meetingId, segments: JSON.stringify(segments), fullText, duration },
      update: { segments: JSON.stringify(segments), fullText, duration },
    });

    await this.setStatus(meetingId, 'DONE');
    this.logger.log(`Transcription done for meeting ${meetingId}`);
  }

  // ─── ffmpeg audio extraction ──────────────────────────────────────────────
  private extractAudio(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioFrequency(16000)
        .audioChannels(1)
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .run();
    });
  }

  // ─── OpenAI Whisper API ───────────────────────────────────────────────────
  private async transcribeWithWhisper(audioPath: string): Promise<TranscriptSegment[]> {
    const MAX_SIZE = 24 * 1024 * 1024; // 24 MB (Whisper API limit is 25 MB)
    const stat = fs.statSync(audioPath);

    let allSegments: TranscriptSegment[] = [];

    if (stat.size <= MAX_SIZE) {
      allSegments = await this.transcribeFile(audioPath, 0);
    } else {
      // Split into ~20 MB chunks using ffmpeg segment
      const chunkDir = audioPath + '_chunks';
      fs.mkdirSync(chunkDir, { recursive: true });
      await this.splitAudio(audioPath, chunkDir);
      const chunks = fs.readdirSync(chunkDir).sort();
      let timeOffset = 0;
      for (const chunk of chunks) {
        const chunkPath = path.join(chunkDir, chunk);
        const segs = await this.transcribeFile(chunkPath, timeOffset);
        allSegments.push(...segs);
        timeOffset = allSegments.length > 0 ? allSegments[allSegments.length - 1].end : timeOffset;
      }
      fs.rmSync(chunkDir, { recursive: true });
    }

    return allSegments;
  }

  private async transcribeFile(audioPath: string, offsetSeconds: number): Promise<TranscriptSegment[]> {
    const fileStream = fs.createReadStream(audioPath);
    const file = await toFile(fileStream, path.basename(audioPath), { type: 'audio/mpeg' });

    const response = await this.openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    } as any);

    const raw = response as any;
    const segments: TranscriptSegment[] = (raw.segments ?? []).map((s: any, i: number) => ({
      start: parseFloat((s.start + offsetSeconds).toFixed(2)),
      end: parseFloat((s.end + offsetSeconds).toFixed(2)),
      text: s.text.trim(),
      speaker: `Speaker ${(i % 3) + 1}`,   // placeholder — real diarization needs AssemblyAI
    }));
    return segments;
  }

  private splitAudio(inputPath: string, outDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions(['-f', 'segment', '-segment_time', '600', '-c', 'copy'])
        .output(path.join(outDir, 'chunk_%03d.mp3'))
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .run();
    });
  }

  private async setStatus(meetingId: string, status: string, errorMsg?: string) {
    await this.prisma.zoomAudioFile.update({
      where: { meetingId },
      data: { status: status as any, ...(errorMsg ? { errorMsg } : {}) },
    });
  }

  // ─── Get pipeline status ──────────────────────────────────────────────────
  async getStatus(meetingId: string) {
    const af = await this.prisma.zoomAudioFile.findUnique({ where: { meetingId } });
    return { status: af?.status ?? 'PENDING', error: af?.errorMsg };
  }
}
