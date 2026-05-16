import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import OpenAI from 'openai';

export interface ActionItem { task: string; owner: string; deadline: string; }
export interface AiResult {
  summary: string;
  actionItems: ActionItem[];
  decisions: string[];
  sentiment: 'positive' | 'neutral' | 'tense';
  keyTopics: string[];
}

@Injectable()
export class AiSummaryService {
  private readonly openai: OpenAI;

  constructor(private readonly prisma: PrismaService) {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async generateSummary(meetingId: string): Promise<AiResult> {
    const transcript = await this.prisma.zoomTranscript.findUniqueOrThrow({ where: { meetingId } });

    const prompt = `You are an expert meeting analyst. Analyze this meeting transcript and return a JSON object with exactly these fields:
{
  "summary": "3-5 sentence summary of the meeting",
  "actionItems": [{"task": "...", "owner": "...", "deadline": "..."}],
  "decisions": ["decision 1", "decision 2"],
  "sentiment": "positive" | "neutral" | "tense",
  "keyTopics": ["topic1", "topic2", "topic3"]
}

Transcript:
${transcript.fullText.slice(0, 12000)}

Respond with ONLY the JSON object, no other text.`;

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    const result: AiResult = JSON.parse(response.choices[0].message.content!);

    // Upsert summary
    await this.prisma.zoomAiSummary.upsert({
      where: { meetingId },
      create: {
        meetingId,
        summary: result.summary,
        actionItems: JSON.stringify(result.actionItems),
        decisions: JSON.stringify(result.decisions),
        sentiment: result.sentiment,
        keyTopics: result.keyTopics,
      },
      update: {
        summary: result.summary,
        actionItems: JSON.stringify(result.actionItems),
        decisions: JSON.stringify(result.decisions),
        sentiment: result.sentiment,
        keyTopics: result.keyTopics,
      },
    });

    // Auto-create tasks from action items
    if (result.actionItems?.length) {
      await this.prisma.zoomTask.deleteMany({ where: { meetingId } });
      await this.prisma.zoomTask.createMany({
        data: result.actionItems.map(ai => ({
          meetingId,
          title: ai.task,
          owner: ai.owner || null,
          deadline: ai.deadline ? new Date(ai.deadline) : null,
        })),
      });
    }

    return result;
  }

  async answerQuestion(meetingId: string, question: string): Promise<string> {
    const transcript = await this.prisma.zoomTranscript.findUniqueOrThrow({ where: { meetingId } });

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant. Answer questions based only on the meeting transcript provided. Be concise and factual.',
        },
        {
          role: 'user',
          content: `Transcript:\n${transcript.fullText.slice(0, 12000)}\n\nQuestion: ${question}`,
        },
      ],
      temperature: 0.2,
    });

    return response.choices[0].message.content ?? 'Could not generate an answer.';
  }

  async updateTranscriptSegments(meetingId: string, segments: any[]) {
    const fullText = segments.map((s: any) => s.text).join(' ');
    return this.prisma.zoomTranscript.update({
      where: { meetingId },
      data: { segments: JSON.stringify(segments), fullText },
    });
  }
}
