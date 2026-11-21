import { createRouter, createWebHistory } from 'vue-router';
import BuildListPage from './views/BuildListPage.vue';
import BuildDetailPage from './views/BuildDetailPage.vue';
import ProjectCreateView from './views/ProjectCreateView.vue';
import AssetCatalogView from './views/AssetCatalogView.vue';
import ProjectListView from './views/ProjectListView.vue';
import ProjectDetailView from './views/ProjectDetailView.vue';
import AuthLoginView from './views/AuthLoginView.vue';
import AuthCallbackView from './views/AuthCallbackView.vue';
import { authSession, oidcEnabled, restoreSession } from './auth/session';
import { requiresOidcProjectAccess } from './auth/return-path';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/projects' },
    { path: '/projects', component: ProjectListView },
    { path: '/projects/new', component: ProjectCreateView },
    { path: '/projects/:slug', name: 'project-detail', component: ProjectDetailView },
    { path: '/projects/:slug/runtime-logs', name: 'project-runtime-logs', component: () => import('./views/RuntimeLogsPage.vue') },
    { path: '/projects/:slug/variables', name: 'project-variables', component: () => import('./views/EnvironmentVariablesPage.vue') },
    { path: '/projects/:slug/domains/:operationId?', name: 'project-domains', component: () => import('./views/DomainsPage.vue') },
    { path: '/projects/:slug/deployments/:deploymentId?', name: 'project-deployments', component: () => import('./views/DeploymentsPage.vue') },
    { path: '/projects/:slug/builds', name: 'project-builds', component: BuildListPage },
    { path: '/projects/:slug/builds/:buildId', name: 'project-build', component: BuildDetailPage },
    { path: '/auth/login', component: AuthLoginView },
    { path: '/auth/callback', component: AuthCallbackView, props: { kind: 'login' } },
    { path: '/auth/logout-callback', component: AuthCallbackView, props: { kind: 'logout' } },
    { path: '/assets', component: AssetCatalogView },
    { path: '/:pathMatch(.*)*', redirect: '/projects' },
  ],
});

// In OIDC mode, project routes are protected before rendering. Public login/callback
// routes stay reachable so that the PKCE exchange cannot be trapped in a loop.
router.beforeEach(async (to) => {
  if (!oidcEnabled || !requiresOidcProjectAccess(to.path)) return true;
  try { await restoreSession(); }
  catch { return { path: '/auth/login', query: { returnTo: to.fullPath } }; }
  if (!authSession.value) return { path: '/auth/login', query: { returnTo: to.fullPath } };
  return true;
});
