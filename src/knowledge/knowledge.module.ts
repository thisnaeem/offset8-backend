import { Module } from '@nestjs/common';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { CloudinaryService } from './cloudinary.service';
import { ExtractionService } from './extraction.service';
import { EmbeddingsService } from './embeddings.service';

@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService, CloudinaryService, ExtractionService, EmbeddingsService],
})
export class KnowledgeModule {}
