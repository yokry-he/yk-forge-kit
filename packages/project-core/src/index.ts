import { findProjectTemplate } from './registry.js';
import type { ProjectFeature, ProjectOptions } from './types.js';

export type {
  ProjectFeature, ProjectFeatureOption, ProjectKind, ProjectOptions, ProjectTarget, ProjectTemplateId, ProjectTemplateMetadata,
} from './types.js';
export { getProjectTemplate, isProjectTemplateId, listProjectTemplates } from './registry.js';

export interface ProjectPlan {
  options: ProjectOptions;
  files: string[];
  commands: string[];
}

export class ProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectValidationError';
  }
}

export function normalizeProjectOptions(input: ProjectOptions): ProjectOptions {
  if (typeof input.name !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.name) || input.name.length > 60) {
    throw new ProjectValidationError('项目名称须为 1–60 位的小写字母、数字及中划线，且以字母开头。');
  }
  const template = typeof input.template === 'string' ? findProjectTemplate(input.template) : undefined;
  if (!template) throw new ProjectValidationError('不支持的项目模板。');
  const allowed = template.features.map((feature) => feature.id);
  if (!Array.isArray(input.features) || input.features.some((feature) => !allowed.includes(feature))) {
    throw new ProjectValidationError(`包含 ${template.name} 模板不支持的项目能力。`);
  }
  const features: ProjectFeature[] = allowed.filter((feature) => input.features.includes(feature));
  return { name: input.name, template: template.id, features };
}

export function createProjectPlan(input: ProjectOptions): ProjectPlan {
  const options = normalizeProjectOptions(input);
  const template = findProjectTemplate(options.template)!;
  return {
    options,
    files: Object.keys(template.render(options)).sort(),
    commands: [`cd ${options.name}`, ...template.commands],
  };
}

/** Pure renderer. Path validation and disk writes belong to the CLI adapter. */
export function renderProjectFiles(input: ProjectOptions): Record<string, string> {
  const options = normalizeProjectOptions(input);
  return findProjectTemplate(options.template)!.render(options);
}
