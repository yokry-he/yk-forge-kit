import type { ProjectRecord } from '@forgekit/contracts';

export interface ProjectFeatureLink { route: string; label: string }

export function projectFeatureLinks(project: Pick<ProjectRecord, 'template' | 'platforms'>): ProjectFeatureLink[] {
  const links: ProjectFeatureLink[] = [];
  // Legacy/manual uni-app records have no platform selection and support all template targets.
  const platforms = project.platforms;
  const supports = (platform: 'web' | 'weapp' | 'alipay' | 'android') => !platforms?.length || platforms.includes(platform);
  const uniapp = project.template === 'uniapp';
  const web = ['vue-web', 'vue-admin', 'nuxt-site'].includes(project.template) || uniapp && supports('web');
  if (web) links.push({ route: 'project-deployments', label: '部署目标与历史' });
  if (uniapp && supports('android')) links.push({ route: 'project-android', label: 'Android 打包' });
  if (uniapp && supports('weapp')) links.push({ route: 'project-weapp', label: '微信上传与预览' });
  if (uniapp && supports('alipay')) links.push({ route: 'project-alipay', label: '支付宝上传与预览' });
  if (project.template === 'tauri-desktop') links.push({ route: 'project-desktop', label: '桌面打包' });
  links.push({ route: 'project-variables', label: '环境变量' }, { route: 'project-builds', label: '查看构建' });
  return links;
}
