import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { toFile } from 'openai';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdf2md = require('@opendocsg/pdf2md');
import * as mammoth from 'mammoth';

@Injectable()
export class ExtractionService {
  private readonly logger = new Logger(ExtractionService.name);
  private openai: OpenAI;

  constructor(private config: ConfigService) {
    this.openai = new OpenAI({ apiKey: this.config.get('OPENAI_API_KEY') });
  }

  /** Route extraction by MIME type */
  async extract(buffer: Buffer, mimeType: string, fileName: string): Promise<string> {
    this.logger.log(`Extracting text from ${fileName} (${mimeType})`);

    if (mimeType === 'application/pdf') return this.extractPdf(buffer);
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || mimeType === 'application/msword') return this.extractDocx(buffer);
    if (mimeType.startsWith('audio/') || mimeType.startsWith('video/')) return this.transcribeAudioVideo(buffer, fileName);
    if (mimeType.startsWith('image/')) return this.describeImage(buffer, mimeType);
    if (mimeType.startsWith('text/') || mimeType === 'application/json') return buffer.toString('utf-8');

    // Fallback: try as text
    try { return buffer.toString('utf-8'); }
    catch { return `[Binary file: ${fileName}. Content could not be extracted as text.]`; }
  }

  // ── PDF ──────────────────────────────────────────────────────────────────
  private async extractPdf(buffer: Buffer): Promise<string> {
    try {
      const uint8 = new Uint8Array(buffer);
      const markdown = await pdf2md(uint8);
      return markdown || '[Empty PDF]';
    } catch (e) {
      this.logger.error('PDF extraction failed', e);
      return '[PDF extraction failed]';
    }
  }

  // ── DOCX ─────────────────────────────────────────────────────────────────
  private async extractDocx(buffer: Buffer): Promise<string> {
    try {
      const result = await mammoth.extractRawText({ buffer });
      return result.value || '[Empty document]';
    } catch (e) {
      this.logger.error('DOCX extraction failed', e);
      return '[DOCX extraction failed]';
    }
  }

  // ── Audio / Video → OpenAI Whisper ───────────────────────────────────────
  private async transcribeAudioVideo(buffer: Buffer, fileName: string): Promise<string> {
    const tmpPath = join(tmpdir(), `kb_audio_${Date.now()}_${fileName}`);
    try {
      writeFileSync(tmpPath, buffer);
      const file = await toFile(readFileSync(tmpPath), fileName);
      const transcription = await this.openai.audio.transcriptions.create({
        model: 'whisper-1',
        file,
        response_format: 'text',
      });
      return typeof transcription === 'string' ? transcription : JSON.stringify(transcription);
    } catch (e) {
      this.logger.error('Whisper transcription failed', e);
      return '[Audio/video transcription failed]';
    } finally {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  // ── Image → OpenAI Vision ────────────────────────────────────────────────
  private async describeImage(buffer: Buffer, mimeType: string): Promise<string> {
    try {
      const base64 = buffer.toString('base64');
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Describe this image in detail. Extract all visible text, data, charts, tables, or any information that would be useful in a company knowledge base. Be thorough and specific.',
              },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' } },
            ],
          },
        ],
        max_tokens: 2000,
      });
      return response.choices[0]?.message?.content ?? '[Image description failed]';
    } catch (e) {
      this.logger.error('Image vision failed', e);
      return '[Image description failed]';
    }
  }
}
