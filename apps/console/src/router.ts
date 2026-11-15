import { createRouter, createWebHistory } from 'vue-router';
import ProjectCreateView from './views/ProjectCreateView.vue';
import AssetCatalogView from './views/AssetCatalogView.vue';
import ProjectListView from './views/ProjectListView.vue';
import ProjectDetailView from './views/ProjectDetailView.vue';
import AuthLoginView from './views/AuthLoginView.vue';
import AuthCallbackView from './views/AuthCallbackView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/projects' },
    { path: '/projects', component: ProjectListView },
    { path: '/projects/new', component: ProjectCreateView },
    { path: '/projects/:slug', component: ProjectDetailView },
    { path: '/auth/login', component: AuthLoginView },
    { path: '/auth/callback', component: AuthCallbackView, props: { kind: 'login' } },
    { path: '/auth/logout-callback', component: AuthCallbackView, props: { kind: 'logout' } },
    { path: '/assets', component: AssetCatalogView },
    { path: '/:pathMatch(.*)*', redirect: '/projects' },
  ],
});
