/** Exact Topic selection supplied by an input adapter; it is not a resolved resource reference. */
export type TopicSelector =
  | { kind: "id"; id: string }
  | { kind: "key"; key: string };

/** @spec The selector determines affinity; the optional source-provided name only initializes presentation.
 * @link docs/personal/topic.md#topiclocator-能力
 */
export interface TopicLocation {
  selector: TopicSelector;
  name?: string;
}

/**
 * @spec Adapters derive optional Topic location information from parsed facts without I/O or resource creation.
 * IDs and source keys are both exact selectors. Future variants may carry generalized or fuzzy features;
 * Route will interpret those features and decide the binding, rather than treating them as exact keys.
 * Returning undefined leaves assignment to Route. Locators do not resolve roots or create Topics.
 * @link docs/personal/topic.md#topiclocator-能力
 */
export interface TopicLocator<T> {
  locate(input: T): TopicLocation | undefined;
}
