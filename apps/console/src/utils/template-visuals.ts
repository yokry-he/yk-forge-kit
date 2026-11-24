import { getProjectTemplate, isProjectTemplateId, type ProjectTemplateId } from '@forgekit/project-core';

export interface TemplateVisual {
  id: string;
  label: string;
  shortName: string;
  icon: string;
  color: string;
  background: string;
}

// Console presentation only; official names and template capabilities remain in project-core.
const visuals = {
  'vue-web': { shortName: 'Vue Web', icon: 'V', color: '#6ee7b7', background: '#163a37' },
  'vue-admin': { shortName: 'Vue 后台', icon: '▦', color: '#c4b5fd', background: '#38224f' },
  'nuxt-site': { shortName: 'Nuxt', icon: '△', color: '#a3e635', background: '#25351b' },
  uniapp: { shortName: 'uni-app', icon: 'U', color: '#67e8f9', background: '#16333e' },
  'tauri-desktop': { shortName: 'Tauri', icon: '◈', color: '#fcd34d', background: '#3c301b' },
} satisfies Record<ProjectTemplateId, Omit<TemplateVisual, 'id' | 'label'>>;

export function getTemplateVisual(id: string): TemplateVisual {
  if (!isProjectTemplateId(id)) {
    return { id, label: id, shortName: id, icon: '◇', color: '#d4d4d8', background: '#27272a' };
  }
  return { id, label: getProjectTemplate(id)!.name, ...visuals[id] };
}
