import { Body, Controller, Get, Injectable, Logger, Module, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FeatureFlagKey, PERMISSIONS } from '@therapyos/types';
import { aiQuestionSchema, paginationQuery } from '@therapyos/validation';
import { z } from 'zod';
import { RequestContext } from '../../common/context/request-context';
import { RequireFeature, RequirePermissions } from '../../common/decorators';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { Zod } from '../../common/pipes/zod.pipe';
import { paged } from '../../common/utils/pagination';
import { SettingsService } from '../../core/settings.service';
import { LlmProvider, MockLlmProvider } from '../../integrations/llm.provider';
import { HqModule } from '../hq/hq.module';
import { resolvePeriod } from './ai-period';
import { AiContext, AiIntent, AiResult, AiToolsService } from './ai-tools.service';

type AiQuestion = z.infer<typeof aiQuestionSchema>;

/** Checked in order; the first matching intent wins. */
const INTENTS: { intent: AiIntent; pattern: RegExp }[] = [
  { intent: 'contact_customers', pattern: /\b(contact|call|reach out|follow[- ]?up|win[- ]?back|remind|at[- ]?risk|churn\w*|lapsed|who should)\b/i },
  { intent: 'peak_times', pattern: /\b(peak|busy|busiest|quiet\w*|slots?|time of day|hours?|demand|rush)\b/i },
  { intent: 'repeat_visits', pattern: /\b(repeat|returning|retention|come back|coming back|loyal\w*)\b/i },
  { intent: 'service_trends', pattern: /\b(services?|treatments?|therap(y|ies)|massages?)\b/i },
  { intent: 'branch_attention', pattern: /\b(attention|underperform\w*|struggl\w*|problems?|issues?|worst)\b/i },
  { intent: 'revenue_change', pattern: /\b(revenue|sales|income|earn\w*|turnover|takings|fall|fell|drop\w*|declin\w*|grow\w*|increase\w*|down|up)\b/i },
];

export const SUGGESTED_QUESTIONS = [
  'Why did revenue fall this week?',
  'Which customers should we contact this week?',
  'Which services are growing?',
  'Which branches have declining repeat visits?',
  'What time slots have the highest demand?',
  'Which branches need operational attention?',
];

const FOLLOW_UPS: Record<AiIntent, string[]> = {
  revenue_change: ['Which services are growing?', 'Which customers should we contact this week?', 'Which branches need operational attention?'],
  overview: ['Why did revenue fall this week?', 'Which services are growing?', 'What time slots have the highest demand?'],
  contact_customers: ['Which branches have declining repeat visits?', 'Why did revenue fall this month?'],
  service_trends: ['What time slots have the highest demand?', 'How did revenue change last month?'],
  repeat_visits: ['Which customers should we contact this week?', 'Which branches need operational attention?'],
  peak_times: ['Which services are growing?', 'Why did revenue fall this week?'],
  branch_attention: ['Which branches have declining repeat visits?', 'Why did revenue fall this month?'],
};

