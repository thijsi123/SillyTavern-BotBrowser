// Auth Manager for BotBrowser
// Handles auth state, login, token storage, and favorites for live services.

import { proxiedFetch, PROXY_TYPES } from './corsProxy.js';

const SUPABASE_URL = 'https://ehgqxxoeyqsdgquzzond.supabase.co';
const HARPY_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVoZ3F4eG9leXFzZGdxdXp6b25kIiwicm9sZSI6ImFub24iLCJpYXQiOjE2OTI5NTM0ODUsImV4cCI6MjAwODUyOTQ4NX0.Cn-jDJqZFnwnhV9H6sBdRj8a3RA_XNWsBrApg4spOis';
const SAKURA_CLERK_BASE = 'https://clerk.sakura.fm';
const SAKURA_CLERK_VERSION = '5.66.1';
const JOYLAND_API_BASE = 'https://api.joyland.ai';
const WYVERN_FIREBASE_API_KEY = 'AIzaSyCqumrbjUy-EoMpfN4Ev0ppnqjkdpnOTTw';
const CHARAVAULT_AUTH_PROXY_CHAIN = [PROXY_TYPES.CORSPROXY_IO, PROXY_TYPES.CORS_LOL, PROXY_TYPES.PUTER];

function parseJsonSafely(text) {
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        return {};
    }
}

function getErrorMessage(payload, fallback = 'Request failed') {
    if (!payload || typeof payload !== 'object') return fallback;

    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim();
    if (typeof payload.error === 'string' && payload.error.trim()) return payload.error.trim();
    if (typeof payload.error_description === 'string' && payload.error_description.trim()) return payload.error_description.trim();
    if (typeof payload.detail === 'string' && payload.detail.trim()) return payload.detail.trim();

    const firstError = Array.isArray(payload.errors) ? payload.errors[0] : null;
    if (firstError && typeof firstError === 'object') {
        const parts = [
            firstError.long_message,
            firstError.message,
            firstError.code,
        ].filter((value) => typeof value === 'string' && value.trim());

        if (parts.length > 0) {
            return parts.join(' - ');
        }
    }

    return fallback;
}

function isJwtLike(value) {
    return typeof value === 'string' && value.split('.').length === 3;
}

function findJwtDeep(node, seen = new WeakSet()) {
    if (!node || typeof node !== 'object') return '';
    if (seen.has(node)) return '';
    seen.add(node);

    for (const value of Object.values(node)) {
        if (isJwtLike(value)) return value;
        if (value && typeof value === 'object') {
            const nested = findJwtDeep(value, seen);
            if (nested) return nested;
        }
    }

    return '';
}

function decodeJwtPayload(token) {
    if (!isJwtLike(token)) return null;
    try {
        const [, payload] = token.split('.');
        const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
        const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
        return JSON.parse(decoded);
    } catch {
        return null;
    }
}

function extractCharavaultToken(rawValue) {
    const normalized = String(rawValue || '').trim();
    if (!normalized) return '';
    const cookieMatch = normalized.match(/(?:^|;\s*)charavault_token=([^;]+)/i);
    return decodeURIComponent((cookieMatch?.[1] || normalized).trim());
}

function charavaultAuthFetch(url, { service = 'charavault', fetchOptions = {} } = {}) {
    return proxiedFetch(url, {
        service,
        proxyChain: CHARAVAULT_AUTH_PROXY_CHAIN,
        allowPublicAuth: true,
        fetchOptions,
    });
}

