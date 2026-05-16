import { Module } from '@nestjs/common';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { LiveKitService } from './livekit.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [ChatGateway, ChatService, LiveKitService],
  controllers: [ChatController],
  exports: [ChatService, ChatGateway, LiveKitService],
})
export class ChatModule {}
