import { jsonObject } from "../../config.ts";

const DEFAULT_CATEGORIES = Object.freeze(["story", "issue"]);

export interface MeegoRequirementConfig {
  readonly source: string;
  readonly provider: "meego";
  readonly projectKey: string;
  readonly profile?: string;
  readonly userKeys?: readonly string[];
  readonly categories: readonly string[];
  readonly assigneeField?: string;
}

function object(
  name: string,
  value: unknown,
): Readonly<Record<string, unknown>> {
  return jsonObject(name, value);
}

export function nonEmptyString(name: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must not be empty`);
  }
  return value;
}

function optionalString(
  name: string,
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  return nonEmptyString(name, value);
}

function categories(name: string, value: unknown): readonly string[] {
  if (value === undefined) return DEFAULT_CATEGORIES;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  return Object.freeze(
    value.map((category, index) =>
      nonEmptyString(`${name}[${index}]`, category)
    ),
  );
}

function optionalStrings(
  name: string,
  value: unknown,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  return Object.freeze(
    value.map((item, index) => nonEmptyString(`${name}[${index}]`, item)),
  );
}

export function commandIdentifier(name: string, value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(
      `${name} may contain only letters, numbers, ".", "_" and "-"`,
    );
  }
  return value;
}

/**
 * Reads scoped Aide config. Meegle owns OAuth tokens in its
 * keychain-backed profile; Aide stores only connector routing fields.
 */
export function loadMeegoRequirementConfigs(
  config: Readonly<Record<string, unknown>>,
): readonly MeegoRequirementConfig[] {
  const requirements = config.requirements === undefined
    ? {}
    : object("Aide config requirements", config.requirements);

  const result: MeegoRequirementConfig[] = [];
  for (const [rawSource, rawRequirement] of Object.entries(requirements)) {
    const source = nonEmptyString(
      "Aide requirement source",
      rawSource,
    );
    const requirement = object(
      `Aide requirement source ${source}`,
      rawRequirement,
    );
    if (requirement.provider !== "meego") continue;
    const projectKey = commandIdentifier(
      `Aide requirement source ${source} projectKey`,
      nonEmptyString(
        `Aide requirement source ${source} projectKey`,
        requirement.projectKey,
      ),
    );
    const configuredCategories = categories(
      `Aide requirement source ${source} categories`,
      requirement.categories,
    ).map((category) =>
      commandIdentifier(
        `Aide requirement source ${source} category`,
        category,
      )
    );
    result.push(Object.freeze({
      source,
      provider: "meego",
      projectKey,
      profile: optionalString(
        `Aide requirement source ${source} profile`,
        requirement.profile,
      ),
      userKeys: optionalStrings(
        `Aide requirement source ${source} userKeys`,
        requirement.userKeys,
      ),
      categories: Object.freeze(configuredCategories),
      assigneeField: commandIdentifier("assigneeField", optionalString("assigneeField", requirement.assigneeField) ?? "current_status_operator"),
    }));
  }
  return Object.freeze(result);
}