function getJoylandFingerprint() {
    try {
        const realFp = localStorage.getItem('fingerprint');
        if (realFp) return realFp;

        const key = 'bb_joyland_fp';
        let fp = localStorage.getItem(key);
        if (!fp) {
            fp = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            localStorage.setItem(key, fp);
        }
        return fp;
    } catch {
        return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
}

async function fetchSakuraClient() {
    const response = await fetch(`${SAKURA_CLERK_BASE}/v1/client?_clerk_js_version=${encodeURIComponent(SAKURA_CLERK_VERSION)}`, {
        method: 'GET',
        credentials: 'include',
        headers: {
            Accept: 'application/json',
        },
    });

    const text = await response.text().catch(() => '');
    const data = parseJsonSafely(text);
    if (!response.ok) {
        throw new Error(getErrorMessage(data, `Sakura client init failed (${response.status})`));
    }
    return data;
}

/**
 * In-memory auth state. Loaded from extension_settings at startup.
 */
export const authState = {
    saucepan: { token: null, userId: null, displayName: null },
    harpy:    { token: null, userId: null, displayName: null },
    charavault: { cookie: null, displayName: null },
    sakura:   { token: null, userId: null, displayName: null },
    crushon:  { cookie: null, userId: null, displayName: null },
};

// ─── Auth header helpers ───────────────────────────────────────────────────────

function ensureAuthMap() {
    if (!window.__BOT_BROWSER_AUTH_HEADERS) window.__BOT_BROWSER_AUTH_HEADERS = {};
}

function setServiceAuthHeader(service, headers) {
    ensureAuthMap();
    if (headers) {
        window.__BOT_BROWSER_AUTH_HEADERS[service] = headers;
    } else {
        delete window.__BOT_BROWSER_AUTH_HEADERS[service];
    }
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function isLoggedIn(service) {
    switch (service) {
        case 'saucepan':   return !!authState.saucepan.token;
        case 'harpy':      return !!authState.harpy.token;
        case 'charavault': return !!authState.charavault.cookie;
        case 'sakura':     return !!authState.sakura.token;
        case 'crushon':    return !!authState.crushon.cookie;
        default:           return false;
    }
}

export function getDisplayName(service) {
    const s = authState[service];
    return s ? (s.displayName || null) : null;
}

/**
 * Initialize all service auth from saved extension_settings.
 * Call this once in loadSettings().
 * @param {Object} settings - extension_settings[extensionName]
 * @param {Function} harpySetTokenFn - setHarpyUserToken from harpyApi.js
 */
export function initAuthFromSettings(settings, harpySetTokenFn) {
    ensureAuthMap();

    if (settings.saucepanToken) {
        authState.saucepan.token = settings.saucepanToken;
        authState.saucepan.displayName = settings.saucepanDisplayName || null;
        setServiceAuthHeader('saucepan', { Authorization: `Bearer ${settings.saucepanToken}` });
    }

    if (settings.harpyToken) {
        authState.harpy.token = settings.harpyToken;
        authState.harpy.userId = settings.harpyUserId || null;
        authState.harpy.displayName = settings.harpyDisplayName || null;
        if (harpySetTokenFn) harpySetTokenFn(settings.harpyToken);
    }

    if (settings.charavaultCookie) {
        authState.charavault.cookie = settings.charavaultCookie;
        authState.charavault.displayName = settings.charavaultDisplayName || null;
        const token = extractCharavaultToken(settings.charavaultCookie);
        const headers = token ? { Authorization: `Bearer ${token}` } : null;
        setServiceAuthHeader('charavault', headers);
        setServiceAuthHeader('charavault_favorites', headers);
        setServiceAuthHeader('charavault_lorebooks', headers);
    }

    if (settings.sakuraToken) {
        authState.sakura.token = settings.sakuraToken;
        authState.sakura.displayName = settings.sakuraDisplayName || null;
        setServiceAuthHeader('sakura', { Authorization: `Bearer ${settings.sakuraToken}` });
    }

    if (settings.crushonCookie) {
        authState.crushon.cookie = settings.crushonCookie;
        authState.crushon.displayName = settings.crushonDisplayName || null;
        setServiceAuthHeader('crushon', { Cookie: `next-auth.session-token=${settings.crushonCookie}` });
    }
}

/**
 * Apply a login result for a service.
 * Updates in-memory authState and global auth headers.
 */
export function applyServiceLogin(service, tokenOrCookie, extra = {}) {
    switch (service) {
        case 'saucepan':
            authState.saucepan.token = tokenOrCookie;
            authState.saucepan.displayName = extra.displayName || null;
            setServiceAuthHeader('saucepan', tokenOrCookie ? { Authorization: `Bearer ${tokenOrCookie}` } : null);
            break;
        case 'harpy':
            authState.harpy.token = tokenOrCookie;
            authState.harpy.userId = extra.userId || null;
            authState.harpy.displayName = extra.displayName || null;
            if (extra.harpySetTokenFn) extra.harpySetTokenFn(tokenOrCookie);
            break;
        case 'charavault':
            authState.charavault.cookie = tokenOrCookie;
            authState.charavault.displayName = extra.displayName || null;
            {
                const token = extractCharavaultToken(tokenOrCookie);
                const headers = token ? { Authorization: `Bearer ${token}` } : null;
                setServiceAuthHeader('charavault', headers);
                setServiceAuthHeader('charavault_favorites', headers);
                setServiceAuthHeader('charavault_lorebooks', headers);
            }
            break;
        case 'sakura':
            authState.sakura.token = tokenOrCookie;
            authState.sakura.displayName = extra.displayName || null;
            setServiceAuthHeader('sakura', tokenOrCookie ? { Authorization: `Bearer ${tokenOrCookie}` } : null);
            break;
        case 'crushon':
            authState.crushon.cookie = tokenOrCookie;
            authState.crushon.displayName = extra.displayName || null;
            setServiceAuthHeader('crushon', tokenOrCookie ? { Cookie: `next-auth.session-token=${tokenOrCookie}` } : null);
            break;
    }
}

/**
 * Clear auth for a service. Updates memory + headers + settings object.
 */
export function clearServiceAuth(service, settings) {
    applyServiceLogin(service, null);
    switch (service) {
        case 'saucepan':
            settings.saucepanToken = '';
            settings.saucepanDisplayName = '';
            break;
        case 'harpy':
            settings.harpyToken = '';
            settings.harpyUserId = '';
            settings.harpyDisplayName = '';
            if (settings._harpySetTokenFn) settings._harpySetTokenFn(null);
            break;
        case 'charavault':
            settings.charavaultCookie = '';
            settings.charavaultDisplayName = '';
            break;
        case 'sakura':
            settings.sakuraToken = '';
            settings.sakuraDisplayName = '';
            break;
        case 'crushon':
            settings.crushonCookie = '';
            settings.crushonDisplayName = '';
            break;
    }
}

// ─── Direct login (Saucepan + Harpy) ──────────────────────────────────────────

/**
 * Login to Saucepan.ai via handle/email + password.
 * Returns { token, displayName, handle, isVerified }
 */
export async function loginSaucepan(handleOrEmail, password) {
    const identity = String(handleOrEmail || '').trim();
    const secret = String(password || '');

    if (!identity || !secret) {
        throw new Error('Handle/email and password are required.');
    }

    const requestBodies = [];
    const pushBody = (body) => {
        const normalized = JSON.stringify(body);
        if (!requestBodies.some((entry) => JSON.stringify(entry) === normalized)) {
            requestBodies.push(body);
        }
    };

    pushBody({ user_or_email: identity, password: secret });
    pushBody({ handle: identity, password: secret });
    if (identity.includes('@')) {
        pushBody({ email: identity, password: secret });
    }

    let lastError = 'Login failed';

    for (const body of requestBodies) {
        const response = await fetch('https://api.saucepan.ai/api/v1/auth/sign_in_password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
        });

        const responseText = await response.text().catch(() => '');
        const data = parseJsonSafely(responseText);

        const token = data?.jwt || data?.token || data?.access_token || data?.accessToken || '';
        if (response.ok && token) {
            let displayName = identity;
            let handle = identity;
            let isVerified = false;

            try {
                const meResponse = await fetch('https://api.saucepan.ai/api/v1/users/me', {
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: 'application/json',
                    },
                });

                if (meResponse.ok) {
                    const meData = await meResponse.json().catch(() => ({}));
                    const me = meData?.user || meData || {};
                    displayName = me.display_name || me.displayName || me.handle || identity;
                    handle = me.handle || identity;
                    isVerified = Boolean(me.is_verified ?? me.verified);
                }
            } catch {}

            return { token, displayName, handle, isVerified };
        }

        lastError = getErrorMessage(data, responseText || `Login failed (${response.status})`);
    }

    throw new Error(lastError);
}

