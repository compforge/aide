/** Stable identity; namespaces are assigned by the host, never by a Plugin. */
export interface CommandRef {
  readonly namespace: string;
  readonly name: string;
}

export interface CommandInput {
  readonly argument: string;
  readonly selectedValue?: string;
  readonly searchQuery?: string;
}

export type CommandInputShape =
  | { readonly kind: "argument" }
  | { readonly kind: "none"; readonly trailingText: "reject" | "submit" };

export interface CommandAlias {
  readonly name: string;
  readonly description?: string;
  readonly boundArgument?: string;
  readonly input?: CommandInputShape;
}

export interface CommandContext {
  readonly executionId: string;
  readonly command: CommandRef;
}

export interface CommandOption {
  readonly name: string;
  readonly description?: string;
  readonly value: string;
}

export interface CommandPickerSearch {
  readonly mode: "local" | "remote";
  readonly query?: string;
  readonly placeholder?: string;
}

/** Presentation only. Commands do not own a Harness execution context. */
export type CommandResult =
  | { readonly kind: "message"; readonly text: string }
  | {
      readonly kind: "picker";
      readonly title: string;
      readonly options: readonly CommandOption[];
      readonly search?: CommandPickerSearch;
    };

/** Builtin and Plugin commands share identity, invocation and presentation contracts. */
export interface Command extends CommandRef {
  readonly description: string;
  readonly scope?: "aide" | "harness";
  readonly runPolicy?: "always" | "idle";
  readonly input?: CommandInputShape;
  readonly aliases?: readonly CommandAlias[];
  execute(input: CommandInput, context: CommandContext): Promise<CommandResult | void>;
}

/** The registrar binds namespace to the trusted provider identity. */
export type CommandDefinition = Omit<Command, "namespace">;
