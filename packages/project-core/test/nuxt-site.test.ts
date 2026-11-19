import { describe, expect, it } from 'vitest';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { renderProjectFiles } from '../src/index';

const files = renderProjectFiles({ name: 'blog-regression', template: 'nuxt-site', features: [] });
// Evaluate the complete generated pure module, without Nuxt or a duplicate parser implementation.
const parserExports: Record<string, unknown> = {};
new Function('exports', transpileModule(files['app/utils/frontmatter.ts']!, {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
}).outputText)(parserExports);
const parseFrontmatter = parserExports.parseFrontmatter as (
  path: string, raw: string,
) => { slug: string; title: string; description: string; date: string; tags: string[]; body: string; readingMinutes: number };
const article = (fields = '') => `---\ntitle: "测试文章"\ndate: 2026-11-19\n${fields}\n---\n\n正文`;
const parse = (fields: string) => parseFrontmatter('/content/blog/regression.md', article(fields));

describe('nuxt-site generated frontmatter parser', () => {
  it('preserves multiline tags, quoted values, CRLF, BOM and fields after the list', () => {
    const raw = article('tags:\n  - Nuxt\n  - "团队: 随笔"\n  - \'随笔\'\ndescription: "摘要: 内容"');
    expect(parseFrontmatter('/content/blog/regression.md', `\uFEFF${raw.replaceAll('\n', '\r\n')}`)).toMatchObject({
      title: '测试文章', description: '摘要: 内容', date: '2026-11-19',
      tags: ['Nuxt', '团队: 随笔', '随笔'], body: '正文',
    });
  });

  it('keeps inline tags and omitted or empty tags compatible', () => {
    expect(parse('tags: [a, "b c"]').tags).toEqual(['a', 'b c']);
    expect(parse('tags: ["团队", \'随笔\', Nuxt]').tags).toEqual(['团队', '随笔', 'Nuxt']);
    for (const fields of ['', 'tags: []', 'tags:']) expect(parse(fields).tags).toEqual([]);
  });

  it('supports comma-separated tags as documented', () => {
    expect(parse('tags: a, "b c", \'d\'').tags).toEqual(['a', 'b c', 'd']);
    expect(parse('tags: "a, b c"').tags).toEqual(['a', 'b c']);
  });

  it('unquotes single-line fields and tags', () => {
    expect(parseFrontmatter('quoted.md', "---\ntitle: 'Quoted title'\ndescription: \"A: summary\"\ndate: '2024-02-29'\ntags: ['a', \"b c\"]\n---\nbody")).toMatchObject({
      title: 'Quoted title', description: 'A: summary', date: '2024-02-29', tags: ['a', 'b c'], body: 'body',
    });
  });

  it('defaults omitted description and tags to an empty string and list', () => {
    expect(parse('')).toMatchObject({ description: '', tags: [] });
    expect(parse('description:\ntags:')).toMatchObject({ description: '', tags: [] });
  });

  it.each(['title', 'date'])('rejects a missing or empty required %s', (key) => {
    for (const replacement of ['', `${key}:`, `${key}: ""`]) {
      const raw = article().replace(new RegExp(`^${key}:.*$`, 'm'), replacement);
      expect(() => parseFrontmatter('required.md', raw)).toThrow('文章 required 需要 title 和有效的 YYYY-MM-DD date');
    }
  });

  it('reports missing or unterminated frontmatter with the derived slug', () => {
    for (const raw of ['# Plain Markdown', '', '---\ntitle: Missing closing delimiter']) {
      expect(() => parseFrontmatter('/content/blog/no-frontmatter.md', raw)).toThrow('文章 no-frontmatter 缺少 frontmatter');
    }
  });

  it('derives the slug from the Markdown filename and preserves the body', () => {
    expect(parseFrontmatter('/content/blog/my-first-post.md', `${article()}\n\n## Heading\n\n\`\`\`ts\nconst n = 1\n\`\`\``)).toMatchObject({
      slug: 'my-first-post', body: '正文\n\n## Heading\n\n```ts\nconst n = 1\n```',
    });
    expect(parseFrontmatter('relative-post.md', article()).slug).toBe('relative-post');
  });

  it.each([[0, 1], [1, 1], [200, 1], [201, 2], [400, 2], [401, 3]])(
    'estimates %i English words as %i reading minutes with a one-minute minimum', (count, minutes) => {
      expect(parseFrontmatter('words.md', article().replace('正文', 'word '.repeat(count))).readingMinutes).toBe(minutes);
    },
  );

  it('counts Chinese characters and English words together without counting metadata', () => {
    const raw = article('description: ' + 'metadata '.repeat(500)).replace('正文', '文'.repeat(200) + ' English');
    expect(parseFrontmatter('mixed.md', raw).readingMinutes).toBe(2);
  });

  it.each([
    'unrecognized line',
    'author: Someone',
    '  title: nested field',
    'description: first line\n  continuation: silently ignored before',
    'description: |\n  multiline text',
    'description: >',
    '  - orphan tag',
    'tags: [inline]\n  - unexpected continuation',
    'tags:\n  - nested: mapping',
    'tags:\n  - [nested, list]',
    'tags:\n  - ',
    'tags:\n  - ""',
    'tags:\n  - "a,b"',
    'tags: []\ntags: []',
    'tags: [a, "unclosed]',
    'tags: [a, {nested: value}]',
    'tags: ["a,b"]',
    'tags: [a, ]',
    'description: "unclosed',
    'description: {nested: value}',
  ])('rejects unsupported frontmatter with the article name and line number: %s', (fields) => {
    expect(() => parse(fields)).toThrow(/文章 regression 的 frontmatter 第 \d+ 行不支持/);
  });

  it('supports a single scalar tag', () => {
    expect(parse('tags: Nuxt').tags).toEqual(['Nuxt']);
  });

  it('continues to reject missing titles and invalid dates', () => {
    expect(() => parseFrontmatter('regression.md', article().replace('title: "测试文章"', 'title:'))).toThrow('需要 title 和有效的 YYYY-MM-DD date');
    expect(() => parseFrontmatter('regression.md', article().replace('2026-11-19', '2026-02-30'))).toThrow('需要 title 和有效的 YYYY-MM-DD date');
  });
});

describe('nuxt-site article code styles', () => {
  const page = files['app/pages/blog/[slug].vue']!;
  const rule = (selector: string) => page.split(`${selector} {`)[1]?.split('}')[0];

  it('keeps block code light on dark while inline code has dark text on light', () => {
    expect(rule('.prose :deep(pre)')).toContain('background: #1f2937;');
    expect(rule('.prose :deep(pre)')).toContain('color: #f3f4f6;');
    expect(rule('.prose :deep(pre code)')).toContain('background: none;');
    expect(rule('.prose :deep(pre code)')).toContain('color: inherit;');
    expect(rule('.prose :deep(code)')).toContain('background: var(--color-bg-alt);');
    expect(rule('.prose :deep(code)')).toContain('color: var(--color-text);');
  });
});
