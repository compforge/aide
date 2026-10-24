/**
 * @spec Background is the current business snapshot for one agent request, rendered as custom/user material.
 * @spec The factory reads current resources; text() only renders its snapshot, without fetching or persisting state.
 * @link docs/harness/pi.md#当前业务背景
 */
export interface Background {
  text(): string;
}

export type ReadBackground = () => Background | Promise<Background>;
