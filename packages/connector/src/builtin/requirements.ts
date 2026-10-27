/** Provider-neutral lifecycle state used by Requirement Loop policy. */
export type RequirementState =
  | "open"
  | "in_progress"
  | "completed"
  | "closed"
  | "unknown";

/**
 * Source identifies the configured Connector. Category is provider-defined:
 * Aide displays and passes it back unchanged, but never branches on it.
 */
export interface RequirementIdentity {
  readonly source: string;
  readonly id: string;
  readonly category: string;
}

/**
 * The list shape stays compact. Provider is intentionally absent: it belongs
 * to the configured Connector, just as devloop's forge belongs to a Repo.
 */
export interface RequirementSummary extends RequirementIdentity {
  readonly title: string;
  readonly state: RequirementState;
  readonly url?: string;
  readonly assignee?: string;
  readonly assignees?: readonly RequirementUser[];
  readonly updatedAt?: string;
}

export interface Requirement extends RequirementSummary {
  readonly description?: string;
  readonly acceptanceCriteria?: readonly string[];
}

export interface RequirementListQuery {
  readonly text?: string;
  readonly cursor?: string;
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
  /** Filter by stable assignee keys; absence keeps an on-demand query unfiltered. */
  readonly assigneeUserKeys?: readonly string[];
}

/**
 * Requirement-platform port expressed only in Aide domain terms.
 * Meego and future providers map their DTOs at this boundary.
 */
export interface RequirementConnector {
  /** Stable config key used to route a selected Requirement back here. */
  readonly source: string;
  /** Connector-level provenance; Requirement values remain provider-neutral. */
  readonly provider: string;
  list(
    query?: RequirementListQuery,
  ): Promise<RequirementPage<RequirementSummary>>;
  get(identity: RequirementIdentity): Promise<Requirement>;
  identity(): Promise<RequirementAccount>;
  comments(identity: RequirementIdentity, query?: RequirementCommentQuery): Promise<RequirementPage<RequirementComment>>;
  /** Host-only delivery capability; intentionally absent from Plugin ConnectorClient. */
  addComment?(identity: RequirementIdentity, comment: { text: string; deliveryId: string }): Promise<{ id: string; scope: string }>;
}

export interface RequirementUser { readonly key: string; readonly name?: string }
export interface RequirementAccount { readonly provider: string; readonly scope: string }
export interface RequirementComment {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly author?: RequirementUser;
  readonly mentions?: readonly RequirementUser[];
  /** Correlation retained by the provider, not a Person or an authorization signal. */
  readonly deliveryId?: string;
  /** Filled by the Host only after matching a durable Output at this destination. */
  readonly ownOutput?: boolean;
}
export interface RequirementCommentQuery { readonly start?: string; readonly end?: string; readonly cursor?: string }
export interface RequirementPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}
