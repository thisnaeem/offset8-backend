import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  Req, UseGuards, UseInterceptors, UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { ZoomService } from './zoom.service';
import { TranscriptionService } from './transcription.service';
import { AiSummaryService } from './ai-summary.service';
import { CreateMeetingDto, UpdateMeetingDto, AskQuestionDto } from './dto/zoom.dto';

@Injectable()
class ZoomAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const userId = req.headers['x-user-id'];
    if (!userId) return false;
    req.userId = userId;
    return true;
  }
}

@Controller('zoom')
@UseGuards(ZoomAuthGuard)
export class ZoomController {
  constructor(
    private readonly zoomService: ZoomService,
    private readonly transcriptionService: TranscriptionService,
    private readonly aiSummaryService: AiSummaryService,
  ) {}

  // ─── Meetings CRUD ────────────────────────────────────────────────────────
  @Post('meetings')
  createMeeting(@Req() req: any, @Body() dto: CreateMeetingDto) {
    return this.zoomService.createMeeting(req.userId, dto);
  }

  @Get('meetings')
  listMeetings(@Req() req: any, @Query('filter') filter?: 'upcoming' | 'past' | 'all') {
    return this.zoomService.listMeetings(req.userId, filter ?? 'all');
  }

  @Get('meetings/:id')
  getMeeting(@Param('id') id: string) {
    return this.zoomService.getMeeting(id);
  }

  @Patch('meetings/:id')
  updateMeeting(@Param('id') id: string, @Body() dto: UpdateMeetingDto) {
    return this.zoomService.updateMeeting(id, dto);
  }

  @Delete('meetings/:id')
  cancelMeeting(@Param('id') id: string) {
    return this.zoomService.cancelMeeting(id);
  }

  // ─── Recording Upload & Transcription ────────────────────────────────────
  @Post('meetings/:id/upload')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } }))
  uploadRecording(@Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    return this.transcriptionService.startPipeline(id, file);
  }

  @Get('meetings/:id/status')
  getTranscriptionStatus(@Param('id') id: string) {
    return this.transcriptionService.getStatus(id);
  }

  @Get('meetings/:id/transcript')
  async getTranscript(@Param('id') id: string) {
    const m = await this.zoomService.getMeeting(id);
    return m.transcript;
  }

  @Patch('meetings/:id/transcript')
  async updateTranscript(@Param('id') id: string, @Body() body: { segments: any[] }) {
    return this.aiSummaryService.updateTranscriptSegments(id, body.segments);
  }

  // ─── AI Features ──────────────────────────────────────────────────────────
  @Post('meetings/:id/summarize')
  generateSummary(@Param('id') id: string) {
    return this.aiSummaryService.generateSummary(id);
  }

  @Post('meetings/:id/ask')
  askQuestion(@Param('id') id: string, @Body() dto: AskQuestionDto) {
    return this.aiSummaryService.answerQuestion(id, dto.question);
  }

  // ─── Generate Zoom link for local-only meetings ───────────────────────────
  @Post('meetings/:id/link')
  generateLink(@Param('id') id: string) {
    return this.zoomService.generateLink(id);
  }

  // ─── Tasks ────────────────────────────────────────────────────────────────
  @Get('meetings/:id/tasks')
  async getTasks(@Param('id') id: string) {
    const m = await this.zoomService.getMeeting(id);
    return m.tasks;
  }

  // ─── Search ───────────────────────────────────────────────────────────────
  @Get('transcripts/search')
  searchTranscripts(@Req() req: any, @Query('q') q: string) {
    return this.zoomService.searchTranscripts(req.userId, q);
  }
}
