// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Public OAuth identity used by the original compatibility integration, not a secret.
// Source and reuse considerations: https://github.com/microsoft/AzureStorageExplorer/issues/8995
export const DEFAULT_COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
export const COPILOT_CREDENTIALS_KEY = 'webmcp-explorer-copilot-credentials';
const SESSION_KEY = 'webmcp-explorer-copilot-session';
const AUTH_EPOCH_KEY = 'webmcp-explorer-copilot-auth-epoch';
const AUTH_LOCK = 'webmcp-explorer-copilot-auth';
const REFRESH_MARGIN_MS = 60_000;
const API_ORIGINS = [
  'https://api.githubcopilot.com',
  'https://api.individual.githubcopilot.com',
  'https://api.business.githubcopilot.com',
  'https://api.enterprise.githubcopilot.com',
];

export const COPILOT_HOST_PERMISSIONS = [
  'https://github.com/*',
  'https://api.github.com/*',
  ...API_ORIGINS.map((origin) => `${origin}/*`),
];

export function copilotHeaders(): Record<string, string> {
  return {
    'Editor-Version': 'vscode/1.104.1',
    'Editor-Plugin-Version': `webmcp-explorer/${chrome.runtime.getManifest().version}`,
    'Copilot-Integration-Id': 'vscode-chat',
    'Openai-Intent': 'conversation-edits',
  };
}

interface GitHubCredentials {
  clientId: string;
  signInId: string;
  accessToken: string;
  expiresAt?: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
}

export interface CopilotSession {
  token: string;
  expiresAt: number;
  baseUrl: string;
}

class GitHubHttpError extends Error {
  constructor(public status: number) {
    super(status === 401
      ? 'GitHub authentication expired or was revoked. Please sign in again.'
      : status === 403
        ? 'GitHub denied access. Check your Copilot subscription and organization policies.'
        : `GitHub Copilot request failed (HTTP ${status}). Please try again.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`GitHub returned an invalid ${key}.`);
  return value.trim();
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function copilotClientId(value?: string): string {
  const clientId = value?.trim() || DEFAULT_COPILOT_CLIENT_ID;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(clientId)) throw new Error('Invalid GitHub OAuth client ID.');
  return clientId;
}

async function prepareStorage(): Promise<void> {
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  // Do not keep persistent GitHub credentials left by the earlier branch.
  await chrome.storage.local.remove(COPILOT_CREDENTIALS_KEY);
}

async function requestJson(
  url: string,
  init: RequestInit,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch(url, {
    ...init,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new GitHubHttpError(response.status);
  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('GitHub returned invalid JSON.');
    throw error;
  }
  if (!isRecord(data)) throw new Error('GitHub returned an invalid response.');
  return data;
}

function oauthRequest(clientId: string, path: string, fields: Record<string, string>, signal?: AbortSignal) {
  return requestJson(`https://github.com/login/${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, ...fields }).toString(),
  }, signal);
}

async function loadCredentials(): Promise<GitHubCredentials | null> {
  await prepareStorage();
  const stored = (await chrome.storage.session.get(COPILOT_CREDENTIALS_KEY))[COPILOT_CREDENTIALS_KEY];
  if (stored === undefined) return null;
  if (!isRecord(stored) || typeof stored.clientId !== 'string' || !stored.clientId.trim()
    || typeof stored.signInId !== 'string' || !stored.signInId
    || typeof stored.accessToken !== 'string' || !stored.accessToken.trim()
    || (stored.expiresAt !== undefined && !positiveNumber(stored.expiresAt))
    || (stored.refreshToken !== undefined && (typeof stored.refreshToken !== 'string' || !stored.refreshToken))
    || (stored.refreshExpiresAt !== undefined && !positiveNumber(stored.refreshExpiresAt))) {
    throw new Error('Saved GitHub credentials are invalid. Sign out and sign in again.');
  }
  return {
    clientId: copilotClientId(stored.clientId), signInId: stored.signInId, accessToken: stored.accessToken,
    expiresAt: stored.expiresAt, refreshToken: stored.refreshToken, refreshExpiresAt: stored.refreshExpiresAt,
  };
}

function lifetime(data: Record<string, unknown>, key: string): number | undefined {
  if (data[key] === undefined) return undefined;
  const seconds = data[key];
  if (!positiveNumber(seconds) || seconds > 10 * 365 * 24 * 60 * 60) {
    throw new Error('GitHub returned an invalid token lifetime.');
  }
  return Date.now() + seconds * 1000;
}

