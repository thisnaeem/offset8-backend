import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateChannelDto, UpdateChannelDto, SendMessageDto,
  EditMessageDto, StartDmDto, UpdateStatusDto,
  CreatePollDto, CreateReminderDto, CreateUserGroupDto, CreateWorkflowDto,
} from './dto/chat.dto';

@Injectable()
export class ChatService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    // Ensure default channels exist
    await this.seedDefaultChannels();
  }

  private async seedDefaultChannels() {
    const adminUser = await this.prisma.user.findFirst({ where: { role: 'ADMIN' } });
    if (!adminUser) return;
    const defaults = [
      { name: 'general', slug: 'general', description: 'Company-wide announcements and work discussions.' },
      { name: 'announcements', slug: 'announcements', description: 'Important company announcements.' },
      { name: 'random', slug: 'random', description: 'Non-work banter and fun stuff.' },
    ];
    for (const ch of defaults) {
      const existing = await this.prisma.chatChannel.findUnique({ where: { slug: ch.slug } });
      if (!existing) {
        const channel = await this.prisma.chatChannel.create({
          data: { ...ch, type: 'PUBLIC', createdById: adminUser.id },
        });
        // Add all users as members
        const users = await this.prisma.user.findMany({ select: { id: true } });
        await this.prisma.chatChannelMember.createMany({
          data: users.map(u => ({ channelId: channel.id, userId: u.id, role: u.id === adminUser.id ? 'OWNER' : 'MEMBER' })),
          skipDuplicates: true,
        });
      }
    }
  }

  // ─── Channels ──────────────────────────────────────────────────────
  async getChannelsForUser(userId: string) {
    const memberships = await this.prisma.chatChannelMember.findMany({
      where: { userId },
      include: {
        channel: {
          include: {
            members: { select: { userId: true, lastReadAt: true } },
            messages: { orderBy: { createdAt: 'desc' }, take: 1, where: { isDeleted: false } },
            _count: { select: { messages: { where: { isDeleted: false } } } },
          },
        },
      },
      orderBy: { joinedAt: 'asc' },
    });
    return memberships.map(m => ({
      ...m.channel,
      myMembership: { role: m.role, lastReadAt: m.lastReadAt, muteUntil: m.muteUntil },
      lastMessage: m.channel.messages[0] ?? null,
      unreadCount: 0, // computed client-side via socket events
    }));
  }

  async createChannel(userId: string, dto: CreateChannelDto) {
    const slug = dto.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
    const channel = await this.prisma.chatChannel.create({
      data: {
        name: dto.name,
        slug: `${slug}-${Date.now()}`,
        description: dto.description,
        type: (dto.type ?? 'PUBLIC') as any,
        createdById: userId,
        members: {
          create: [
            { userId, role: 'OWNER' },
            ...(dto.memberIds ?? []).filter(id => id !== userId).map(id => ({ userId: id, role: 'MEMBER' })),
          ],
        },
      },
      include: { members: true },
    });
    await this.logAudit(userId, 'CHANNEL_CREATED', 'channel', channel.id, { name: channel.name });
    return channel;
  }

  async updateChannel(userId: string, channelId: string, dto: UpdateChannelDto) {
    const channel = await this.prisma.chatChannel.update({ where: { id: channelId }, data: dto as any });
    if (dto.isArchived) await this.logAudit(userId, 'CHANNEL_ARCHIVED', 'channel', channelId, {});
    return channel;
  }

  async getChannelById(channelId: string, userId: string) {
    return this.prisma.chatChannel.findFirst({
      where: { id: channelId, members: { some: { userId } } },
      include: {
        members: { include: { user: { select: { id: true, name: true, email: true, image: true } } } },
        pinnedMessages: { include: { message: { include: { sender: { select: { id: true, name: true, image: true } } } } }, orderBy: { pinnedAt: 'desc' } },
        _count: { select: { members: true, messages: { where: { isDeleted: false } } } },
      },
    });
  }

  async joinChannel(userId: string, channelId: string) {
    const channel = await this.prisma.chatChannel.findUnique({ where: { id: channelId } });
    if (!channel || channel.type !== 'PUBLIC') throw new Error('Channel not found or not public');
    return this.prisma.chatChannelMember.upsert({
      where: { channelId_userId: { channelId, userId } },
      create: { channelId, userId },
      update: {},
    });
  }

  async addMembers(actorId: string, channelId: string, memberIds: string[]) {
    const created = await this.prisma.chatChannelMember.createMany({
      data: memberIds.map(uid => ({ channelId, userId: uid })),
      skipDuplicates: true,
    });
    await this.logAudit(actorId, 'MEMBER_ADDED', 'channel', channelId, { memberIds });
    return created;
  }

  async removeMember(actorId: string, channelId: string, targetUserId: string) {
    await this.prisma.chatChannelMember.delete({ where: { channelId_userId: { channelId, userId: targetUserId } } });
    await this.logAudit(actorId, 'MEMBER_REMOVED', 'channel', channelId, { targetUserId });
  }

  async getPublicChannels() {
    return this.prisma.chatChannel.findMany({
      where: { type: 'PUBLIC', isArchived: false },
      include: { _count: { select: { members: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ─── Messages ──────────────────────────────────────────────────────
  async getMessages(channelId: string, userId: string, cursor?: string, limit = 50) {
    const where: any = { channelId, isDeleted: false, parentId: null };
    if (cursor) where.createdAt = { lt: new Date(cursor) };
    const messages = await this.prisma.chatMessage.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        sender: { select: { id: true, name: true, image: true } },
        reactions: { include: { user: { select: { id: true, name: true } } } },
        attachments: true,
        _count: { select: { replies: true } },
      },
    });
    return messages.reverse();
  }

  async getThreadReplies(parentId: string) {
    return this.prisma.chatMessage.findMany({
      where: { parentId, isDeleted: false },
      orderBy: { createdAt: 'asc' },
      include: {
        sender: { select: { id: true, name: true, image: true } },
        reactions: { include: { user: { select: { id: true, name: true } } } },
        attachments: true,
      },
    });
  }

  async sendMessage(userId: string, channelId: string, dto: SendMessageDto) {
    const msg = await this.prisma.chatMessage.create({
      data: {
        content: dto.content,
        contentJson: dto.contentJson,
        channelId,
        senderId: userId,
        parentId: dto.parentId ?? null,
        isScheduled: dto.isScheduled ?? false,
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
        attachments: dto.attachments?.length
          ? { create: dto.attachments.map(a => ({ ...a, uploadedById: userId })) }
          : undefined,
      },
      include: {
        sender: { select: { id: true, name: true, image: true } },
        reactions: true,
        attachments: true,
      },
    });
    // Increment parent replyCount if this is a thread reply
    if (dto.parentId) {
      await this.prisma.chatMessage.update({ where: { id: dto.parentId }, data: { replyCount: { increment: 1 } } });
    }
    return msg;
  }

  async editMessage(userId: string, messageId: string, dto: EditMessageDto) {
    const msg = await this.prisma.chatMessage.findUnique({ where: { id: messageId } });
    if (!msg || msg.senderId !== userId) throw new Error('Unauthorized');
    const history = JSON.parse(msg.editHistory ?? '[]');
    history.push({ content: msg.content, editedAt: new Date() });
    return this.prisma.chatMessage.update({
      where: { id: messageId },
      data: { content: dto.content, contentJson: dto.contentJson, isEdited: true, editHistory: JSON.stringify(history) },
      include: { sender: { select: { id: true, name: true, image: true } } },
    });
  }

  async deleteMessage(userId: string, messageId: string) {
    const msg = await this.prisma.chatMessage.findUnique({ where: { id: messageId } });
    if (!msg) throw new Error('Not found');
    const actor = await this.prisma.user.findUnique({ where: { id: userId } });
    if (msg.senderId !== userId && actor?.role !== 'ADMIN') throw new Error('Unauthorized');
    await this.logAudit(userId, 'MESSAGE_DELETED', 'message', messageId, { channelId: msg.channelId });
    return this.prisma.chatMessage.update({ where: { id: messageId }, data: { isDeleted: true, content: 'This message was deleted.' } });
  }

  async toggleReaction(userId: string, messageId: string, emoji: string) {
    const existing = await this.prisma.chatReaction.findUnique({ where: { messageId_userId_emoji: { messageId, userId, emoji } } });
    if (existing) {
      await this.prisma.chatReaction.delete({ where: { id: existing.id } });
    } else {
      await this.prisma.chatReaction.create({ data: { messageId, userId, emoji } });
    }
    return this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      include: { reactions: { include: { user: { select: { id: true, name: true } } } } },
    });
  }

  async pinMessage(actorId: string, channelId: string, messageId: string) {
    const existing = await this.prisma.chatPinnedMessage.findUnique({ where: { messageId } });
    if (existing) {
      await this.prisma.chatPinnedMessage.delete({ where: { messageId } });
      await this.prisma.chatMessage.update({ where: { id: messageId }, data: { isPinned: false } });
      await this.logAudit(actorId, 'MESSAGE_UNPINNED', 'message', messageId, { channelId });
      return { pinned: false };
    }
    await this.prisma.chatPinnedMessage.create({ data: { channelId, messageId, pinnedById: actorId } });
    await this.prisma.chatMessage.update({ where: { id: messageId }, data: { isPinned: true } });
    await this.logAudit(actorId, 'MESSAGE_PINNED', 'message', messageId, { channelId });
    return { pinned: true };
  }

  async getPinnedMessages(channelId: string) {
    return this.prisma.chatPinnedMessage.findMany({
      where: { channelId },
      include: { message: { include: { sender: { select: { id: true, name: true, image: true } }, attachments: true } }, pinnedBy: { select: { id: true, name: true } } },
      orderBy: { pinnedAt: 'desc' },
    });
  }

  async markRead(userId: string, channelId: string) {
    await this.prisma.chatChannelMember.update({ where: { channelId_userId: { channelId, userId } }, data: { lastReadAt: new Date() } });
  }

  // ─── DMs ──────────────────────────────────────────────────────────
  async getOrCreateDm(userId: string, dto: StartDmDto) {
    const allIds = [...new Set([userId, ...dto.userIds])].sort();
    const type = allIds.length === 2 ? 'DM' : 'GROUP_DM';
    const slug = `dm-${allIds.join('-')}`;
    let channel = await this.prisma.chatChannel.findUnique({ where: { slug } });
    if (!channel) {
      channel = await this.prisma.chatChannel.create({
        data: {
          name: slug, slug, type: type as any, createdById: userId,
          members: { create: allIds.map(id => ({ userId: id, role: id === userId ? 'OWNER' : 'MEMBER' })) },
        },
      });
    }
    return channel;
  }

  async getDmConversations(userId: string) {
    return this.prisma.chatChannel.findMany({
      where: { type: { in: ['DM', 'GROUP_DM'] }, members: { some: { userId } } },
      include: {
        members: { include: { user: { select: { id: true, name: true, image: true } } } },
        messages: { where: { isDeleted: false }, orderBy: { createdAt: 'desc' }, take: 1, include: { sender: { select: { name: true } } } },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  // ─── Search ────────────────────────────────────────────────────────
  async searchMessages(userId: string, q: string, channelId?: string, senderId?: string, before?: string, after?: string) {
    const userChannels = await this.prisma.chatChannelMember.findMany({ where: { userId }, select: { channelId: true } });
    const allowedChannelIds = userChannels.map(m => m.channelId);
    const where: any = {
      channelId: channelId ? channelId : { in: allowedChannelIds },
      isDeleted: false,
      content: { contains: q, mode: 'insensitive' },
    };
    if (senderId) where.senderId = senderId;
    if (before) where.createdAt = { ...(where.createdAt ?? {}), lt: new Date(before) };
    if (after) where.createdAt = { ...(where.createdAt ?? {}), gt: new Date(after) };
    return this.prisma.chatMessage.findMany({
      where, take: 50, orderBy: { createdAt: 'desc' },
      include: { sender: { select: { id: true, name: true, image: true } }, channel: { select: { id: true, name: true } }, attachments: true },
    });
  }

  // ─── Bookmarks ─────────────────────────────────────────────────────
  async getBookmarks(userId: string) {
    return this.prisma.chatBookmark.findMany({
      where: { userId },
      include: { message: { include: { sender: { select: { id: true, name: true, image: true } }, channel: { select: { id: true, name: true } }, attachments: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async toggleBookmark(userId: string, messageId: string, note?: string) {
    const existing = await this.prisma.chatBookmark.findUnique({ where: { userId_messageId: { userId, messageId } } });
    if (existing) { await this.prisma.chatBookmark.delete({ where: { id: existing.id } }); return { saved: false }; }
    await this.prisma.chatBookmark.create({ data: { userId, messageId, note } });
    return { saved: true };
  }

  // ─── Presence & Status ─────────────────────────────────────────────
  async setPresence(userId: string, status: string) {
    return this.prisma.userPresence.upsert({
      where: { userId }, create: { userId, status: status as any, lastSeen: new Date() },
      update: { status: status as any, lastSeen: new Date() },
    });
  }

  async getPresence(userIds: string[]) {
    return this.prisma.userPresence.findMany({ where: { userId: { in: userIds } } });
  }

  async updateStatus(userId: string, dto: UpdateStatusDto) {
    return this.prisma.userChatStatus.upsert({
      where: { userId }, create: { userId, ...dto as any },
      update: { ...dto as any, updatedAt: new Date() },
    });
  }

  async getStatus(userId: string) {
    return this.prisma.userChatStatus.findUnique({ where: { userId } });
  }

  // ─── Activity Feed ─────────────────────────────────────────────────
  async getActivity(userId: string) {
    const mentions = await this.prisma.chatMessage.findMany({
      where: { content: { contains: `@${userId}` }, isDeleted: false },
      orderBy: { createdAt: 'desc' }, take: 30,
      include: { sender: { select: { id: true, name: true, image: true } }, channel: { select: { id: true, name: true } } },
    });
    const reactionsOnMyMessages = await this.prisma.chatReaction.findMany({
      where: { message: { senderId: userId } },
      orderBy: { createdAt: 'desc' }, take: 30,
      include: { user: { select: { id: true, name: true, image: true } }, message: { include: { channel: { select: { id: true, name: true } } } } },
    });
    const threadReplies = await this.prisma.chatMessage.findMany({
      where: { parent: { senderId: userId }, isDeleted: false },
      orderBy: { createdAt: 'desc' }, take: 30,
      include: { sender: { select: { id: true, name: true, image: true } }, channel: { select: { id: true, name: true } }, parent: true },
    });
    return { mentions, reactions: reactionsOnMyMessages, threadReplies };
  }

  // ─── Polls ─────────────────────────────────────────────────────────
  async createPoll(userId: string, channelId: string, dto: CreatePollDto) {
    return this.prisma.chatPoll.create({
      data: { channelId, createdById: userId, question: dto.question, options: dto.options, endsAt: dto.endsAt ? new Date(dto.endsAt) : null, anonymous: dto.anonymous ?? false },
      include: { votes: { include: { user: { select: { id: true, name: true } } } } },
    });
  }

  async votePoll(userId: string, pollId: string, optionIndex: number) {
    await this.prisma.chatPollVote.upsert({
      where: { pollId_userId: { pollId, userId } },
      create: { pollId, userId, optionIndex },
      update: { optionIndex },
    });
    return this.prisma.chatPoll.findUnique({ where: { id: pollId }, include: { votes: { include: { user: { select: { id: true, name: true } } } } } });
  }

  async closePoll(pollId: string) {
    return this.prisma.chatPoll.update({ where: { id: pollId }, data: { status: 'CLOSED' } });
  }

  // ─── Reminders ─────────────────────────────────────────────────────
  async createReminder(userId: string, dto: CreateReminderDto) {
    return this.prisma.chatReminder.create({
      data: { userId, messageId: dto.messageId ?? null, note: dto.note, remindAt: new Date(dto.remindAt) },
    });
  }

  async getReminders(userId: string) {
    return this.prisma.chatReminder.findMany({
      where: { userId, sent: false },
      include: { message: { include: { channel: { select: { id: true, name: true } } } } },
      orderBy: { remindAt: 'asc' },
    });
  }

  async processDueReminders() {
    const due = await this.prisma.chatReminder.findMany({ where: { sent: false, remindAt: { lte: new Date() } } });
    for (const r of due) {
      await this.prisma.chatReminder.update({ where: { id: r.id }, data: { sent: true } });
    }
    return due;
  }

  // ─── User Groups ───────────────────────────────────────────────────
  async getUserGroups() {
    return this.prisma.chatUserGroup.findMany({ include: { members: { include: { user: { select: { id: true, name: true, image: true } } } } } });
  }

  async createUserGroup(userId: string, dto: CreateUserGroupDto) {
    const group = await this.prisma.chatUserGroup.create({
      data: { name: dto.name, handle: dto.handle, description: dto.description,
        members: { create: dto.memberIds.map(uid => ({ userId: uid })) } },
      include: { members: { include: { user: { select: { id: true, name: true } } } } },
    });
    await this.logAudit(userId, 'USER_GROUP_CREATED', 'user_group', group.id, { name: group.name });
    return group;
  }

  // ─── Workflows ─────────────────────────────────────────────────────
  async getWorkflows(channelId?: string) {
    return this.prisma.chatWorkflow.findMany({
      where: channelId ? { channelId } : {},
      orderBy: { createdAt: 'desc' },
    });
  }

  async createWorkflow(userId: string, dto: CreateWorkflowDto) {
    const wf = await this.prisma.chatWorkflow.create({
      data: { name: dto.name, trigger: dto.trigger, actions: dto.actions, channelId: dto.channelId ?? null, createdById: userId },
    });
    await this.logAudit(userId, 'WORKFLOW_TRIGGERED', 'workflow', wf.id, { name: wf.name });
    return wf;
  }

  async toggleWorkflow(id: string, isActive: boolean) {
    return this.prisma.chatWorkflow.update({ where: { id }, data: { isActive } });
  }

  // ─── Analytics ─────────────────────────────────────────────────────
  async getChannelAnalytics(channelId: string) {
    const [totalMessages, totalMembers, messagesPerDay] = await Promise.all([
      this.prisma.chatMessage.count({ where: { channelId, isDeleted: false } }),
      this.prisma.chatChannelMember.count({ where: { channelId } }),
      this.prisma.chatMessage.groupBy({ by: ['createdAt'], where: { channelId, isDeleted: false }, _count: true }),
    ]);
    return { totalMessages, totalMembers, messagesPerDay };
  }

  // ─── Audit Logs ────────────────────────────────────────────────────
  async getAuditLogs(limit = 100) {
    return this.prisma.chatAuditLog.findMany({
      take: limit, orderBy: { createdAt: 'desc' },
      include: { actor: { select: { id: true, name: true, image: true } } },
    });
  }

  private async logAudit(actorId: string, action: any, entityType: string, entityId?: string, metadata?: any) {
    await this.prisma.chatAuditLog.create({ data: { actorId, action, entityType, entityId, metadata } });
  }

  // ─── Data Export ───────────────────────────────────────────────────
  async exportChannelData(channelId: string) {
    const messages = await this.prisma.chatMessage.findMany({
      where: { channelId },
      include: { sender: { select: { id: true, name: true, email: true } }, attachments: true, reactions: true },
      orderBy: { createdAt: 'asc' },
    });
    const channel = await this.prisma.chatChannel.findUnique({ where: { id: channelId }, include: { members: { include: { user: { select: { id: true, name: true, email: true } } } } } });
    return { channel, messages, exportedAt: new Date() };
  }

  // ─── Scheduled Messages ────────────────────────────────────────────
  async processDueScheduledMessages() {
    const due = await this.prisma.chatMessage.findMany({ where: { isScheduled: true, scheduledAt: { lte: new Date() } } });
    for (const m of due) {
      await this.prisma.chatMessage.update({ where: { id: m.id }, data: { isScheduled: false } });
    }
    return due;
  }
}
