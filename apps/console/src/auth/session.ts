import { readonly, ref } from 'vue';
import { UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { parseFrontendAuthConfig } from './config';
import { returnPathFromOidcState, safeProjectReturnPath } from './return-path';

export interface PublicSession { subject: string; displayName: string; expiresAt: number | null }

const config = parseFrontendAuthConfig(import.meta.env);
const session = ref<PublicSession | null>(null);
const busy = ref(false);
let manager: UserManager | null = null;
let restoreInFlight: Promise<void> | null = null;

export const authSession = readonly(session);
export const authBusy = readonly(busy);
export const oidcEnabled = config.mode === 'oidc';

function getManager(): UserManager {
  if (config.mode !== 'oidc') throw new Error('当前处于本机开发模式，未配置 OIDC 登录。');
  if (config.allowHttpLoopback && !['127.0.0.1', 'localhost'].includes(window.location.hostname)) {
    throw new Error('HTTP OIDC 开发模式只能在本机回环地址使用。');
  }
  if (!manager) {
    const origin = window.location.origin;
    manager = new UserManager({
      authority: config.authority,
      client_id: config.clientId,
      redirect_uri: `${origin}/auth/callback`,
      post_logout_redirect_uri: `${origin}/auth/logout-callback`,
      response_type: 'code',
      scope: 'openid profile',
      loadUserInfo: false,
      automaticSilentRenew: false,
      userStore: new WebStorageStateStore({ store: window.sessionStorage }),
      stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
      ...(config.resource ? { extraQueryParams: { resource: config.resource } } : {}),
    });
    manager.events.addUserLoaded((user) => {
      session.value = user.expired ? null : {
        subject: user.profile.sub,
        displayName: typeof user.profile.name === 'string' ? user.profile.name : user.profile.sub,
        expiresAt: user.expires_at ?? null,
      };
    });
    manager.events.addUserUnloaded(() => { session.value = null; });
    manager.events.addUserSignedOut(() => { session.value = null; });
    manager.events.addAccessTokenExpired(() => { session.value = null; });
  }
  return manager;
}

export function restoreSession(): Promise<void> {
  if (config.mode !== 'oidc') return Promise.resolve();
  if (restoreInFlight) return restoreInFlight;
  busy.value = true;
  const work = Promise.resolve().then(() => getManager().getUser()).then((user) => {
    session.value = user && !user.expired ? {
      subject: user.profile.sub,
      displayName: typeof user.profile.name === 'string' ? user.profile.name : user.profile.sub,
      expiresAt: user.expires_at ?? null,
    } : null;
  }).finally(() => { busy.value = false; restoreInFlight = null; });
  restoreInFlight = work;
  return work;
}

export async function startSignIn(returnTo?: string): Promise<void> {
  await getManager().signinRedirect({ state: { returnTo: safeProjectReturnPath(returnTo) } });
}

export async function finishSignIn(): Promise<string> {
  const user = await getManager().signinRedirectCallback();
  await restoreSession();
  return returnPathFromOidcState(user.state);
}

export async function startSignOut(): Promise<void> {
  await getManager().signoutRedirect();
}

export async function finishSignOut(): Promise<void> {
  await getManager().signoutRedirectCallback();
  await getManager().removeUser();
  session.value = null;
}

/** Tokens are never copied to global reactive state or logged. */
export async function getAccessToken(): Promise<string | null> {
  if (config.mode !== 'oidc') return null;
  const user = await getManager().getUser();
  if (!user || user.expired || !user.access_token) {
    session.value = null;
    return null;
  }
  return user.access_token;
}
