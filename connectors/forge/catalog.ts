import { z } from "zod";
import type { ConnectorDescription } from "@compforge/aide-connector";
import { ForgeKind, ForgeVersion } from "@compforge/aide-connector/forge";

export const ForgeMeSchema = z.object({ username: z.string().trim().min(1) }).strict();

/** @spec Only explicit public Me metadata identifies the human; credentials and Source author filters do not.
 * @see {@link component://docs/connector/forge.md}
 */
export function forgeCatalog(catalog: readonly ConnectorDescription[]) {
  return catalog.filter(d => d.kind === ForgeKind && d.version === ForgeVersion).map(d => ({
    forge: String(d.metadata.forge ?? d.name), provider: String(d.metadata.provider ?? "external"), revision: d.revision,
    ...(d.metadata.me === undefined ? {} : { me: ForgeMeSchema.parse(d.metadata.me) }),
  }));
}
