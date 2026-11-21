import type { ProjectFeatureOption, ProjectTemplateDefinition, ProjectTemplateId, ProjectTemplateMetadata } from './types.js';
import { renderVueAdmin } from './vue-admin.js';
import { renderVueWeb } from './vue-web.js';
import { renderNuxtSite } from './nuxt-site.js';
import { renderUniapp } from './uniapp.js';
import { renderTauriDesktop } from './tauri-desktop.js';

const featureCatalog = {
  theme: { id: 'theme', label: '主题系统', detail: '深色视觉风格与语义设计变量（official.theme 资产）' },
  router: { id: 'router', label: '页面路由', detail: 'Vue Router 和首页路由' },
  pinia: { id: 'pinia', label: '状态管理', detail: 'Pinia 全局状态容器' },
} satisfies Record<string, ProjectFeatureOption>;

const templates: ProjectTemplateDefinition[] = [
  {
    id: 'vue-web',
    name: 'Vue Web 应用',
    description: '轻量的 Vue 3 单页应用，适合工具站、小型应用和原型。',
    kind: 'web-app',
    targets: ['web'],
    stack: ['Vue 3', 'TypeScript', 'Vite'],
    features: [featureCatalog.theme, featureCatalog.router, featureCatalog.pinia],
    defaultFeatures: ['theme'],
    builtIn: [],
    assetTarget: 'vue-web',
    commands: ['pnpm install', 'pnpm dev'],
    build: { script: 'build', outputDirectory: 'dist' },
    render: renderVueWeb,
  },
  {
    id: 'vue-admin',
    name: 'Vue 后台管理系统',
    description: '基于 Element Plus 的响应式后台：登录与路由守卫、侧边栏布局、仪表盘、用户管理增删改查、系统设置、暗色模式；接口为可替换的模拟数据。',
    kind: 'admin',
    targets: ['web'],
    stack: ['Vue 3', 'TypeScript', 'Vite', 'Element Plus', 'Pinia', 'Vue Router'],
    features: [],
    defaultFeatures: [],
    builtIn: ['Element Plus 组件库（中文语言包）', 'Vue Router 与登录守卫', 'Pinia 状态管理', '暗色模式', '移动端抽屉菜单', '模拟数据接口'],
    assetTarget: null,
    commands: ['pnpm install', 'pnpm dev'],
    build: { script: 'build', outputDirectory: 'dist' },
    render: renderVueAdmin,
  },
  {
    id: 'nuxt-site',
    name: 'Nuxt 企业官网 / 博客',
    description: '基于 Nuxt 4 的响应式内容站，支持 SSR / SSG、Markdown 博客、SEO 元信息、文章 JSON-LD 与站点地图。',
    kind: 'content-site',
    targets: ['web'],
    stack: ['Nuxt 4', 'Vue 3', 'TypeScript', 'marked'],
    features: [],
    defaultFeatures: [],
    builtIn: ['SSR / SSG', 'SEO 元信息与 canonical', '文章 JSON-LD', '含文章的 sitemap.xml', '响应式导航', 'Markdown 博客与标签筛选'],
    assetTarget: null,
    commands: ['pnpm install', 'pnpm dev'],
    build: { script: 'generate', outputDirectory: '.output/public' },
    render: renderNuxtSite,
  },
  {
    id: 'uniapp',
    name: 'uni-app 跨端应用',
    description: 'Vue 3 + TypeScript 多端起步工程，包含首页、列表与详情、个人页；支持 H5 与微信小程序构建，预配置 App 和支付宝小程序。',
    kind: 'miniapp',
    targets: ['h5', 'miniapp', 'mobile'],
    stack: ['Vue 3', 'TypeScript', 'Vite', 'uni-app'],
    features: [],
    defaultFeatures: [],
    builtIn: ['多端页面与 tabBar', '共享类型化 API', '内存 mock', '响应式布局'],
    assetTarget: null,
    commands: ['pnpm install', 'pnpm dev:h5', 'pnpm build:h5', 'pnpm dev:mp-weixin', 'pnpm build:mp-weixin', 'pnpm dev:mp-alipay', 'pnpm build:mp-alipay', 'pnpm dev:app', 'pnpm build:app'],
    build: { script: 'build', outputDirectory: 'dist/build/h5' },
    render: renderUniapp,
  },
  {
    id: 'tauri-desktop',
    name: 'Tauri 桌面应用',
    description: 'Tauri 2 + Vue 3 桌面起步工程，支持 Windows / macOS / Linux，包含侧边栏、设置页、受限 Rust IPC 与安装包构建工作流；托盘和自动更新默认关闭。',
    kind: 'desktop',
    targets: ['desktop'],
    stack: ['Tauri 2', 'Vue 3', 'TypeScript', 'Vite', 'Rust'],
    features: [],
    defaultFeatures: [],
    builtIn: ['主窗口与侧边栏', '本地设置', 'greet Rust 命令', '最小权限与 CSP', 'Windows / macOS 安装包工作流'],
    assetTarget: null,
    commands: ['pnpm install', 'pnpm tauri dev'],
    // Isolated platform workers build the frontend only; native bundles use the generated workflow.
    build: { script: 'build', outputDirectory: 'dist' },
    render: renderTauriDesktop,
  },
];

function toMetadata({ render: _render, ...metadata }: ProjectTemplateDefinition): ProjectTemplateMetadata {
  return JSON.parse(JSON.stringify(metadata)) as ProjectTemplateMetadata;
}

/** All registered templates, in display order. Returned objects are copies. */
export function listProjectTemplates(): ProjectTemplateMetadata[] {
  return templates.map(toMetadata);
}

export function isProjectTemplateId(value: unknown): value is ProjectTemplateId {
  return typeof value === 'string' && templates.some((template) => template.id === value);
}

/** Internal lookup including the renderer. */
export function findProjectTemplate(id: string): ProjectTemplateDefinition | undefined {
  return templates.find((template) => template.id === id);
}

export function getProjectTemplate(id: string): ProjectTemplateMetadata | undefined {
  const template = findProjectTemplate(id);
  return template ? toMetadata(template) : undefined;
}
