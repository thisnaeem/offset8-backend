import { Injectable } from '@nestjs/common';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';

@Injectable()
export class LiveKitService {
  private readonly apiKey = process.env.LIVEKIT_API_KEY ?? '';
  private readonly apiSecret = process.env.LIVEKIT_API_SECRET ?? '';
  private readonly livekitHost = process.env.LIVEKIT_URL ?? 'wss://your-livekit-server.livekit.cloud';

  async generateToken(roomName: string, participantName: string, participantId: string, isAdmin = false) {
    const at = new AccessToken(this.apiKey, this.apiSecret, {
      identity: participantId,
      name: participantName,
      ttl: '4h',
    });

    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      roomAdmin: isAdmin,
    });

    return {
      token: await at.toJwt(),
      url: this.livekitHost,
      roomName,
      participantId,
      participantName,
    };
  }

  async createRoom(roomName: string) {
    const svc = new RoomServiceClient(this.livekitHost, this.apiKey, this.apiSecret);
    return svc.createRoom({ name: roomName, emptyTimeout: 300, maxParticipants: 100 });
  }

  async listParticipants(roomName: string) {
    const svc = new RoomServiceClient(this.livekitHost, this.apiKey, this.apiSecret);
    return svc.listParticipants(roomName);
  }

  async removeParticipant(roomName: string, identity: string) {
    const svc = new RoomServiceClient(this.livekitHost, this.apiKey, this.apiSecret);
    return svc.removeParticipant(roomName, identity);
  }

  async muteParticipant(roomName: string, identity: string, trackSid: string) {
    const svc = new RoomServiceClient(this.livekitHost, this.apiKey, this.apiSecret);
    return svc.mutePublishedTrack(roomName, identity, trackSid, true);
  }

  buildRoomName(type: 'call' | 'huddle', channelId: string) {
    return `${type}-${channelId}`;
  }
}
