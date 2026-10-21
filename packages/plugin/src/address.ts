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
