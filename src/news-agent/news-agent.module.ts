import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { NewsAgentService } from './news-agent.service';
import { NewsAgentScheduler } from './news-agent.scheduler';
import { NewsAgentController } from './news-agent.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [ScheduleModule.forRoot(), PrismaModule],
  providers: [NewsAgentService, NewsAgentScheduler],
  controllers: [NewsAgentController],
  exports: [NewsAgentService],
})
export class NewsAgentModule {}
