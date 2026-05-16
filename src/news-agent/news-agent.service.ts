import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import OpenAI from 'openai';

interface NewsArticle {
  title: string;
  url: string;
  source: string;
  description: string;
}

@Injectable()
export class NewsAgentService {
  private readonly logger = new Logger(NewsAgentService.name);
  private readonly openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  constructor(private prisma: PrismaService) {}

  // ─── Config ────────────────────────────────────────────────────────────────

  async getConfig(userId: string) {
    return this.prisma.db.newsAgentConfig.findUnique({ where: { userId } });
  }

  async upsertConfig(
    userId: string,
    dto: {
      enabled: boolean;
      deliveryHour: number;
      deliveryMin: number;
      topics: string[];
    },
  ) {
    return this.prisma.db.newsAgentConfig.upsert({
      where: { userId },
      create: { userId, ...dto },
      update: dto,
    });
  }

  // ─── Summaries ─────────────────────────────────────────────────────────────

  async getSummaries(userId: string, limit = 10) {
    return this.prisma.db.newsSummary.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getTodaySummary(userId: string) {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date();
    end.setUTCHours(23, 59, 59, 999);

    return this.prisma.db.newsSummary.findFirst({
      where: { userId, createdAt: { gte: start, lte: end } },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ─── News Fetching ─────────────────────────────────────────────────────────

  private async fetchGoogleNewsRSS(topic: string): Promise<NewsArticle[]> {
    try {
      const encoded = encodeURIComponent(topic);
      const url = `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;

      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsAgent/1.0)' },
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) return [];
      const xml = await res.text();

      const articles: NewsArticle[] = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match: RegExpExecArray | null;

      while ((match = itemRegex.exec(xml)) !== null && articles.length < 5) {
        const item = match[1];
        const title = this.extractXml(item, 'title')
          .replace(/<!\[CDATA\[|\]\]>/g, '')
          .replace(/\s+-\s+[^-]+$/, '') // strip "- Source Name" at end
          .trim();
        const link = this.extractXml(item, 'link').trim();
        const source = this.extractXml(item, 'source').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
        const desc = this.extractXml(item, 'description')
          .replace(/<!\[CDATA\[|\]\]>/g, '')
          .replace(/<[^>]+>/g, '')
          .slice(0, 200)
          .trim();

        if (title && link) {
          articles.push({ title, url: link, source: source || 'Unknown', description: desc });
        }
      }

      return articles;
    } catch (err) {
      this.logger.warn(`RSS fetch failed for topic "${topic}": ${err}`);
      return [];
    }
  }

  private extractXml(xml: string, tag: string): string {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
    return m ? m[1] : '';
  }

  // ─── Generation ────────────────────────────────────────────────────────────

  async generateSummary(userId: string, forcedTopics?: string[]): Promise<{ success: boolean; error?: string }> {
    try {
      let topics = forcedTopics;
      let configId: string | null = null;

      if (!topics || topics.length === 0) {
        const config = await this.prisma.db.newsAgentConfig.findUnique({ where: { userId } });
        if (!config || config.topics.length === 0) {
          return { success: false, error: 'No topics configured. Please select topics and save first.' };
        }
        topics = config.topics;
        configId = config.id;
      } else {
        const config = await this.prisma.db.newsAgentConfig.upsert({
          where: { userId },
          create: { userId, enabled: false, deliveryHour: 8, deliveryMin: 0, topics },
          update: { topics },
        });
        configId = config.id;
      }

      // ── Fetch real articles for each topic ──────────────────────────────────
      this.logger.log(`[NewsAgent] Fetching live news for topics: ${topics.join(', ')}`);
      const articlesByTopic: Record<string, NewsArticle[]> = {};
      const fetchResults = await Promise.allSettled(
        topics.map(async (t) => {
          const articles = await this.fetchGoogleNewsRSS(t);
          articlesByTopic[t] = articles;
        }),
      );
      fetchResults.forEach((r, i) => {
        if (r.status === 'rejected') this.logger.warn(`Failed to fetch news for topic ${topics![i]}: ${r.reason}`);
      });

      // Flatten all unique articles for sources storage
      const allArticles: NewsArticle[] = Object.values(articlesByTopic).flat();
      const uniqueArticles = allArticles.filter((a, i, arr) => arr.findIndex(b => b.url === a.url) === i);

      // Build context string for AI
      const today = new Date().toISOString().split('T')[0];
      let articleContext = '';
      for (const topic of topics) {
        const arts = articlesByTopic[topic] ?? [];
        if (arts.length > 0) {
          articleContext += `\n\n## ${topic}\n`;
          arts.forEach((a, i) => {
            articleContext += `${i + 1}. **${a.title}** (${a.source})\n   ${a.description}\n`;
          });
        }
      }

      const hasRealNews = articleContext.trim().length > 0;
      const systemPrompt = hasRealNews
        ? `You are a professional market analyst. Summarize the provided real news articles into a concise daily briefing. Only reference information from the articles provided. Do not fabricate statistics or events.`
        : `You are a professional market analyst. Generate a daily briefing based on your knowledge of recent trends for the requested topics.`;

      const userPrompt = hasRealNews
        ? `Today is ${today}. Summarize these real news articles into a briefing:\n${articleContext}\n\nFor each topic section:\n- Use **Topic Name** as header\n- Summarize the key points as bullet points\n- End with a 1-sentence outlook\n\nKeep total under 700 words. Be factual and concise.`
        : `Today is ${today}. Generate a daily news briefing covering: ${topics.join(', ')}.\n\nFor each topic:\n- Use **Topic Name** as header\n- 4-5 bullet points of key trends\n- 1-sentence outlook\n\nKeep total under 700 words.`;

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 1200,
        temperature: 0.5,
      });

      const content = completion.choices[0]?.message?.content ?? '';
      if (!content) return { success: false, error: 'Empty AI response' };

      await this.prisma.db.newsSummary.create({
        data: {
          userId,
          topics,
          content,
          sources: JSON.stringify(uniqueArticles),
          configId: configId!,
        },
      });

      await this.prisma.db.notification.create({
        data: {
          userId,
          type: 'NEWS_SUMMARY',
          title: '📰 Daily Briefing Ready',
          message: `Your AI news summary for ${today} covering ${topics.slice(0, 2).join(', ')}${topics.length > 2 ? ' & more' : ''} is ready.`,
          read: false,
        },
      });

      this.logger.log(`[NewsAgent] Generated summary with ${uniqueArticles.length} sources for user ${userId}`);
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to generate summary for ${userId}: ${message}`);
      return { success: false, error: message };
    }
  }

  // ─── Scheduler helper ──────────────────────────────────────────────────────

  async getAllActiveConfigs() {
    return this.prisma.db.newsAgentConfig.findMany({ where: { enabled: true } });
  }

  async hasBeenDeliveredToday(userId: string): Promise<boolean> {
    return !!(await this.getTodaySummary(userId));
  }
}
