import type { AgentSession } from "@earendil-works/pi-coding-agent";

import type { ReadBackground } from "../background.ts";

/**
 * @spec Current business context is a replaceable custom/user prefix, never system instructions or an Input.
 * @why Projection runs before every model request, including tools, followUp and steer. Resource state
 * stays outside compressible native history and is rebuilt after resume; unchanged content stays identical.
 * @link docs/harness/pi.md#当前业务背景
 */
export function bindBackground(session: AgentSession, read: ReadBackground): void {
  const transform = session.agent.transformContext;
  session.agent.transformContext = async (messages, signal) => {
    const history = transform ? await transform(messages, signal) : messages;
    signal?.throwIfAborted();
    const current = await read();
    signal?.throwIfAborted();
    const text = current.text();
    const background = text ? [{
      role: "custom" as const, customType: "aide.background", display: false,
      content: `<aide_background>\n${text}\n</aide_background>`, timestamp: 0,
    }] : [];
    const first = history.findIndex(message => message.role !== "system");
    const at = first < 0 ? history.length : first;
    return [...history.slice(0, at), ...background, ...history.slice(at)];
  };
}
