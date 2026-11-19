import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getProjectTemplate, isProjectTemplateId, renderProjectFiles, type ProjectFeature } from '@forgekit/project-core';
import { safeRelativePath } from './artifact-store';
import type { BuildRecord } from './runner';

export interface WorkspaceSource {
  prepare(build: BuildRecord, workspace: string, signal: AbortSignal): Promise<{
    script: 'build' | 'generate'; outputDirectory?: string;
  }>;
}
export type ProjectSourceLoader = (projectId: string) => Promise<{
  name: string; template: string; features: ProjectFeature[];
} | null>;

/** No uploaded project files/snapshot repository exists yet. Other sourceRef schemes fail closed. */
export class TemplateWorkspaceSource implements WorkspaceSource {
  constructor(private readonly loadProject: ProjectSourceLoader) {}
  async prepare(build: BuildRecord, workspace: string, signal: AbortSignal) {
    if (!isProjectTemplateId(build.template) || build.sourceRef !== `template:${build.template}`) {
      throw new Error('unsupported_build_source');
    }
    const project = await this.loadProject(build.projectId);
    if (!project || project.template !== build.template) throw new Error('build_source_mismatch');
    const metadata = getProjectTemplate(build.template)!;
    const files = renderProjectFiles({ name: project.name, template: build.template, features: project.features });
    for (const [relative, content] of Object.entries(files)) {
      signal.throwIfAborted();
      safeRelativePath(relative);
      const path = join(workspace, relative);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, content, { flag: 'wx', mode: 0o600 });
    }
    return metadata.build ?? { script: 'build' as const };
  }
}
