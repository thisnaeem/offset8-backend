import {
  Controller, Post, Get, Param, Body,
  UploadedFile, UseInterceptors, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { KnowledgeService } from './knowledge.service';

@Controller('kb')
export class KnowledgeController {
  constructor(private readonly kb: KnowledgeService) {}

  /**
   * Upload a file + metadata. Returns immediately with docId.
   * Processing runs in the background.
   */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 500 * 1024 * 1024 } }))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body('userId')   userId:   string,
    @Body('title')    title:    string,
    @Body('category') category: string,
    @Body('visibleTo') visibleToRaw: string,
  ) {
    if (!file)   throw new BadRequestException('No file provided');
    if (!userId) throw new BadRequestException('userId required');

    const visibleTo: string[] = visibleToRaw
      ? (typeof visibleToRaw === 'string' ? JSON.parse(visibleToRaw) : visibleToRaw)
      : [];

    const docId = await this.kb.enqueue({ file, userId, title, category, visibleTo });
    return { docId, status: 'PROCESSING', message: 'File queued for processing. You will be notified when ready.' };
  }

  /** Poll processing status */
  @Get('status/:docId')
  async status(@Param('docId') docId: string) {
    return this.kb.getStatus(docId);
  }
}
