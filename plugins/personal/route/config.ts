import { z } from "zod";
export const RoutePolicySchema = z.object({ contextChars: z.number().int().min(4096).max(200000).default(16000) }).strict();
export const routePolicy = (config?: unknown) => RoutePolicySchema.parse(config ?? {});
