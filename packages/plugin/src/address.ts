/** A serializable communication location. Address kinds own their payload and validation. */
export interface Address {
  readonly kind: string;
}

/** Channel owns endpoint encoding; an address carries no Person identity or topic affinity. */
export interface ChannelAddress extends Address {
  readonly kind: "channel";
  readonly channelId: string;
  readonly endpoint: string;
}

/** A comment destination on an externally owned work item. */
export interface RequirementAddress extends Address {
  readonly kind: "requirement";
  readonly source: string;
  readonly category: string;
  readonly id: string;
  /** Canonical provider scope pins a saved destination across connector reconfiguration. */
  readonly scope: string;
}
