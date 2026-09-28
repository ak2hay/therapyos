import { Injectable } from '@nestjs/common';
import { env } from '../config/env';

export interface LlmRequest {
  system: string;
  user: string;
  facts: Record<string, unknown>;
}

export abstract class LlmProvider {
  abstract readonly name: string;
  abstract answer(req: LlmRequest): Promise<string>;
}

/**
 * Deterministic "LLM" that only restates the computed facts. It never invents numbers, which keeps the
 * assistant useful offline and in tests.
 */
@Injectable()
export class MockLlmProvider extends LlmProvider {
  readonly name = 'mock';
  async answer(req: LlmRequest): Promise<string> {
    const insights = (req.facts.insights as string[] | undefined) ?? [];
    if (!insights.length) return 'I could not find enough data for that period to answer confidently.';
    return insights.map((i) => `- ${i}`).join('\n');
  }
}

@Injectable()
export class OpenAiLlmProvider extends LlmProvider {
  readonly name = 'openai';
  async answer(req: LlmRequest): Promise<string> {
    const e = env();
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${e.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: e.OPENAI_MODEL,
        temperature: 0.2,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: `${req.user}\n\nBusiness data (JSON, the only source of truth):\n${JSON.stringify(req.facts)}` },
        ],
      }),
    });
    const json = (await res.json()) as { choices?: { message: { content: string } }[]; error?: { message: string } };
    if (!res.ok) throw new Error(json.error?.message ?? `OpenAI HTTP ${res.status}`);
    return json.choices?.[0]?.message.content ?? '';
  }
}
