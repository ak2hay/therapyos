import { Injectable } from '@nestjs/common';

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

export interface OpenAiCredentials {
  apiKey: string;
  model: string;
}

export class OpenAiLlmProvider extends LlmProvider {
  readonly name = 'openai';
  constructor(private readonly creds: OpenAiCredentials) {
    super();
  }

  async ping() {
    const res = await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${this.creds.apiKey}` } });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: { message: string } };
      throw new Error(json.error?.message ?? `OpenAI HTTP ${res.status}`);
    }
  }

  async answer(req: LlmRequest): Promise<string> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.creds.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.creds.model,
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
