import { beginnerDefaults, beginnerPlatforms, type BeginnerPlatform, type BeginnerResult, type BeginnerSuggestion, type BeginnerTemplate } from '@forgekit/contracts';

/** Priority order, never additive. Kept in sync with beginner-mode-catalog.md. */
const rules: Array<{ id: BeginnerTemplate; words: string[] }> = [
  { id: 'tauri-desktop', words: ['桌面', '电脑客户端', '本地应用', 'windows', 'macos', 'linux', 'tauri', 'desktop', 'local app', 'native desktop'] },
  { id: 'uniapp', words: ['小程序', '跨端', '多端', 'uniapp', 'uni-app', '移动端', '移动应用', '安卓', 'android', '手机应用', 'app', 'h5', 'mini program', 'weapp', 'mobile app', 'phone app', 'cross-platform', 'multi-platform'] },
  { id: 'vue-admin', words: ['后台', '管理系统', '控制台', '管理端', '权限', '角色', '表格', 'crud', '增删改查', '仪表盘', '内部系统', 'admin', 'dashboard', 'management system', 'backend', 'backoffice', 'role', 'permission', 'table', 'console'] },
  { id: 'nuxt-site', words: ['官网', '企业站', '公司网站', '品牌站', '博客', '内容站', '新闻', '文章', 'seo', '营销站', '门户', '公司介绍', '产品介绍', '静态站', 'ssr', 'ssg', 'corporate website', 'company site', 'brand site', 'blog', 'content site', 'news', 'articles', 'marketing site', 'portal', 'company profile', 'product introduction', 'static site'] },
  { id: 'vue-web', words: ['网站', '网页', 'web', '单页应用', 'spa', '前端项目', '首页', '落地页', 'landing', 'demo', '工具', '页面', 'h5', 'vue项目', 'website', 'single page app', 'single-page', 'frontend project', 'homepage', 'tool', 'page', 'vue project'] },
];
const names: Record<BeginnerTemplate, string> = { 'vue-web': 'web-app', 'vue-admin': 'admin-app', 'nuxt-site': 'site-app', uniapp: 'uni-app', 'tauri-desktop': 'desktop-app' };
const negation = /(?:不是|不要|不需要|无需|不用|别|排除|非|拒绝|\bnot\b|\bno\b|\bdon't\b|\bdo not\b|\bwithout\b|\bexclude\b|\bexcluding\b)[^，。！？,.;!?]{0,4}$/u;
// Small, explicit normalization of catalog vocabulary; no NLP/runtime dependency.
export function normalizeNeed(value: string): string {
  const traditional: Record<string, string> = { 後: '后', 臺: '台', 網: '网', 頁: '页', 程: '程', 式: '式', 應: '应', 體: '体', 軟: '软', 端: '端', 機: '机', 動: '动', 訊: '讯', 聞: '闻', 權: '权', 儀: '仪', 錶: '表', 圖: '图', 記: '记', 腦: '脑', 離: '离', 線: '线', 寫: '写', 階: '阶', 跨: '跨' };
  return value.replace(/(?:ignore (?:all |previous |above )*instructions|忽略(?:以上|之前|所有)?规则|(?:reveal|output) (?:secret|api|system)[^，。！？,.;!?:]*|输出密钥|system prompt)[^，。！？,.;!?:]*/gi, ' ').normalize('NFKC').toLowerCase().replace(/[後臺網頁程式應體軟端機動訊聞權儀錶圖記腦離線寫階跨]/g, char => traditional[char]!)
    .replace(/[^\p{L}\p{N}\s'\-，。！？,.;!?]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function occurrences(text: string, word: string): number[] {
  const indexes: number[] = [];
  for (let pos = text.indexOf(word); pos !== -1; pos = text.indexOf(word, pos + 1)) {
    // English words must not accidentally match happy, applicable, stable, etc.
    if (/^[a-z]/.test(word) && /[a-z0-9]/.test(text[pos - 1] ?? '')) continue;
    if (/[a-z]$/.test(word) && /[a-z0-9]/.test(text[pos + word.length] ?? '')) continue;
    indexes.push(pos);
  }
  return indexes;
}
function hit(text: string, words: string[]): boolean {
  return words.some(word => occurrences(text, word).some(pos => !negation.test(text.slice(0, pos))));
}
export function compatibleSuggestion(input: BeginnerSuggestion, description = ''): BeginnerSuggestion & { warnings: string[] } {
  const platforms = [...new Set(input.platforms)].filter(platform => beginnerPlatforms[input.templateId].includes(platform));
  const corrected = platforms.length !== input.platforms.length;
  return { ...input, name: suggestName(input.name, input.templateId, description), platforms: platforms.length ? platforms : [...beginnerDefaults[input.templateId]],
    ...(corrected ? { lowConfidence: true } : {}), warnings: corrected ? ['已移除重复或不兼容的平台，把握不大，请确认。'] : [] };
}
export function classifyKeywords(description: string): BeginnerResult {
  // Remove secrets before normalization/tokenization can split or truncate them.
  const text = normalizeNeed(redactNameSecrets(description)).replace(/\b(?:web|single[- ]page) app(?:lication)?\b/g, 'web');
  const candidates = rules.filter(rule => {
    // A negated keyword excludes the whole template, including its synonyms.
    const excluded = rule.words.some(word => occurrences(text, word).some(pos => negation.test(text.slice(0, pos))));
    return !excluded && hit(text, rule.words);
  });
  const templateId = candidates[0]?.id ?? 'vue-web';
  const signals: BeginnerPlatform[] = [];
  if (hit(text, ['web', '网站', '网页', 'h5', 'spa', '官网', '博客', '内容站', '首页', '落地页'])) signals.push('web');
  const concrete: BeginnerPlatform[] = [];
  // Generic 小程序 is WeChat only when it is not the suffix of 支付宝小程序.
  const withoutAlipay = text.replace(/支付宝小程序/g, ' ').replace(/alipay mini program/g, ' ');
  if (hit(withoutAlipay, ['小程序', 'mini program', 'wechat', 'weapp'])) concrete.push('weapp');
  if (hit(text, ['支付宝', 'alipay'])) concrete.push('alipay');
  if (hit(text, ['安卓', 'android', '手机应用', '移动端'])) concrete.push('android');
  const cross = hit(text, ['uniapp', 'uni-app', '跨端', '多端', 'cross-platform', 'multi-platform']);
  if (cross && (signals.length || concrete.length)) signals.push('uniapp');
  signals.push(...concrete);
  if (hit(text, ['桌面', '电脑客户端', '本地应用', 'windows', 'macos', 'linux', 'tauri', 'desktop', 'local app'])) signals.push('tauri-desktop');
  const compatible = compatibleSuggestion({ templateId, name: suggestName(text, templateId),
    platforms: signals.length ? signals : [...beginnerDefaults[templateId]] });
  const lowConfidence = candidates.length === 0 || compatible.lowConfidence || /不是不|不要不|not\s+without|don't\s+exclude/.test(text);
  return { ...compatible, source: 'keywords', lowConfidence: !!lowConfidence,
    warnings: [...compatible.warnings, ...(lowConfidence ? ['把握不大，请确认模板、名称和平台。'] : [])] };
}
function redactNameSecrets(value: string, secrets: string[] = []): string {
  const remove = (match: string) => {
    const secret = match.replace(/\.+$/, '');
    secrets.push(secret, ...secret.split(/\s+/));
    // Preserve sentence boundaries used by the existing injection normalizer.
    return match.endsWith('.') ? ' . ' : ' ';
  };
  return value.normalize('NFKC')
    .replace(/-----BEGIN [^-\r\n]+-----[\s\S]*?(?:-----END [^-\r\n]+-----|$)/gi, remove)
    .replace(/\b(?:bearer|api[-_ ]?key|access[-_ ]?token)(?:\s*[:=]\s*|\s+)["']?([a-z0-9_+/.=-]+)|\bsecret\s*[:=]\s*["']?([a-z0-9_+/.=-]+)/gi, (match, labelled: string | undefined, secret: string | undefined) => {
      secrets.push((labelled ?? secret ?? '').replace(/\.+$/, ''));
      return remove(match);
    })
    .replace(/[a-z0-9_+/.=-]+/gi, token => {
      const sensitive = /(?:^|[^a-z0-9])(?:sk|pk|ghp|gho|github_pat|xox[baprs])[-_]|^AKIA[A-Z0-9]{12,}|^eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.|bearer|(?:begin|end)[-_](?:rsa[-_]|ec[-_]|openssh[-_])?(?:private|public)[-_]key|[a-f0-9]{16,}|[a-z0-9_+/=]{24,}/i.test(token);
      return sensitive ? remove(token) : token;
    });
}
function suggestName(text: string, template: BeginnerTemplate, description = ''): string {
  const secrets: string[] = [];
  redactNameSecrets(description, secrets);
  // Also reject an AI echo of a short Bearer/labelled/PEM secret, even if the model
  // drops its marker or changes case/punctuation to turn it into a valid slug.
  const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (secrets.some(secret => {
    const token = secret.toLowerCase().replace(/[^a-z0-9]/g, '');
    return token.length >= 4 && normalized.includes(token);
  })) return names[template];
  // Chinese uses a stable ASCII default. English tokens give an editable, safe suggestion.
  const words = redactNameSecrets(text).toLowerCase().match(/[a-z][a-z0-9]*/g) ?? [];
  const slug = words.join('-').slice(0, 60).replace(/-+$/g, '');
  return slug || names[template];
}
