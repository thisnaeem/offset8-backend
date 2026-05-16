import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMeetingDto, UpdateMeetingDto } from './dto/zoom.dto';
import axios from 'axios';

@Injectable()
export class ZoomService {
  private readonly logger = new Logger(ZoomService.name);
  private tokenCache: { token: string; expiresAt: number } | null = null;
  private zoomReadyLogged = false;

  constructor(private readonly prisma: PrismaService) {
    // Clear token cache on startup so any scope changes take effect immediately
    this.tokenCache = null;
  }

  /** Returns true only when real (non-placeholder) credentials are present */
  private zoomConfigured(): boolean {
    const { ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET } = process.env;
    return !!ZOOM_ACCOUNT_ID &&
      !ZOOM_ACCOUNT_ID.includes('your_') &&
      !!ZOOM_CLIENT_ID &&
      !!ZOOM_CLIENT_SECRET;
  }

  // ─── OAuth Token (Server-to-Server) ──────────────────────────────────────
  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.token;
    }
    const { ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET } = process.env;
    const creds = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64');
    const res = await axios.post(
      `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`,
      null,
      { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    this.tokenCache = {
      token: res.data.access_token,
      expiresAt: Date.now() + (res.data.expires_in - 60) * 1000,
    };
    return this.tokenCache.token;
  }

  private async zoomApi(method: string, path: string, data?: any) {
    const token = await this.getAccessToken();
    const res = await axios.request({
      method,
      url: `https://api.zoom.us/v2${path}`,
      data,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    return res.data;
  }

  // ─── Create Meeting ───────────────────────────────────────────────────────
  async createMeeting(hostId: string, dto: CreateMeetingDto) {
    const host = await this.prisma.user.findUniqueOrThrow({ where: { id: hostId } });

    let zoomData: any = null;
    if (this.zoomConfigured()) {
      try {
        zoomData = await this.zoomApi('POST', '/users/me/meetings', {
          topic: dto.title,
          type: dto.isInstant ? 1 : 2,
          start_time: dto.startTime,
          duration: dto.duration,
          agenda: dto.agenda,
          settings: {
            host_video: true,
            participant_video: true,
            join_before_host: true,
            waiting_room: false,
            auto_recording: 'local',
          },
        });
      } catch (err) {
        this.logger.warn('Zoom API call failed, using local-only: ' + err.message);
      }
    } else if (!this.zoomReadyLogged) {
      this.logger.log('Zoom credentials not configured — meetings will be local-only until you set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET in .env');
      this.zoomReadyLogged = true;
    }

    const meeting = await this.prisma.zoomMeeting.create({
      data: {
        title: dto.title,
        agenda: dto.agenda,
        startTime: new Date(dto.startTime),
        duration: dto.duration,
        participants: dto.participants ?? [],
        isInstant: dto.isInstant ?? false,
        zoomMeetingId: zoomData?.id?.toString(),
        joinUrl: zoomData?.join_url,
        startUrl: zoomData?.start_url,
        password: zoomData?.password,
        status: dto.isInstant ? 'IN_PROGRESS' : 'SCHEDULED',
        hostId,
      },
      include: { host: { select: { id: true, name: true, email: true } } },
    });
    return meeting;
  }

  // ─── List Meetings ────────────────────────────────────────────────────────
  async listMeetings(userId: string, filter?: 'upcoming' | 'past' | 'all') {
    const now = new Date();
    const where: any = { hostId: userId };
    if (filter === 'upcoming') where.startTime = { gte: now };
    if (filter === 'past')     where.startTime = { lt: now };
    return this.prisma.zoomMeeting.findMany({
      where,
      orderBy: { startTime: 'desc' },
      include: {
        host: { select: { id: true, name: true, image: true } },
        audioFile: { select: { status: true } },
        transcript: { select: { id: true } },
        aiSummary: { select: { sentiment: true } },
        _count: { select: { tasks: true } },
      },
    });
  }

  // ─── Get Single ───────────────────────────────────────────────────────────
  async getMeeting(id: string) {
    return this.prisma.zoomMeeting.findUniqueOrThrow({
      where: { id },
      include: {
        host: { select: { id: true, name: true, image: true, email: true } },
        audioFile: true,
        transcript: true,
        aiSummary: true,
        tasks: true,
      },
    });
  }

  // ─── Update / Reschedule ──────────────────────────────────────────────────
  async updateMeeting(id: string, dto: UpdateMeetingDto) {
    const meeting = await this.prisma.zoomMeeting.findUniqueOrThrow({ where: { id } });
    if (meeting.zoomMeetingId && this.zoomConfigured()) {
      try {
        await this.zoomApi('PATCH', `/meetings/${meeting.zoomMeetingId}`, {
          topic: dto.title,
          start_time: dto.startTime,
          duration: dto.duration,
          agenda: dto.agenda,
        });
      } catch (err) {
        this.logger.warn('Zoom PATCH failed: ' + err.message);
      }
    }
    return this.prisma.zoomMeeting.update({
      where: { id },
      data: {
        ...(dto.title && { title: dto.title }),
        ...(dto.agenda && { agenda: dto.agenda }),
        ...(dto.startTime && { startTime: new Date(dto.startTime) }),
        ...(dto.duration && { duration: dto.duration }),
        ...(dto.participants && { participants: dto.participants }),
      },
    });
  }

  // ─── Cancel ───────────────────────────────────────────────────────────────
  async cancelMeeting(id: string) {
    const meeting = await this.prisma.zoomMeeting.findUniqueOrThrow({ where: { id } });
    if (meeting.zoomMeetingId && this.zoomConfigured()) {
      try {
        await this.zoomApi('DELETE', `/meetings/${meeting.zoomMeetingId}`);
      } catch (err) {
        this.logger.warn('Zoom DELETE failed: ' + err.message);
      }
    }
    return this.prisma.zoomMeeting.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
  }

  // ─── Generate Zoom link for local-only meeting ────────────────────────────
  async generateLink(id: string) {
    const meeting = await this.prisma.zoomMeeting.findUniqueOrThrow({ where: { id } });
    if (meeting.joinUrl) return meeting; // already has a link

    let zoomData: any = null;
    if (this.zoomConfigured()) {
      try {
        const isInstant = meeting.isInstant;
        // For scheduled: ensure start_time is in the future (>= now + 60s)
        const now = new Date();
        const startTime = new Date(Math.max(meeting.startTime.getTime(), now.getTime() + 60_000));

        const body: any = {
          topic: meeting.title,
          type: isInstant ? 1 : 2,
          duration: meeting.duration,
          agenda: meeting.agenda ?? '',
          settings: { host_video: true, participant_video: true, join_before_host: true, waiting_room: false },
        };
        // type=1 instant meetings must NOT include start_time
        if (!isInstant) body.start_time = startTime.toISOString();

        zoomData = await this.zoomApi('POST', '/users/me/meetings', body);
      } catch (err: any) {
        const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        this.logger.warn(`Zoom API failed in generateLink: ${detail}`);
        return { error: detail };
      }
    } else {
      return { error: 'Zoom credentials not configured — set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET in backend/.env' };
    }

    return this.prisma.zoomMeeting.update({
      where: { id },
      data: {
        zoomMeetingId: zoomData.id?.toString(),
        joinUrl: zoomData.join_url,
        startUrl: zoomData.start_url,
        password: zoomData.password,
        status: meeting.isInstant ? 'IN_PROGRESS' : 'SCHEDULED',
      },
    });
  }


  // ─── Search Transcripts ───────────────────────────────────────────────────
  async searchTranscripts(userId: string, q: string) {
    const meetings = await this.prisma.zoomMeeting.findMany({
      where: { hostId: userId, transcript: { isNot: null } },
      include: { transcript: true },
    });
    const results: any[] = [];
    for (const m of meetings) {
      if (!m.transcript) continue;
      const segments: any[] = JSON.parse(m.transcript.segments || '[]');
      const matched = segments.filter(s =>
        s.text?.toLowerCase().includes(q.toLowerCase()),
      );
      if (matched.length > 0) {
        results.push({ meetingId: m.id, title: m.title, startTime: m.startTime, segments: matched });
      }
    }
    return results;
  }
}
