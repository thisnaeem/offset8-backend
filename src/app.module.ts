import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { PrismaModule } from './prisma/prisma.module';
import { NewsAgentModule } from './news-agent/news-agent.module';
import { ChatModule } from './chat/chat.module';
import { ZoomModule } from './zoom/zoom.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    KnowledgeModule,
    NewsAgentModule,
    ChatModule,
    ZoomModule,
  ],
})
export class AppModule {}



