import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

const CHUNK_SIZE  = 1200; // chars per chunk
const CHUNK_OVERLAP = 150; // overlap between chunks for context continuity

@Injectable()
export class EmbeddingsService {
  private readonly logger = new Logger(EmbeddingsService.name);
  private openai: OpenAI;

  constructor(private config: ConfigService) {
    this.openai = new OpenAI({ apiKey: this.config.get('OPENAI_API_KEY') });
  }

  /** Split text into overlapping chunks */
  chunkText(text: string): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + CHUNK_SIZE, text.length);
      chunks.push(text.slice(start, end).trim());
      start += CHUNK_SIZE - CHUNK_OVERLAP;
    }
    return chunks.filter(c => c.length > 40); // skip very short chunks
  }

  /** Generate embeddings for an array of strings (batched) */
  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    try {
      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: texts,
      });
      return response.data.map(d => d.embedding);
    } catch (e) {
      this.logger.error('Embedding failed', e);
      throw e;
    }
  }

  /** Cosine similarity between two vectors */
  cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot  += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    return magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
  }
}