function parseCredentials(clientId: string, data: Record<string, unknown>, signInId: string = crypto.randomUUID()): GitHubCredentials {
  const accessToken = requiredString(data, 'access_token');
  if (data.token_type !== undefined && (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer')) {
    throw new Error('GitHub returned an unsupported token type.');
  }
  if (data.refresh_token !== undefined && (typeof data.refresh_token !== 'string' || !data.refresh_token.trim())) {
    throw new Error('GitHub returned an invalid refresh token.');
  }
  return {
    clientId, signInId, accessToken, expiresAt: lifetime(data, 'expires_in'),
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    refreshExpiresAt: lifetime(data, 'refresh_token_expires_in'),
  };
}

function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function isCopilotSignedIn(clientId: string): Promise<boolean> {
  const credentials = await loadCredentials();
  return credentials !== null && credentials.clientId === clientId
    && (credentials.expiresAt === undefined || credentials.expiresAt > Date.now()
      || (credentials.refreshToken !== undefined
        && (credentials.refreshExpiresAt === undefined || credentials.refreshExpiresAt > Date.now())));
}

export async function signInToCopilot(
  clientId: string,
  onDeviceCode: (code: string, verificationUrl: string) => void,
  signal: AbortSignal
): Promise<void> {
  await navigator.locks.request(`${AUTH_LOCK}-sign-in`, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('GitHub sign-in is already running in another panel.');
    signal.throwIfAborted();
    await prepareStorage();
    const epoch = (await chrome.storage.session.get(AUTH_EPOCH_KEY))[AUTH_EPOCH_KEY];
    const device = await oauthRequest(clientId, 'device/code', { scope: 'read:user' }, signal);
    const deviceCode = requiredString(device, 'device_code');
    const userCode = requiredString(device, 'user_code');
    const verificationUrl = new URL(requiredString(device, 'verification_uri'));
    if (verificationUrl.href !== 'https://github.com/login/device') {
      throw new Error('GitHub returned an unexpected device verification URL.');
    }
    if (!positiveNumber(device.expires_in) || !Number.isSafeInteger(device.expires_in) || device.expires_in > 3600
      || (device.interval !== undefined && (!positiveNumber(device.interval) || !Number.isSafeInteger(device.interval) || device.interval > 60))) {
      throw new Error('GitHub returned an invalid device lifetime or polling interval.');
    }
    const deadline = Date.now() + device.expires_in * 1000;
    const pollingSignal = AbortSignal.any([signal, AbortSignal.timeout(device.expires_in * 1000)]);
    let interval = positiveNumber(device.interval) ? device.interval * 1000 : 5000;
    onDeviceCode(userCode, verificationUrl.href);
    while (Date.now() < deadline) {
      await waitForPoll(interval, pollingSignal);
      if (Date.now() >= deadline) break;
      const result = await oauthRequest(clientId, 'oauth/access_token', {
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }, pollingSignal);
      if (result.access_token) {
        const credentials = parseCredentials(clientId, result);
        await navigator.locks.request(AUTH_LOCK, { signal: pollingSignal }, async () => {
          const currentEpoch = (await chrome.storage.session.get(AUTH_EPOCH_KEY))[AUTH_EPOCH_KEY];
          if (currentEpoch !== epoch) throw new Error('GitHub sign-in was superseded by sign-out. Please try again.');
          pollingSignal.throwIfAborted();
          await chrome.storage.session.remove(SESSION_KEY);
          await chrome.storage.session.set({ [COPILOT_CREDENTIALS_KEY]: credentials });
          if (pollingSignal.aborted) {
            await chrome.storage.session.remove(COPILOT_CREDENTIALS_KEY);
            pollingSignal.throwIfAborted();
          }
        });
        return;
      }
      switch (result.error) {
        case 'authorization_pending': break;
        case 'slow_down':
          if (result.interval !== undefined
            && (!positiveNumber(result.interval) || !Number.isSafeInteger(result.interval) || result.interval > 3600)) {
            throw new Error('GitHub returned an invalid polling interval.');
          }
          interval = Math.max(interval + 5000, positiveNumber(result.interval) ? result.interval * 1000 : 0);
          break;
        case 'access_denied': throw new Error('GitHub sign-in was denied. You can try again.');
        case 'expired_token': throw new Error('GitHub device code expired. Please sign in again.');
        default: throw new Error('GitHub device authorization failed. Please try signing in again.');
      }
    }
    throw new Error('GitHub device code expired. Please sign in again.');
  });
}

