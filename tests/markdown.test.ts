import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../src/web/shared/markdown.ts";

test("Markdown renders headings, nested lists, tables, quotes, links and code as readable HTML", () => {
  const html = renderMarkdown(`# 项目进展

- **已完成**
  - 查看了需求

> 需要继续跟进

| 工作 | 状态 |
| --- | --- |
| Aide | 进行中 |

使用 \`aide version\` 或 [项目](https://example.com/project)。

\`\`\`ts
const result = "<done>";
\`\`\`
`);
  for (const tag of ["h1", "ul", "strong", "blockquote", "table", "thead", "tbody", "pre", "code"]) assert.ok(html.includes(`<${tag}`), tag);
  assert.match(html, /<ul>[\s\S]*<ul>/);
  assert.match(html, /const result = &quot;&lt;done&gt;&quot;/);
  assert.match(html, /href="https:\/\/example.com\/project" target="_blank" rel="noopener noreferrer"/);
});

test("Markdown leaves arbitrary HTML inert and rejects executable links and image loading", () => {
  const html = renderMarkdown(`<script>alert(1)</script>
<img src=x onerror="alert(2)">
<svg onload=alert(3)></svg>
[run](javascript:alert%281%29)
[entity](&#106;avascript:alert%281%29)
[data](data:text/html;base64,QQ==)
[file](file:///etc/passwd)
![remote](https://example.com/tracker.png)

\`\`\`html
</code><script>alert(4)</script>
\`\`\``);
  assert.doesNotMatch(html, /<(script|img|svg|iframe)\b/i);
  assert.doesNotMatch(html, /href="(?:javascript|data|file):/i);
  assert.match(html, /&lt;script&gt;/);
});

test("Markdown accepts incomplete streaming fences and reparses a completed answer", () => {
  const partial = "## 检查结果\n\n```ts\nconst answer = 42;";
  const first = renderMarkdown(partial);
  assert.match(first, /<h2>检查结果<\/h2>/);
  assert.match(first, /<pre><code class="language-ts">const answer = 42;/);
  const final = renderMarkdown(partial + "\n```\n\n**完成**");
  assert.match(final, /<\/code><\/pre>\s*<p><strong>完成<\/strong><\/p>/);
});
