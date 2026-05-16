import { Controller, Get, Post, Body, Query, Headers, UnauthorizedException } from '@nestjs/common';
import { NewsAgentService } from './news-agent.service';

// Lightweight auth via shared secret (passed from Next.js API routes)
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? 'offset8-internal-2024';

@Controller('news-agent')
export class NewsAgentController {
  constructor(private readonly newsAgentService: NewsAgentService) {}

  private checkAuth(headers: Record<string, string>) {
    if (headers['x-internal-key'] !== INTERNAL_KEY) {
      throw new UnauthorizedException('Invalid internal key');
    }
  }

  @Get('config')
  async getConfig(
    @Headers() headers: Record<string, string>,
    @Query('userId') userId: string,
  ) {
    this.checkAuth(headers);
    const config = await this.newsAgentService.getConfig(userId);
    return config ?? {
      enabled: false,
      deliveryHour: 8,
      deliveryMin: 0,
      topics: [],
    };
  }

  @Post('config')
  async saveConfig(
    @Headers() headers: Record<string, string>,
    @Body() body: {
      userId: string;
      enabled: boolean;
      deliveryHour: number;
      deliveryMin: number;
      topics: string[];
    },
  ) {
    this.checkAuth(headers);
    const { userId, ...dto } = body;
    return this.newsAgentService.upsertConfig(userId, dto);
  }

  @Get('summaries')
  async getSummaries(
    @Headers() headers: Record<string, string>,
    @Query('userId') userId: string,
    @Query('limit') limit?: string,
  ) {
    this.checkAuth(headers);
    return this.newsAgentService.getSummaries(userId, limit ? parseInt(limit) : 10);
  }

  @Get('today')
  async getTodaySummary(
    @Headers() headers: Record<string, string>,
    @Query('userId') userId: string,
  ) {
    this.checkAuth(headers);
    return this.newsAgentService.getTodaySummary(userId);
  }

  @Post('trigger')
  async triggerNow(
    @Headers() headers: Record<string, string>,
    @Body() body: { userId: string; topics?: string[] },
  ) {
    this.checkAuth(headers);
    return this.newsAgentService.generateSummary(body.userId, body.topics);
  }
}
