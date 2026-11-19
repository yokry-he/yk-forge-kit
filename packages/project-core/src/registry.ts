import type { ProjectFeatureOption, ProjectTemplateDefinition, ProjectTemplateId, ProjectTemplateMetadata } from './types.js';
import { renderVueWeb } from './vue-web.js';

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
    render: renderVueWeb,
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
