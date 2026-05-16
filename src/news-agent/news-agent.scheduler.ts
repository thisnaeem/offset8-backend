import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NewsAgentService } from './news-agent.service';

@Injectable()
export class NewsAgentScheduler {
  private readonly logger = new Logger(NewsAgentScheduler.name);

  constructor(private readonly newsAgentService: NewsAgentService) {}

  // Runs every hour at :00
  @Cron('0 * * * *')
  async runHourlyCheck() {
    const nowHour = new Date().getUTCHours();
    const nowMin = new Date().getUTCMinutes();

    this.logger.log(`[NewsAgent] Hourly check — UTC ${nowHour}:${String(nowMin).padStart(2, '0')}`);

    const configs = await this.newsAgentService.getAllActiveConfigs();

    for (const config of configs) {
      // Match delivery hour (within the same hour window)
      if (config.deliveryHour !== nowHour) continue;

      // Skip if already delivered today
      const alreadySent = await this.newsAgentService.hasBeenDeliveredToday(config.userId);
      if (alreadySent) continue;

      this.logger.log(`[NewsAgent] Triggering summary for user ${config.userId}`);
      const result = await this.newsAgentService.generateSummary(config.userId);

      if (!result.success) {
        this.logger.warn(`[NewsAgent] Failed for ${config.userId}: ${result.error}`);
      }
    }
  }
}
