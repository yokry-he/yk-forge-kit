/** Capabilities a template may offer. A template declares which of them it supports. */
export type ProjectFeature = 'theme' | 'router' | 'pinia';

/** Registered template IDs. Add an ID here together with its definition in the registry. */
export type ProjectTemplateId = 'vue-web' | 'vue-admin' | 'nuxt-site';

/** Delivery targets, aligned with the `targets` field in @forgekit/contracts. */
export type ProjectTarget = 'web' | 'h5' | 'mobile' | 'miniapp' | 'desktop';

/** What kind of product the template is meant for (used for grouping in wizards and docs). */
export type ProjectKind = 'web-app' | 'admin' | 'content-site' | 'full-stack' | 'miniapp' | 'mobile' | 'desktop';

export interface ProjectOptions {
  name: string;
  template: ProjectTemplateId;
  features: ProjectFeature[];
}

export interface ProjectFeatureOption {
  id: ProjectFeature;
  label: string;
  detail: string;
}

/** Serializable template metadata; safe to send to UIs and the API. */
export interface ProjectTemplateMetadata {
  id: ProjectTemplateId;
  name: string;
  description: string;
  kind: ProjectKind;
  targets: ProjectTarget[];
  /** Human-readable stack, e.g. ['Vue 3', 'TypeScript', 'Vite']. */
  stack: string[];
  /** Optional capabilities the user may toggle, in canonical order. */
  features: ProjectFeatureOption[];
  defaultFeatures: ProjectFeature[];
  /** Capabilities that are always part of the generated project (not toggles). */
  builtIn: string[];
  /** Asset-core target used for compatible assets, or null if assets are not supported yet. */
  assetTarget: 'vue-web' | null;
  /** Commands shown after generation, relative to the project directory. */
  commands: string[];
}

export interface ProjectTemplateDefinition extends ProjectTemplateMetadata {
  /** Pure renderer: options are already normalized. Must not touch the file system. */
  render(options: ProjectOptions): Record<string, string>;
}