export async function signOutOfCopilot(): Promise<void> {
  await navigator.locks.request(AUTH_LOCK, async () => {
    await prepareStorage();
    await chrome.storage.session.set({ [AUTH_EPOCH_KEY]: crypto.randomUUID() });
    await chrome.storage.session.remove([SESSION_KEY, COPILOT_CREDENTIALS_KEY]);
  });
}

function validateApiUrl(value: string): string {
  const url = new URL(value);
  if (!API_ORIGINS.includes(url.origin) || url.username || url.password
    || url.port || url.search || url.hash || url.pathname !== '/') {
    throw new Error('GitHub returned an unsupported Copilot API endpoint.');
  }
  return url.origin;
}

async function exchangeToken(accessToken: string, signal?: AbortSignal): Promise<CopilotSession> {
  const data = await requestJson('https://api.github.com/copilot_internal/v2/token', {
    headers: { ...copilotHeaders(), Accept: 'application/json', Authorization: `token ${accessToken}` },
  }, signal);
  const token = requiredString(data, 'token');
  if (!positiveNumber(data.expires_at) || data.expires_at * 1000 <= Date.now()) {
    throw new Error('GitHub returned an invalid Copilot token expiration.');
  }
  let baseUrl: string;
  if (isRecord(data.endpoints) && typeof data.endpoints.api === 'string') {
    baseUrl = validateApiUrl(data.endpoints.api);
  } else {
    if (data.endpoints !== undefined && (!isRecord(data.endpoints) || data.endpoints.api !== undefined)) {
      throw new Error('GitHub returned invalid Copilot API endpoints.');
    }
    const proxyEndpoint = token.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/)?.[1];
    if (!proxyEndpoint) throw new Error('GitHub did not return a Copilot API endpoint.');
    baseUrl = validateApiUrl(`https://${proxyEndpoint.replace(/^https:\/\//, '').replace(/^proxy\./, 'api.')}`);
  }
  return { token, expiresAt: data.expires_at * 1000, baseUrl };
}

export async function invalidateCopilotSession(token: string): Promise<void> {
  await navigator.locks.request(AUTH_LOCK, async () => {
    const stored = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
    if (isRecord(stored) && stored.token === token) await chrome.storage.session.remove(SESSION_KEY);
  });
}

export async function getCopilotSession(clientId: string, signal?: AbortSignal): Promise<CopilotSession> {
  return navigator.locks.request(AUTH_LOCK, { signal }, async () => {
    let credentials = await loadCredentials();
    if (!credentials || credentials.clientId !== clientId) throw new Error('Sign in to GitHub Copilot in Config first.');
    try {
      if (credentials.expiresAt !== undefined && credentials.expiresAt <= Date.now() + REFRESH_MARGIN_MS) {
        if (!credentials.refreshToken
          || (credentials.refreshExpiresAt !== undefined && credentials.refreshExpiresAt <= Date.now())) {
          throw new Error('GitHub authentication expired. Please sign out and sign in again in Config.');
        }
        const result = await oauthRequest(clientId, 'oauth/access_token', {
          grant_type: 'refresh_token', refresh_token: credentials.refreshToken,
        }, signal);
        if (result.error) {
          await chrome.storage.session.remove([SESSION_KEY, COPILOT_CREDENTIALS_KEY]);
          throw new Error('GitHub token renewal failed. Please sign in again in Config.');
        }
        credentials = parseCredentials(clientId, result, credentials.signInId);
        await chrome.storage.session.remove(SESSION_KEY);
        await chrome.storage.session.set({ [COPILOT_CREDENTIALS_KEY]: credentials });
      }
      const stored = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
      if (isRecord(stored) && stored.clientId === clientId && typeof stored.token === 'string' && stored.token
        && positiveNumber(stored.expiresAt) && stored.expiresAt > Date.now() + REFRESH_MARGIN_MS
        && typeof stored.baseUrl === 'string') {
        return { token: stored.token, expiresAt: stored.expiresAt, baseUrl: validateApiUrl(stored.baseUrl) };
      }
      const session = await exchangeToken(credentials.accessToken, signal);
      signal?.throwIfAborted();
      await chrome.storage.session.set({ [SESSION_KEY]: { ...session, clientId } });
      return session;
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 401) {
        await chrome.storage.session.remove([SESSION_KEY, COPILOT_CREDENTIALS_KEY]);
      }
      throw error;
    }
  });
}
