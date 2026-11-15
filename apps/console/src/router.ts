import { createRouter, createWebHistory } from 'vue-router';
import ProjectCreateView from './views/ProjectCreateView.vue';
import AssetCatalogView from './views/AssetCatalogView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/projects/new' },
    { path: '/projects/new', component: ProjectCreateView },
    { path: '/assets', component: AssetCatalogView },
    { path: '/:pathMatch(.*)*', redirect: '/projects/new' },
  ],
});
