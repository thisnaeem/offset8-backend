import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  Req, UseGuards, UploadedFile, UseInterceptors, Res,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { ChatService } from './chat.service';
import { LiveKitService } from './livekit.service';
import { ChatGateway } from './chat.gateway';
import {
  CreateChannelDto, UpdateChannelDto, SendMessageDto, EditMessageDto,
  StartDmDto, UpdateStatusDto, CreatePollDto, CreateReminderDto,
  CreateUserGroupDto, CreateWorkflowDto, ToggleReactionDto,
} from './dto/chat.dto';
import { v2 as cloudinary } from 'cloudinary';
import { Multer } from 'multer';

// Simple auth guard reading userId from header set by Next.js proxy
import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
@Injectable()
class ChatAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const userId = req.headers['x-user-id'];
    if (!userId) return false;
    req.userId = userId;
    return true;
  }
}

@Controller('chat')
@UseGuards(ChatAuthGuard)
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly livekitService: LiveKitService,
    private readonly gateway: ChatGateway,
  ) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
  }

  // ─── Channels ──────────────────────────────────────────────────
  @Get('channels')
  getChannels(@Req() req: any) {
    return this.chatService.getChannelsForUser(req.userId);
  }

  @Get('channels/public')
  getPublicChannels() {
    return this.chatService.getPublicChannels();
  }

  @Post('channels')
  async createChannel(@Req() req: any, @Body() dto: CreateChannelDto) {
    const channel = await this.chatService.createChannel(req.userId, dto);
    // Notify all invited members via socket
    for (const m of channel.members) {
      this.gateway.broadcastToUser(m.userId, 'channel:new', channel);
    }
    return channel;
  }

  @Get('channels/:id')
  getChannel(@Req() req: any, @Param('id') id: string) {
    return this.chatService.getChannelById(id, req.userId);
  }

  @Patch('channels/:id')
  async updateChannel(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateChannelDto) {
    const channel = await this.chatService.updateChannel(req.userId, id, dto);
    this.gateway.broadcastToChannel(id, 'channel:updated', channel);
    return channel;
  }

  @Post('channels/:id/join')
  async joinChannel(@Req() req: any, @Param('id') id: string) {
    const membership = await this.chatService.joinChannel(req.userId, id);
    const channel = await this.chatService.getChannelById(id, req.userId);
    this.gateway.broadcastToUser(req.userId, 'channel:new', channel);
    return membership;
  }

  @Post('channels/:id/members')
  async addMembers(@Req() req: any, @Param('id') id: string, @Body() body: { memberIds: string[] }) {
    return this.chatService.addMembers(req.userId, id, body.memberIds);
  }

  @Delete('channels/:id/members/:userId')
  async removeMember(@Req() req: any, @Param('id') id: string, @Param('userId') targetId: string) {
    return this.chatService.removeMember(req.userId, id, targetId);
  }

  // ─── Messages ──────────────────────────────────────────────────
  @Get('channels/:id/messages')
  getMessages(
    @Req() req: any,
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.chatService.getMessages(id, req.userId, cursor, limit ? +limit : 50);
  }

  @Get('channels/:id/messages/:msgId/thread')
  getThread(@Param('msgId') msgId: string) {
    return this.chatService.getThreadReplies(msgId);
  }

  @Post('channels/:id/messages')
  async sendMessage(@Req() req: any, @Param('id') id: string, @Body() dto: SendMessageDto) {
    const message = await this.chatService.sendMessage(req.userId, id, dto);
    this.gateway.broadcastToChannel(id, 'message:new', message);
    return message;
  }

  @Patch('messages/:msgId')
  async editMessage(@Req() req: any, @Param('msgId') msgId: string, @Body() dto: EditMessageDto) {
    const message = await this.chatService.editMessage(req.userId, msgId, dto);
    this.gateway.broadcastToChannel(message.channelId, 'message:edited', message);
    return message;
  }

  @Delete('messages/:msgId')
  async deleteMessage(@Req() req: any, @Param('msgId') msgId: string, @Query('channelId') channelId: string) {
    await this.chatService.deleteMessage(req.userId, msgId);
    this.gateway.broadcastToChannel(channelId, 'message:deleted', { id: msgId, channelId });
    return { success: true };
  }

  @Post('messages/:msgId/reaction')
  async toggleReaction(@Req() req: any, @Param('msgId') msgId: string, @Body() dto: ToggleReactionDto, @Query('channelId') channelId: string) {
    const message = await this.chatService.toggleReaction(req.userId, msgId, dto.emoji);
    this.gateway.broadcastToChannel(channelId, 'reaction:updated', { messageId: msgId, reactions: message?.reactions });
    return { success: true };
  }

  @Get('channels/:id/pinned')
  getPinned(@Param('id') id: string) {
    return this.chatService.getPinnedMessages(id);
  }

  @Post('channels/:id/messages/:msgId/pin')
  async pinMessage(@Req() req: any, @Param('id') channelId: string, @Param('msgId') msgId: string) {
    const result = await this.chatService.pinMessage(req.userId, channelId, msgId);
    this.gateway.broadcastToChannel(channelId, 'message:pinned', { messageId: msgId, channelId, pinned: result.pinned });
    return result;
  }

  @Post('channels/:id/read')
  markRead(@Req() req: any, @Param('id') channelId: string) {
    return this.chatService.markRead(req.userId, channelId);
  }


  // ─── DMs ──────────────────────────────────────────────────────
  @Get('dm')
  getDmConversations(@Req() req: any) {
    return this.chatService.getDmConversations(req.userId);
  }

  @Post('dm')
  async startDm(@Req() req: any, @Body() dto: StartDmDto) {
    return this.chatService.getOrCreateDm(req.userId, dto);
  }

  // ─── Search ───────────────────────────────────────────────────
  @Get('search')
  searchMessages(
    @Req() req: any,
    @Query('q') q: string,
    @Query('channelId') channelId?: string,
    @Query('from') senderId?: string,
    @Query('before') before?: string,
    @Query('after') after?: string,
  ) {
    return this.chatService.searchMessages(req.userId, q, channelId, senderId, before, after);
  }

  // ─── Bookmarks ────────────────────────────────────────────────
  @Get('bookmarks')
  getBookmarks(@Req() req: any) {
    return this.chatService.getBookmarks(req.userId);
  }

  @Post('bookmarks')
  toggleBookmark(@Req() req: any, @Body() body: { messageId: string; note?: string }) {
    return this.chatService.toggleBookmark(req.userId, body.messageId, body.note);
  }

  // ─── Presence & Status ────────────────────────────────────────
  @Get('presence')
  getPresence(@Query('userIds') userIds: string) {
    return this.chatService.getPresence(userIds.split(','));
  }

  @Patch('status')
  updateStatus(@Req() req: any, @Body() dto: UpdateStatusDto) {
    return this.chatService.updateStatus(req.userId, dto);
  }

  @Get('status')
  getStatus(@Req() req: any) {
    return this.chatService.getStatus(req.userId);
  }

  // ─── Activity ─────────────────────────────────────────────────
  @Get('activity')
  getActivity(@Req() req: any) {
    return this.chatService.getActivity(req.userId);
  }

  // ─── Polls ────────────────────────────────────────────────────
  @Post('channels/:id/polls')
  async createPoll(@Req() req: any, @Param('id') channelId: string, @Body() dto: CreatePollDto) {
    const poll = await this.chatService.createPoll(req.userId, channelId, dto);
    this.gateway.broadcastToChannel(channelId, 'poll:new', poll);
    return poll;
  }

  @Post('polls/:pollId/vote')
  async votePoll(@Req() req: any, @Param('pollId') pollId: string, @Body() body: { optionIndex: number; channelId: string }) {
    const poll = await this.chatService.votePoll(req.userId, pollId, body.optionIndex);
    this.gateway.broadcastToChannel(body.channelId, 'poll:updated', poll);
    return poll;
  }

  @Post('polls/:pollId/close')
  async closePoll(@Param('pollId') pollId: string) {
    return this.chatService.closePoll(pollId);
  }

  // ─── Reminders ────────────────────────────────────────────────
  @Get('reminders')
  getReminders(@Req() req: any) {
    return this.chatService.getReminders(req.userId);
  }

  @Post('reminders')
  createReminder(@Req() req: any, @Body() dto: CreateReminderDto) {
    return this.chatService.createReminder(req.userId, dto);
  }

  // ─── User Groups ──────────────────────────────────────────────
  @Get('groups')
  getUserGroups() {
    return this.chatService.getUserGroups();
  }

  @Post('groups')
  createUserGroup(@Req() req: any, @Body() dto: CreateUserGroupDto) {
    return this.chatService.createUserGroup(req.userId, dto);
  }

  // ─── Workflows ────────────────────────────────────────────────
  @Get('workflows')
  getWorkflows(@Query('channelId') channelId?: string) {
    return this.chatService.getWorkflows(channelId);
  }

  @Post('workflows')
  createWorkflow(@Req() req: any, @Body() dto: CreateWorkflowDto) {
    return this.chatService.createWorkflow(req.userId, dto);
  }

  @Patch('workflows/:id/toggle')
  toggleWorkflow(@Param('id') id: string, @Body() body: { isActive: boolean }) {
    return this.chatService.toggleWorkflow(id, body.isActive);
  }

  // ─── Analytics ────────────────────────────────────────────────
  @Get('channels/:id/analytics')
  getAnalytics(@Param('id') id: string) {
    return this.chatService.getChannelAnalytics(id);
  }

  // ─── Audit Logs ───────────────────────────────────────────────
  @Get('audit')
  getAuditLogs(@Query('limit') limit?: string) {
    return this.chatService.getAuditLogs(limit ? +limit : 100);
  }

  // ─── Export ───────────────────────────────────────────────────
  @Get('export/:channelId')
  async exportData(@Param('channelId') channelId: string, @Query('format') format: string, @Res() res: Response) {
    const data = await this.chatService.exportChannelData(channelId);
    if (format === 'csv') {
      const rows = [
        ['id', 'sender', 'content', 'createdAt'].join(','),
        ...data.messages.map(m => [m.id, (m.sender as any).name, `"${m.content.replace(/"/g, '""')}"`, m.createdAt].join(',')),
      ].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${channelId}.csv"`);
      return res.send(rows);
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${channelId}.json"`);
    return res.json(data);
  }

  // ─── File Upload ──────────────────────────────────────────────
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(@Req() req: any, @UploadedFile() file: Express.Multer.File) {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'chat-attachments', resource_type: 'auto' },
        (err, result) => {
          if (err) return reject(err);
          resolve({
            fileUrl: result!.secure_url,
            cloudinaryId: result!.public_id,
            fileType: result!.resource_type,
            fileName: file.originalname,
            fileSize: file.size,
          });
        },
      );
      stream.end(file.buffer);
    });
  }

  // ─── LiveKit ──────────────────────────────────────────────────
  @Post('livekit/token')
  async getLiveKitToken(
    @Req() req: any,
    @Body() body: { roomName: string; participantName: string; type?: string },
  ) {
    const roomName = body.roomName ?? this.livekitService.buildRoomName('call', req.userId);
    return this.livekitService.generateToken(roomName, body.participantName, req.userId);
  }

  @Post('livekit/room')
  async createRoom(@Body() body: { roomName: string }) {
    return this.livekitService.createRoom(body.roomName);
  }

  @Get('livekit/rooms/:roomName/participants')
  async listParticipants(@Param('roomName') roomName: string) {
    return this.livekitService.listParticipants(roomName);
  }
}
