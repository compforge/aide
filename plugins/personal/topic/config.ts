import { z } from "zod";
const seconds = z.number().int().positive().max(2_147_483);
export const TopicReviewPolicySchema = z.object({
  idleSeconds: seconds.default(900),
  backoff: z.object({ factor: z.number().gt(1), maxIdleSeconds: seconds }).strict().nullable().optional(),
}).strict().transform(config => ({ ...config, backoff: config.backoff === undefined
  ? { factor: 2, maxIdleSeconds: Math.max(7200, config.idleSeconds) } : config.backoff })).refine(config => !config.backoff || config.backoff.maxIdleSeconds >= config.idleSeconds,
  { path: ["backoff", "maxIdleSeconds"], message: "Must be at least idleSeconds" });
export type TopicReviewPolicy = z.infer<typeof TopicReviewPolicySchema>;
export const TopicPolicySchema = z.object({
  trigger: z.object({ intervalSeconds: seconds.default(60) }).strict().prefault({}),
  review: TopicReviewPolicySchema.prefault({}),
  deferred: z.object({ count: z.number().int().min(1).max(10).default(10), maxWaitSeconds: seconds.default(600) }).strict().prefault({}),
  capacityCooldownSeconds: seconds.default(60),
  maxUnfiledInput: z.number().int().min(1).default(40),
  maxNotes: z.number().int().min(1).max(999).default(10),
  maxInput: z.number().int().min(1).default(40),
  maxWork: z.number().int().min(1).default(8),
  maxChildren: z.number().int().min(1).default(8),
  idleMs: z.number().int().min(1000).default(7 * 24 * 3600_000),
  contextChars: z.number().int().min(4096).max(200_000).default(48_000),
  maxChars: z.number().int().min(256).max(16_000).optional(),
  summaryChars: z.number().int().min(256).max(16_000).optional(),
}).strict().transform(({ summaryChars, maxChars, ...policy }) => ({ ...policy, maxChars: maxChars ?? summaryChars ?? 4000 }));
export type TopicPolicy = z.infer<typeof TopicPolicySchema>;
export const topicPolicy = (config?: unknown) => TopicPolicySchema.parse(config ?? {});
