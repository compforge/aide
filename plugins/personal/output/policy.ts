import { sensitivityRank, type Sensitivity, type Visibility } from "../disclosure.ts";

export interface PolicyNote {
  sensitivity: Sensitivity;
  visibility: Visibility;
  people: string[];
  topicPeople?: string[];
  rootPeople?: string[];
}
export interface DisclosurePolicy { sensitivity: Sensitivity; visibility: Visibility; people: string[] }
const visibilityRank: Record<Visibility, number> = { people: 0, topic: 1, root: 2, any: 3 };
/**
 * @spec Output disclosure is derived from cited Notes. Current policy uses highest sensitivity and narrowest visibility kind.
 * @spec People visibility includes the union of every cited Note's people. Topic/root unions participants of Notes imposing that kind.
 * @why Policy aggregation can evolve without changing Chief or Output delivery lifecycle.
 * @link docs/personal/disclosure.md
 */
export function disclosurePolicy(notes: PolicyNote[]): DisclosurePolicy | undefined {
  if (!notes.length) return;
  const sensitivity = notes.map(n => n.sensitivity).reduce((a, b) => sensitivityRank(a) >= sensitivityRank(b) ? a : b);
  const visibility = notes.map(n => n.visibility).reduce((a, b) => visibilityRank[a] <= visibilityRank[b] ? a : b);
  let groups: Array<string[] | undefined>;
  switch (visibility) {
    case "people": groups = notes.map(n => n.people); break;
    case "topic": groups = notes.filter(n => n.visibility === visibility).map(n => n.topicPeople); break;
    case "root": groups = notes.filter(n => n.visibility === visibility).map(n => n.rootPeople); break;
    case "any": groups = []; break;
  }
  if (groups.some(group => group === undefined)) return;
  return { sensitivity, visibility, people: [...new Set(groups.flatMap(group => group ?? []))].sort() };
}