/**
 * Login to Harpy.chat via Supabase email + password.
 * Returns { token, userId, displayName }
 */
export async function loginHarpy(email, password) {
    const identity = String(email || '').trim();
    const secret = String(password || '');
    if (!identity || !secret) {
        throw new Error('Email and password are required.');
    }

    const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: HARPY_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: identity, password: secret })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
        throw new Error(getErrorMessage(data, `Login failed (${response.status})`));
    }
    return {
        token: data.access_token,
        userId: data.user?.id || null,
        displayName: data.user?.email || identity
    };
}

export async function loginSakura(identifier, password) {
    const identity = String(identifier || '').trim();
    const secret = String(password || '');

    if (!identity || !secret) {
        throw new Error('Username/email and password are required.');
    }

    await fetchSakuraClient();

    const response = await fetch(`${SAKURA_CLERK_BASE}/v1/client/sign_ins?_clerk_js_version=${encodeURIComponent(SAKURA_CLERK_VERSION)}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            Accept: 'application/json',
        },
        body: new URLSearchParams({
            identifier: identity,
            password: secret,
        }).toString(),
    });

    const responseText = await response.text().catch(() => '');
    const data = parseJsonSafely(responseText);

    if (!response.ok) {
        throw new Error(getErrorMessage(data, `Sakura login failed (${response.status})`));
    }

    let token = findJwtDeep(data);
    if (!token) {
        const refreshedClient = await fetchSakuraClient();
        token = findJwtDeep(refreshedClient);
    }

    if (!token) {
        throw new Error('Sakura sign-in succeeded, but Clerk did not return a session JWT. If your browser blocks Clerk cookies here, use the token method instead.');
    }

    return {
        token,
        displayName: identity,
        identifier: identity,
    };
}

export async function loginJoyland(email, password) {
    const identity = String(email || '').trim();
    const secret = String(password || '');

    if (!identity || !secret) {
        throw new Error('Email and password are required.');
    }

    const response = await fetch(`${JOYLAND_API_BASE}/user/login?email=${encodeURIComponent(identity)}&password=${encodeURIComponent(secret)}`, {
        method: 'POST',
        headers: {
            'source-platform': 'JL-PC',
            FingerPrint: getJoylandFingerprint(),
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: '{}',
    });

    const data = await response.json().catch(() => ({}));
    const token = data?.result?.token || '';
    if (!response.ok || data?.code !== '0' || !token) {
        throw new Error(getErrorMessage(data, `Joyland login failed (${response.status})`));
    }

    return {
        token,
        userId: data?.result?.userId || null,
        displayName: data?.result?.nickName || data?.result?.email || identity,
    };
}

export async function loginPygmalion(email, password) {
    const identity = String(email || '').trim();
    const secret = String(password || '');

    if (!identity || !secret) {
        throw new Error('Email and password are required.');
    }

    const response = await fetch('https://auth.pygmalion.chat/session', {
        method: 'POST',
        credentials: 'include',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            Accept: 'application/json',
        },
        body: new URLSearchParams({
            username: identity,
            password: secret,
        }).toString(),
    });

    const data = await response.json().catch(() => ({}));
    const token = data?.result?.id_token || data?.id_token || '';
    if (!response.ok || !token) {
        throw new Error(getErrorMessage(data, `Pygmalion login failed (${response.status})`));
    }

    const jwt = decodeJwtPayload(token);
    const userId = jwt?.sub || jwt?.user_id || jwt?.uid || null;
    let displayName = identity;

    if (userId) {
        try {
            const profileResponse = await fetch('https://server.pygmalion.chat/galatea.v1.PublicProfileService/ProfileByUserID', {
                method: 'POST',
                headers: {
                    'Connect-Protocol-Version': '1',
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ identifier: userId }),
            });

            if (profileResponse.ok) {
                const profileData = await profileResponse.json().catch(() => ({}));
                const profile = profileData?.user || profileData?.profile || profileData || {};
                displayName = profile.displayName || profile.username || identity;
            }
        } catch {}
    }

    return {
        token,
        userId,
        displayName,
    };
}

export async function loginWyvern(email, password) {
    const identity = String(email || '').trim();
    const secret = String(password || '');

    if (!identity || !secret) {
        throw new Error('Email and password are required.');
    }

    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(WYVERN_FIREBASE_API_KEY)}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify({
            email: identity,
            password: secret,
            returnSecureToken: true,
        }),
    });

    const data = await response.json().catch(() => ({}));
    const token = data?.idToken || '';
    if (!response.ok || !token) {
        throw new Error(getErrorMessage(data, `Wyvern login failed (${response.status})`));
    }

    return {
        token,
        refreshToken: data?.refreshToken || '',
        userId: data?.localId || null,
        displayName: identity,
    };
}

// ─── Token / Cookie verification ──────────────────────────────────────────────

/**
 * Verify a CharaVault auth value by calling /api/auth/me.
 * Accepts either the raw charavault_token value or a full cookie string.
 */
export async function verifyCharaVaultCookie(cookieStr) {
    const token = extractCharavaultToken(cookieStr);
    const response = await charavaultAuthFetch('https://charavault.net/api/auth/me', {
        service: 'charavault',
        fetchOptions: { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    });
    if (!response.ok) throw new Error(`Cookie invalid (${response.status})`);
    return response.json();
}

/**
 * Verify a Sakura JWT token.
 * Returns { valid: true } on success.
 */
export async function verifySakuraToken(token) {
    const response = await proxiedFetch('https://api.sakura.fm/api/get-characters', {
        service: 'sakura',
        fetchOptions: {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({
                offset: 0, search: '', allowNsfw: false, sortType: 'message-count', limit: 1,
                favoritesOnly: true, followingOnly: false, blockedOnly: false,
                eraseNsfw: false, tags: [], hideExplicit: false, matchType: 'any'
            })
        }
    });
    if (!response.ok) throw new Error(`Token invalid (${response.status})`);
    return { valid: true };
}

/**
 * Verify a CrushOn session-token cookie via /api/auth/session.
 * Returns user session object on success.
 */
export async function verifyCrushonCookie(cookieStr) {
    const response = await proxiedFetch('https://crushon.ai/api/auth/session', {
        service: 'crushon',
        fetchOptions: {
            headers: {
                Cookie: `next-auth.session-token=${cookieStr}`,
                Accept: 'application/json'
            }
        }
    });
    if (!response.ok) throw new Error(`Cookie invalid (${response.status})`);
    const data = await response.json();
    if (!data?.user) throw new Error('Not authenticated — is the cookie correct?');
    return data;
}

// ─── Favorites fetch ──────────────────────────────────────────────────────────

/**
 * Fetch CharaVault favorites list.
 * Returns raw API response (check .results or Array.isArray).
 */
export async function fetchCharaVaultFavorites(options = {}) {
    const { limit = 100, offset = 0 } = options;
    const response = await charavaultAuthFetch(
        `https://charavault.net/api/favorites?limit=${limit}&offset=${offset}`,
        {
            service: 'charavault_favorites',
            fetchOptions: { headers: { Accept: 'application/json' } }
        }
    );
    if (!response.ok) throw new Error(`CharaVault favorites failed (${response.status})`);
    return response.json();
}

