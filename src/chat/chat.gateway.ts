import {
  WebSocketGateway, WebSocketServer, SubscribeMessage,
  ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ChatService } from './chat.service';
import { Cron } from '@nestjs/schedule';

@WebSocketGateway({
  cors: { origin: '*', credentials: true },
  namespace: '/chat',
  transports: ['websocket', 'polling'],
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  private userSockets = new Map<string, string[]>(); // userId → socketIds[]
  private socketUsers = new Map<string, string>();   // socketId → userId

  constructor(private readonly chatService: ChatService) {}

  // ─── Lifecycle ──────────────────────────────────────────────────
  async handleConnection(socket: Socket) {
    const userId = socket.handshake.auth?.userId as string;
    if (!userId) { socket.disconnect(); return; }

    this.socketUsers.set(socket.id, userId);
    const existing = this.userSockets.get(userId) ?? [];
    this.userSockets.set(userId, [...existing, socket.id]);

    // Set user online
    await this.chatService.setPresence(userId, 'ONLINE');
    this.server.emit('presence:update', { userId, status: 'ONLINE' });

    // Auto-join all channel rooms the user belongs to
    const channels = await this.chatService.getChannelsForUser(userId);
    for (const ch of channels) {
      socket.join(`channel:${ch.id}`);
    }
    socket.join(`user:${userId}`);

    socket.emit('connected', { userId, channels });
  }

  async handleDisconnect(socket: Socket) {
    const userId = this.socketUsers.get(socket.id);
    if (!userId) return;

    this.socketUsers.delete(socket.id);
    const remaining = (this.userSockets.get(userId) ?? []).filter(id => id !== socket.id);
    this.userSockets.set(userId, remaining);

    // Only go offline if no more sockets
    if (remaining.length === 0) {
      this.userSockets.delete(userId);
      await this.chatService.setPresence(userId, 'OFFLINE');
      this.server.emit('presence:update', { userId, status: 'OFFLINE' });
    }
  }

  // ─── Channel Events ─────────────────────────────────────────────
  @SubscribeMessage('join:channel')
  handleJoinChannel(@ConnectedSocket() socket: Socket, @MessageBody() channelId: string) {
    socket.join(`channel:${channelId}`);
    return { success: true };
  }

  @SubscribeMessage('leave:channel')
  handleLeaveChannel(@ConnectedSocket() socket: Socket, @MessageBody() channelId: string) {
    socket.leave(`channel:${channelId}`);
    return { success: true };
  }

  // ─── Messaging Events ───────────────────────────────────────────
  @SubscribeMessage('message:send')
  async handleSendMessage(@ConnectedSocket() socket: Socket, @MessageBody() data: { channelId: string; content: string; contentJson?: string; parentId?: string; attachments?: any[] }) {
    const userId = this.socketUsers.get(socket.id);
    if (!userId) return { error: 'Not authenticated' };
    try {
      const message = await this.chatService.sendMessage(userId, data.channelId, {
        content: data.content,
        contentJson: data.contentJson,
        parentId: data.parentId,
        attachments: data.attachments,
      });
      this.server.to(`channel:${data.channelId}`).emit('message:new', message);
      // Notify unread for other members
      this.server.to(`channel:${data.channelId}`).emit('unread:increment', { channelId: data.channelId, senderId: userId });
      // Stop typing for this user
      socket.to(`channel:${data.channelId}`).emit('typing:stop', { userId, channelId: data.channelId });
      return { success: true, message };
    } catch (e) {
      return { error: e.message };
    }
  }

  @SubscribeMessage('message:edit')
  async handleEditMessage(@ConnectedSocket() socket: Socket, @MessageBody() data: { messageId: string; content: string; contentJson?: string }) {
    const userId = this.socketUsers.get(socket.id);
    if (!userId) return { error: 'Not authenticated' };
    try {
      const message = await this.chatService.editMessage(userId, data.messageId, { content: data.content, contentJson: data.contentJson });
      this.server.to(`channel:${message.channelId}`).emit('message:edited', { id: message.id, content: message.content, contentJson: message.contentJson, isEdited: true, editHistory: message.editHistory, channelId: message.channelId });
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  }

  @SubscribeMessage('message:delete')
  async handleDeleteMessage(@ConnectedSocket() socket: Socket, @MessageBody() data: { messageId: string; channelId: string }) {
    const userId = this.socketUsers.get(socket.id);
    if (!userId) return { error: 'Not authenticated' };
    try {
      await this.chatService.deleteMessage(userId, data.messageId);
      this.server.to(`channel:${data.channelId}`).emit('message:deleted', { id: data.messageId, channelId: data.channelId });
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  }

  @SubscribeMessage('reaction:toggle')
  async handleReaction(@ConnectedSocket() socket: Socket, @MessageBody() data: { messageId: string; emoji: string; channelId: string }) {
    const userId = this.socketUsers.get(socket.id);
    if (!userId) return { error: 'Not authenticated' };
    const message = await this.chatService.toggleReaction(userId, data.messageId, data.emoji);
    this.server.to(`channel:${data.channelId}`).emit('reaction:updated', { messageId: data.messageId, reactions: message?.reactions });
    return { success: true };
  }

  @SubscribeMessage('message:pin')
  async handlePinMessage(@ConnectedSocket() socket: Socket, @MessageBody() data: { messageId: string; channelId: string }) {
    const userId = this.socketUsers.get(socket.id);
    if (!userId) return { error: 'Not authenticated' };
    const result = await this.chatService.pinMessage(userId, data.channelId, data.messageId);
    this.server.to(`channel:${data.channelId}`).emit('message:pinned', { messageId: data.messageId, channelId: data.channelId, pinned: result.pinned });
    return { success: true, ...result };
  }

  @SubscribeMessage('message:read')
  async handleMarkRead(@ConnectedSocket() socket: Socket, @MessageBody() data: { channelId: string }) {
    const userId = this.socketUsers.get(socket.id);
    if (!userId) return;
    await this.chatService.markRead(userId, data.channelId);
    socket.emit('unread:clear', { channelId: data.channelId });
  }

  // ─── Typing Indicators ──────────────────────────────────────────
  @SubscribeMessage('typing:start')
  handleTypingStart(@ConnectedSocket() socket: Socket, @MessageBody() data: { channelId: string }) {
    const userId = this.socketUsers.get(socket.id);
    if (!userId) return;
    socket.to(`channel:${data.channelId}`).emit('typing:start', { userId, channelId: data.channelId });
  }

  @SubscribeMessage('typing:stop')
  handleTypingStop(@ConnectedSocket() socket: Socket, @MessageBody() data: { channelId: string }) {
    const userId = this.socketUsers.get(socket.id);
    if (!userId) return;
    socket.to(`channel:${data.channelId}`).emit('typing:stop', { userId, channelId: data.channelId });
  }

  // ─── Presence ───────────────────────────────────────────────────
  @SubscribeMessage('presence:ping')
  async handlePresencePing(@ConnectedSocket() socket: Socket) {
    const userId = this.socketUsers.get(socket.id);
    if (!userId) return;
    await this.chatService.setPresence(userId, 'ONLINE');
  }

  @SubscribeMessage('presence:away')
  async handlePresenceAway(@ConnectedSocket() socket: Socket) {
    const userId = this.socketUsers.get(socket.id);
    if (!userId) return;
    await this.chatService.setPresence(userId, 'AWAY');
    this.server.emit('presence:update', { userId, status: 'AWAY' });
  }

  // ─── Poll Events ────────────────────────────────────────────────
  @SubscribeMessage('poll:vote')
  async handlePollVote(@ConnectedSocket() socket: Socket, @MessageBody() data: { pollId: string; optionIndex: number; channelId: string }) {
    const userId = this.socketUsers.get(socket.id);
    if (!userId) return { error: 'Not authenticated' };
    const poll = await this.chatService.votePoll(userId, data.pollId, data.optionIndex);
    this.server.to(`channel:${data.channelId}`).emit('poll:updated', poll);
    return { success: true };
  }

  // ─── Huddle / Call Signaling ─────────────────────────────────────
  @SubscribeMessage('huddle:join')
  handleHuddleJoin(@ConnectedSocket() socket: Socket, @MessageBody() data: { channelId: string; token: string }) {
    const userId = this.socketUsers.get(socket.id);
    if (!userId) return;
    socket.join(`huddle:${data.channelId}`);
    socket.to(`channel:${data.channelId}`).emit('huddle:user_joined', { userId, channelId: data.channelId });
  }

  @SubscribeMessage('huddle:leave')
  handleHuddleLeave(@ConnectedSocket() socket: Socket, @MessageBody() data: { channelId: string }) {
    const userId = this.socketUsers.get(socket.id);
    if (!userId) return;
    socket.leave(`huddle:${data.channelId}`);
    socket.to(`channel:${data.channelId}`).emit('huddle:user_left', { userId, channelId: data.channelId });
  }

  @SubscribeMessage('call:start')
  handleCallStart(@ConnectedSocket() socket: Socket, @MessageBody() data: { targetUserId: string; channelId: string; type: 'audio' | 'video' }) {
    const userId = this.socketUsers.get(socket.id);
    if (!userId) return;
    this.server.to(`user:${data.targetUserId}`).emit('call:incoming', { fromUserId: userId, channelId: data.channelId, type: data.type });
  }

  @SubscribeMessage('call:accept')
  handleCallAccept(@ConnectedSocket() socket: Socket, @MessageBody() data: { channelId: string; fromUserId: string }) {
    const userId = this.socketUsers.get(socket.id);
    if (!userId) return;
    this.server.to(`user:${data.fromUserId}`).emit('call:accepted', { byUserId: userId, channelId: data.channelId });
  }

  @SubscribeMessage('call:decline')
  handleCallDecline(@ConnectedSocket() socket: Socket, @MessageBody() data: { fromUserId: string }) {
    const userId = this.socketUsers.get(socket.id);
    if (!userId) return;
    this.server.to(`user:${data.fromUserId}`).emit('call:declined', { byUserId: userId });
  }

  @SubscribeMessage('call:end')
  handleCallEnd(@ConnectedSocket() socket: Socket, @MessageBody() data: { channelId: string; roomName: string }) {
    const userId = this.socketUsers.get(socket.id);
    if (!userId) return;
    this.server.to(`channel:${data.channelId}`).emit('call:ended', { byUserId: userId, roomName: data.roomName });
  }

  // ─── Workflow Events ─────────────────────────────────────────────
  @SubscribeMessage('workflow:trigger')
  async handleWorkflowTrigger(@ConnectedSocket() socket: Socket, @MessageBody() data: { workflowId: string; channelId: string; context: any }) {
    const userId = this.socketUsers.get(socket.id);
    if (!userId) return;
    this.server.to(`channel:${data.channelId}`).emit('workflow:triggered', { workflowId: data.workflowId, by: userId, context: data.context });
  }

  // ─── Cron jobs ──────────────────────────────────────────────────
  @Cron('*/5 * * * *') // Every 5 minutes
  async processScheduledMessages() {
    const due = await this.chatService.processDueScheduledMessages();
    for (const msg of due) {
      this.server.to(`channel:${msg.channelId}`).emit('message:new', msg);
    }
  }

  @Cron('* * * * *') // Every minute
  async processReminders() {
    const due = await this.chatService.processDueReminders();
    for (const reminder of due) {
      this.server.to(`user:${reminder.userId}`).emit('reminder:due', reminder);
    }
  }

  // Helper for external notification push
  broadcastToChannel(channelId: string, event: string, data: any) {
    this.server.to(`channel:${channelId}`).emit(event, data);
  }

  broadcastToUser(userId: string, event: string, data: any) {
    this.server.to(`user:${userId}`).emit(event, data);
  }
}