export function classify(question: string): AiIntent {
  return INTENTS.find((i) => i.pattern.test(question))?.intent ?? 'overview';
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly fallback = new MockLlmProvider();

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly tools: AiToolsService,
    private readonly llm: LlmProvider,
    private readonly settings: SettingsService,
  ) {}

  private async context(branchId?: string): Promise<AiContext & { tenantName: string; businessType: string | null }> {
    const tenantId = RequestContext.requireTenantId();
    const scope = RequestContext.branchScope(branchId);
    const [tenant, branches, tz] = await Promise.all([
      this.db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, currency: true, businessType: true } }),
      this.db.branch.findMany({ where: { status: 'ACTIVE', ...(scope ? { id: { in: scope } } : {}) }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.settings.timezone(tenantId),
    ]);
    return {
      tenantId,
      tz,
      currency: tenant.currency,
      branchIds: branches.map((b) => b.id),
      branchNames: new Map(branches.map((b) => [b.id, b.name])),
      scoped: !!scope,
      tenantName: tenant.name,
      businessType: tenant.businessType,
    };
  }

  private run(intent: AiIntent, ctx: AiContext, q: AiQuestion): Promise<AiResult> {
    const period = (days: number) => resolvePeriod(q.question, ctx.tz, days, q.from, q.to);
    switch (intent) {
      case 'contact_customers':
        return this.tools.contactCustomers(ctx);
      case 'peak_times':
        return this.tools.peakTimes(ctx);
      case 'repeat_visits':
        return this.tools.repeatVisits(ctx, period(30));
      case 'service_trends':
        return this.tools.serviceTrends(ctx, period(30));
      case 'branch_attention':
        return this.tools.branchAttention(ctx, period(30));
      case 'revenue_change':
        return this.tools.revenueChange(ctx, period(7));
      default:
        return this.tools.revenueChange(ctx, period(7), 'overview');
    }
  }

  async ask(q: AiQuestion) {
    const ctx = await this.context(q.branchId);
    const intent = classify(q.question);
    const result = await this.run(intent, ctx, q);
    const pct = result.metrics.revenueChangePct as number | null | undefined;
    if (intent === 'revenue_change' && pct != null) {
      if (/\b(fall|fell|drop\w*|declin\w*|down|lower)\b/i.test(q.question) && pct > 2) result.headline = `Revenue did not fall. ${result.headline}`;
      else if (/\b(grow\w*|rise|rose|increase\w*|up|higher)\b/i.test(q.question) && pct < -2) result.headline = `Revenue did not grow. ${result.headline}`;
    }
    const facts = { title: result.title, headline: result.headline, period: result.period, insights: result.insights, metrics: result.metrics, table: result.table };
    const system = [
      `You are the business analyst for ${ctx.tenantName}${ctx.businessType ? `, a ${ctx.businessType.toLowerCase()} business` : ''} using TherapyOS.`,
      'Answer the owner in 3 to 6 short bullet points using ONLY the numbers in the business data provided. Never estimate, extrapolate or invent figures, names or causes that are not in the data.',
      'If the data does not answer the question, say so plainly. Amounts are in ' + ctx.currency + '. Finish with one practical next step that follows from the data.',
    ].join(' ');
    let answer: string;
    let provider = this.llm.name;
    try {
      answer = (await this.llm.answer({ system, user: q.question, facts })).trim();
      if (!answer) throw new Error('empty answer');
    } catch (err) {
      this.logger.warn(`LLM provider ${this.llm.name} failed, using the grounded summary: ${(err as Error).message}`);
      answer = await this.fallback.answer({ system, user: q.question, facts });
      provider = `${this.llm.name}:fallback`;
    }
    const stored = { intent, title: result.title, headline: result.headline, insights: result.insights, period: result.period, table: result.table, heatmap: result.heatmap, actions: result.actions, metrics: result.metrics };
    const row = await this.db.aiQuery.create({
      data: { tenantId: ctx.tenantId, userId: RequestContext.userId, question: q.question, answer, provider, metrics: JSON.parse(JSON.stringify(stored)) },
    });
    return { id: row.id, question: q.question, answer, provider, createdAt: row.createdAt, ...stored, suggestions: FOLLOW_UPS[intent] };
  }

  async history(q: z.infer<typeof paginationQuery>) {
    const where = { userId: RequestContext.userId };
    const [items, total] = await Promise.all([
      this.db.aiQuery.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.db.aiQuery.count({ where }),
    ]);
    return paged(
      items.map((r) => ({ id: r.id, question: r.question, answer: r.answer, provider: r.provider, createdAt: r.createdAt, ...((r.metrics as Record<string, unknown>) ?? {}) })),
      total,
      q,
    );
  }
}

@ApiTags('AI assistant')
@ApiBearerAuth()
@Controller('ai')
@RequireFeature(FeatureFlagKey.AI_ASSISTANT)
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('suggestions')
  @RequirePermissions(PERMISSIONS.AI_ASSISTANT_USE)
  suggestions() {
    return { questions: SUGGESTED_QUESTIONS };
  }

  @Post('ask')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RequirePermissions(PERMISSIONS.AI_ASSISTANT_USE)
  ask(@Body(Zod(aiQuestionSchema)) body: AiQuestion) {
    return this.ai.ask(body);
  }

  @Get('history')
  @RequirePermissions(PERMISSIONS.AI_ASSISTANT_USE)
  history(@Query(Zod(paginationQuery)) q: z.infer<typeof paginationQuery>) {
    return this.ai.history(q);
  }
}

@Module({ imports: [HqModule], controllers: [AiController], providers: [AiService, AiToolsService] })
export class AiModule {}