/**
 * Fetch Sakura favorites (characters the authed user has favorited).
 * Returns raw API response matching the browse format.
 */
export async function fetchSakuraFavorites(token, options = {}) {
    const { limit = 100, offset = 0 } = options;
    const response = await proxiedFetch('https://api.sakura.fm/api/get-characters', {
        service: 'sakura',
        fetchOptions: {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({
                offset, search: '', allowNsfw: true, sortType: 'message-count', limit,
                favoritesOnly: true, followingOnly: false, blockedOnly: false,
                eraseNsfw: false, tags: [], hideExplicit: false, matchType: 'any'
            })
        }
    });
    if (!response.ok) throw new Error(`Sakura favorites failed (${response.status})`);
    return response.json();
}

/**
 * Fetch CrushOn liked characters via tRPC.
 * Returns array of character objects.
 */
export async function fetchCrushonLikes() {
    const noInputEncoded = encodeURIComponent(
        JSON.stringify({ '0': { json: null, meta: { values: ['undefined'] } } })
    );
    const url = `https://crushon.ai/api/trpc/character.getAllThumbsUpCharactersByUserId?batch=1&input=${noInputEncoded}`;
    const response = await proxiedFetch(url, {
        service: 'crushon',
        fetchOptions: { method: 'GET', headers: { Accept: 'application/json' } }
    });
    if (!response.ok) throw new Error(`CrushOn likes failed (${response.status})`);
    const data = await response.json();
    return data?.[0]?.result?.data?.json || [];
}

// ─── Favorite toggle ──────────────────────────────────────────────────────────

export async function toggleCharaVaultFavorite(path, isFavorited) {
    const url = `https://charavault.net/api/favorites?path=${encodeURIComponent(path)}`;
    const response = await charavaultAuthFetch(url, {
        service: 'charavault_favorites',
        fetchOptions: { method: isFavorited ? 'DELETE' : 'POST', headers: { Accept: 'application/json' } }
    });
    return response.ok;
}

export async function toggleSakuraFavorite(characterId, isFavorited, token) {
    const response = await proxiedFetch('https://api.sakura.fm/api/favorite', {
        service: 'sakura',
        fetchOptions: {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({ characterId, action: isFavorited ? 'unfavorite' : 'favorite' })
        }
    });
    return response.ok;
}

export async function toggleSaucepanFavorite(companionId, isFavorited) {
    const token = authState.saucepan.token;
    if (!token) throw new Error('Not logged in to Saucepan');
    const response = await fetch('https://api.saucepan.ai/api/v1/companions/favorite', {
        method: isFavorited ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ companion_id: companionId })
    });
    return response.ok;
}
