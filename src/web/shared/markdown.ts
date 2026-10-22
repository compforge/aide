import MarkdownIt from "markdown-it";

// Raw HTML is displayed as text. Keep the parser's URL checks and avoid remote image requests.
const markdown = new MarkdownIt({ html: false, breaks: true }).disable("image");
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index]!.attrSet("target", "_blank");
  tokens[index]!.attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};

/**
 * @spec Messages and thought/text progress share Markdown rendering; arbitrary HTML never becomes DOM markup.
 * @link docs/channel/web.md
 */
export function renderMarkdown(source: string): string {
  return markdown.render(source);
}

const sources = new WeakMap<HTMLElement, string>();
export function updateMarkdown(node: HTMLElement, source: string): void {
  if (sources.get(node) === source) return;
  node.innerHTML = renderMarkdown(source);
  sources.set(node, source);
}
