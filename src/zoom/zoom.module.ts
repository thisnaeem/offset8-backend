import { Module } from '@nestjs/common';
import { ZoomController } from './zoom.controller';
import { ZoomService } from './zoom.service';
import { TranscriptionService } from './transcription.service';
import { AiSummaryService } from './ai-summary.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ZoomController],
  providers: [ZoomService, TranscriptionService, AiSummaryService],
  exports: [ZoomService],
})
export class ZoomModule {}
