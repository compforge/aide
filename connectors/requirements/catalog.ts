import { z } from "zod";
import type { ConnectorDescription } from "@compforge/aide-connector";
import { RequirementKind, RequirementVersion } from "@compforge/aide-connector/requirement";

const Me = z.object({ userKey: z.string().trim().min(1) }).strict();
/** Public, explicitly configured human identity; credentials never imply Me. */
export function requirementCatalog(catalog: readonly ConnectorDescription[]) {
  return catalog.filter(d => d.kind === RequirementKind && d.version === RequirementVersion).map(d => ({
    source: d.name, ...(d.metadata.me === undefined ? {} : { me: Me.parse(d.metadata.me) }),
  }));
}
