import { z } from "zod";
import type { RepositoryKey, Resource } from "@compforge/aide-plugin";
import type { RepositoryWatch, RepositorySourceSpec } from "../repository/config.ts";
import { digest } from "../../chief-model.ts";

const policy = {
  id: z.string().trim().min(1),
  author: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  intervalMs: z.number().int().min(30_000).max(3_600_000).default(300_000),
  initialLookbackMs: z.number().int().min(60_000).max(30 * 86_400_000).default(7 * 86_400_000),
};
export const PullRequestWatchSchema = z.union([
  z.object({ ...policy, forge: z.string().trim().min(1) }).strict(),
  z.object({ ...policy, repositories: z.string().trim().min(1) }).strict(),
]);
export type PullRequestWatch = z.infer<typeof PullRequestWatchSchema>;
const repositoryKey = z.object({ forge: z.object({ name: z.string() }).strict(), path: z.string() }).strict();
export const PullRequestSourceSpecSchema = z.object({
  ...policy,
  forge: z.string(),
  connectionRevision: z.string().default(""),
  repository: repositoryKey.optional(),
  repositorySource: z.object({ name: z.string(), uid: z.string() }).strict().optional(),
}).strict().refine(value => Boolean(value.repository) === Boolean(value.repositorySource), "Repository scope requires a RepositorySource reference");
export type PullRequestSourceSpec = z.infer<typeof PullRequestSourceSpecSchema>;

/** One author uses one discovery policy per Forge, avoiding overlapping account/repository observers. */
export function validateForgeSources(repositories: readonly RepositoryWatch[], pullRequests: readonly PullRequestWatch[], connectors: readonly { forge: string }[]) {
  const unique = (values: readonly string[], label: string) => {
    if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
  };
  unique(repositories.map(w => w.id), "Repository Source id");
  unique(repositories.map(w => w.forge), "Repository Source Forge");
  unique(pullRequests.map(w => w.id), "PullRequest Source id");
  const known = (forge: string) => {
    if (!connectors.some(c => c.forge === forge)) throw new Error(`Source references unknown connector: ${forge}`);
    return forge;
  };
  repositories.forEach(w => known(w.forge));
  unique(pullRequests.map(w => {
    const parent = "repositories" in w ? repositories.find(r => r.id === w.repositories) : undefined;
    if ("repositories" in w && !parent) throw new Error(`PullRequest Source ${w.id} references unknown Repository Source: ${w.repositories}`);
    return JSON.stringify([known("forge" in w ? w.forge : parent!.forge), w.author]);
  }), "PullRequest Source account");
}

export function pullRequestSpec(watch: PullRequestWatch, parent?: Resource<RepositorySourceSpec, unknown>, repository?: RepositoryKey, connectionRevision = ""): PullRequestSourceSpec {
  const { id, author, intervalMs, initialLookbackMs } = watch;
  if ("forge" in watch) return { id, forge: watch.forge, author, intervalMs, initialLookbackMs, connectionRevision };
  if (!parent || !repository || parent.spec.id !== watch.repositories || repository.forge.name !== parent.spec.forge) throw new Error("PullRequest repository scope does not match its configured Source");
  return { id, forge: parent.spec.forge, author, intervalMs, initialLookbackMs, repository, connectionRevision: parent.spec.connectionRevision,
    repositorySource: { name: parent.metadata.name, uid: parent.metadata.uid } };
}
export const pullRequestSourceName = (spec: PullRequestSourceSpec) => digest([
  spec.id, spec.forge, spec.author, spec.repository?.path ?? null, spec.repositorySource?.uid ?? null, spec.connectionRevision,
]);
