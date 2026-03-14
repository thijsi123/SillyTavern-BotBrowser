// CrushOn.AI API Module
// tRPC-based API, NSFW NOT auth-gated (nsfw param)

import { PROXY_TYPES, getProxyChainForService, proxiedFetch } from './corsProxy.js';

const BASE = 'https://crushon.ai/api/trpc';
const CRUSHON_CREATOR_PROXY_CHAIN = [
    PROXY_TYPES.PLUGIN,
    PROXY_TYPES.PUTER,
    PROXY_TYPES.CORSPROXY_IO,
    PROXY_TYPES.CORS_LOL,
];

export let crushonApiState = {
    cursor: null,
    hasMore: true,
    isLoading: false,
    lastCollectionKind: 'popular',
    lastNsfw: false,
    lastSearch: '',
    version: 5864093
};

export function resetCrushonState() {
    crushonApiState = { cursor: null, hasMore: true, isLoading: false, lastCollectionKind: 'popular', lastNsfw: false, lastSearch: '', version: 5864093 };
}

function trpcUrl(procedure, input) {
    const encoded = encodeURIComponent(JSON.stringify({ '0': { json: input } }));
    return `${BASE}/${procedure}?batch=1&input=${encoded}`;
}

function extractTrpcPayload(data) {
    return data?.[0]?.result?.data?.json;
}

function extractCrushonCollectionPayload(result) {
    const payload = result?.data || result || {};
    const characters = payload?.characters || payload?.data?.characters || [];
    const nextCursor = payload?.nextCursor ?? payload?.data?.nextCursor ?? null;
    const total = payload?.total ?? payload?.data?.total ?? 0;

    return {
        payload,
        characters: Array.isArray(characters) ? characters : [],
        nextCursor,
        total: Number(total || 0) || 0,
    };
}

async function fetchTrpc(procedure, input, options = {}) {
    const { validate = null, proxyChain = null, service = 'crushon' } = options;
    const url = trpcUrl(procedure, input);
    const proxies = Array.isArray(proxyChain) && proxyChain.length > 0
        ? proxyChain
        : getProxyChainForService(service);
    let lastError = null;

    for (const proxyType of proxies) {
        try {
            const response = await proxiedFetch(url, {
                service,
                proxyChain: [proxyType],
                fetchOptions: { method: 'GET', headers: { Accept: 'application/json' } }
            });
            if (!response.ok) throw new Error(`CrushOn API error: ${response.status}`);
            const data = await response.json();
            const payload = extractTrpcPayload(data);

            if (validate) {
                const verdict = await validate(payload, data);
                if (verdict === false) {
                    throw new Error(`CrushOn payload validation failed for ${procedure}`);
                }
                if (typeof verdict === 'string') {
                    throw new Error(verdict);
                }
                if (verdict && typeof verdict === 'object' && verdict.ok === false) {
                    throw new Error(verdict.reason || `CrushOn payload validation failed for ${procedure}`);
                }
            }

            return payload;
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error(`CrushOn request failed: ${procedure}`);
}

async function fetchCrushonPublicCollectionSnapshot(userId, nsfw = false, locale = 'en', options = {}) {
    const {
        count = 12,
        gender = 0,
        filterTags = [],
    } = options;

    const input = {
        isOwn: false,
        userId,
        tag: 1,
        locale,
        nsfw,
        requestPosition: 1,
        gamePlayTypes: [],
        sortTag: 1,
        gender,
        filterTags,
        count,
        direction: 'forward',
    };

    const endpoint = trpcUrl('character.queryUserCharacters', input);
    const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(endpoint)}&reqHeaders=${encodeURIComponent('Accept:application/json')}`;
    const response = await fetch(proxyUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
        throw new Error(`CrushOn public creator snapshot error: ${response.status}`);
    }

    const data = await response.json();
    const payload = extractTrpcPayload(data);
    const { characters, nextCursor, total } = extractCrushonCollectionPayload(payload);

    return {
        characters,
        total,
        nextCursor,
        hasMore: nextCursor != null,
    };
}

export async function getCrushonPublicCreatorSummary(userId, locale = 'en', options = {}) {
    const {
        count = 12,
        gender = 0,
        filterTags = [],
        allowNsfw = true,
    } = options;

    const sharedOptions = {
        count: Math.min(count, 12),
        gender,
        filterTags,
    };

    const profile = await getCrushonUserProfile(userId, {
        includeAuthHeaders: false,
        proxyChain: [PROXY_TYPES.CORSPROXY_IO, PROXY_TYPES.CORS_LOL, PROXY_TYPES.PUTER],
        service: 'default',
    }).catch(() => null);
    const sfwResult = await fetchCrushonPublicCollectionSnapshot(userId, false, locale, sharedOptions).catch(() => ({
        characters: [],
        total: 0,
        nextCursor: null,
        hasMore: false,
    }));
    const nsfwResult = allowNsfw
        ? await fetchCrushonPublicCollectionSnapshot(userId, true, locale, sharedOptions).catch(() => ({
            characters: [],
            total: 0,
            nextCursor: null,
            hasMore: false,
        }))
        : {
            characters: [],
            total: 0,
            nextCursor: null,
            hasMore: false,
        };

    const publicTotal = Math.max(
        Number(sfwResult?.total || 0) || 0,
        Number(nsfwResult?.total || 0) || 0,
    );

    return {
        total: publicTotal,
        profile: profile ? { ...profile, publicCardsCount: publicTotal } : { publicCardsCount: publicTotal },
    };
}

/**
 * Browse characters
 * collectionKind: 'popular' | 'new' | 'discover'
 */
export async function browseCrushonCharacters(options = {}) {
    const {
        collectionKind = 'popular',
        sortTag = '',
        tags = [],
        nsfw = false,
        flyingNsfw = false,
        gender = 0,
        count = 24,
        cursor = null,
        locale = 'en',
        version = 5864093
    } = options;

    const input = {
        tags,
        collectionKind,
        sortTag,
        nsfw,
        gender,
        count,
        locale,
        flyingNsfw,
        version,
        direction: 'forward'
    };
    if (cursor !== null) input.cursor = cursor;

    const result = await fetchTrpc('character.getCharactersByTag', input);
    const { characters, nextCursor, total } = extractCrushonCollectionPayload(result);

    return {
        characters,
        nextCursor,
        hasMore: nextCursor != null,
        total,
    };
}

/**
 * Search characters
 */
export async function searchCrushonCharacters(options = {}) {
    const {
        query = '',
        nsfw = false,
        gender = 0,
        sortTag = 'all',
        tags = [],
        flyingNsfw = false,
        count = 24,
        cursor = null,
        locale = 'en',
        version = 5864093,
        proxyChain = null,
        service = 'crushon',
    } = options;

    const input = {
        query,
        nsfw,
        gender,
        sortTag,
        tags,
        limit: count,
        locale,
        flyingNsfw,
        version,
        total: -1,
        direction: 'forward'
    };
    if (cursor !== null) input.cursor = cursor;

    const result = await fetchTrpc('character.searchInfinite', input, {
        proxyChain,
        service,
        validate: (payload) => {
            const { characters, total } = extractCrushonCollectionPayload(payload);
            if (total > 0 && characters.length === 0) {
                return 'CrushOn search returned an empty character list with a non-zero total';
            }
            return true;
        },
    });

    const { characters, nextCursor, total } = extractCrushonCollectionPayload(result);

    return {
        characters,
        nextCursor,
        hasMore: nextCursor != null,
        total,
    };
}

/**
 * Get full character detail
 */
export async function getCrushonCharacter(characterId, locale = 'en') {
    const [result, albumPayload] = await Promise.all([
        fetchTrpc('character.getCharacter', {
            characterId,
            displayPosition: 0,
            locale
        }),
        fetchTrpc('characterImage.getCharacterImagesWithMask', {
            characterId,
        }).catch(() => null),
    ]);

    return {
        ...result,
        characterImages: Array.isArray(albumPayload?.characterImages) ? albumPayload.characterImages : [],
    };
}

export async function getCrushonCharacterImages(characterId) {
    return fetchTrpc('characterImage.getCharacterImagesWithMask', { characterId });
}

/**
 * Get characters by user ID (public)
 */
export async function getCrushonUserCharacters(userId, nsfw = false, locale = 'en', options = {}) {
    const {
        count = 24,
        cursor = null,
        tag = 1,
        requestPosition = 1,
        gamePlayTypes = [],
        sortTag = 1,
        gender = 0,
        filterTags = [],
        proxyChain = null,
        service = 'crushon',
        allowEmptyCharactersWithTotal = false,
    } = options;

    const input = {
        isOwn: false,
        userId,
        tag,
        locale,
        nsfw,
        requestPosition,
        gamePlayTypes,
        sortTag,
        gender,
        filterTags,
        count,
        direction: 'forward'
    };

    if (cursor !== null && cursor !== undefined && cursor !== '') {
        input.cursor = cursor;
    }

    const result = await fetchTrpc('character.queryUserCharacters', input, {
        proxyChain,
        service,
        validate: (payload) => {
            const { characters, total } = extractCrushonCollectionPayload(payload);
            if (total > 0 && characters.length === 0) {
                if (allowEmptyCharactersWithTotal) {
                    return true;
                }
                return 'CrushOn creator lookup returned an empty character list with a non-zero total';
            }
            return true;
        },
    });
    const { characters, nextCursor, total } = extractCrushonCollectionPayload(result);

    return {
        characters,
        total,
        nextCursor,
        hasMore: nextCursor != null
    };
}

export async function getCrushonUserProfile(userId, options = {}) {
    const { proxyChain = CRUSHON_CREATOR_PROXY_CHAIN, service = 'crushon' } = options;
    if (!userId) {
        return null;
    }

    const payload = await fetchTrpc('account.queryOtherUserProfile', { userId }, {
        proxyChain,
        service,
    }).catch(() => null);

    return payload || null;
}

function normalizeCrushonCreatorLabel(value) {
    return String(value || '').trim().toLowerCase();
}

function parseCrushonHumanCount(value) {
    const text = String(value || '').trim().replace(/,/g, '');
    if (!text) return 0;

    const match = text.match(/^([\d.]+)\s*([KMB])?$/i);
    if (!match) {
        const numeric = Number(text);
        return Number.isFinite(numeric) ? numeric : 0;
    }

    const numeric = Number(match[1]);
    if (!Number.isFinite(numeric)) return 0;
    const suffix = String(match[2] || '').toUpperCase();
    const multiplier = suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : suffix === 'B' ? 1e9 : 1;
    return Math.round(numeric * multiplier);
}

async function fetchCrushonProfilePageHtml(userId) {
    if (!userId) return '';

    const url = `https://crushon.ai/profile/${encodeURIComponent(userId)}`;
    const proxies = [PROXY_TYPES.CORSPROXY_IO, PROXY_TYPES.CORS_LOL, PROXY_TYPES.PUTER];
    let lastError = null;

    for (const proxyType of proxies) {
        try {
            const response = await proxiedFetch(url, {
                // Treat creator profile HTML as a public page so Bot Browser does not
                // accidentally prioritize auth-bearing transports like Puter/plugin first.
                service: 'default',
                proxyChain: [proxyType],
                fetchOptions: {
                    method: 'GET',
                    headers: {
                        Accept: 'text/html,application/xhtml+xml',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
                    },
                },
            });
            if (!response.ok) throw new Error(`CrushOn profile page error: ${response.status}`);
            const html = await response.text();
            if (!html || !html.includes('/character/') || !html.includes('/profile/')) {
                throw new Error('CrushOn profile page did not contain expected card markup');
            }
            return html;
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error('CrushOn profile page fetch failed');
}

function parseCrushonProfileCardsHtml(html, userId = '') {
    if (!html || typeof DOMParser === 'undefined') {
        return { profile: null, characters: [], total: 0 };
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const heading = doc.querySelector('h1');
    const profileName = String(heading?.childNodes?.[0]?.textContent || heading?.textContent || '').trim();

    const buttons = [...doc.querySelectorAll('button')];
    const followersButton = buttons.find((button) => /followers/i.test(button.textContent || ''));
    const followingButton = buttons.find((button) => /following/i.test(button.textContent || ''));
    const interactionsButton = buttons.find((button) => /interactions/i.test(button.textContent || ''));

    const links = [...doc.querySelectorAll('a[href*="/character/"][href*="/chat"]')];
    const seen = new Set();
    const characters = [];

    for (const link of links) {
        const href = String(link.getAttribute('href') || '').trim();
        const idMatch = href.match(/\/character\/([0-9a-f-]{36})\//i);
        const characterId = String(idMatch?.[1] || '').trim();
        if (!characterId || seen.has(characterId)) continue;
        seen.add(characterId);

        const image = link.querySelector('img[alt]');
        const imageUrl = String(image?.getAttribute('src') || '').trim();
        const fallbackName = String(image?.getAttribute('alt') || '').trim();
        const lines = String(link.textContent || '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);

        const creatorAt = lines.lastIndexOf('@');
        const creatorName = creatorAt >= 0 ? String(lines[creatorAt + 1] || profileName || '').trim() : profileName;
        const likes = parseCrushonHumanCount(lines[0] || '');
        const interactionCount = parseCrushonHumanCount(lines[lines.length - 1] || '');
        const cardName = String(fallbackName || lines[1] || '').trim() || 'Unnamed';
        const middleLines = lines.slice(2, creatorAt >= 0 ? creatorAt : lines.length);
        const description = String(middleLines[0] || '').trim();
        const tags = middleLines
            .slice(1)
            .map((line) => String(line || '').trim())
            .filter((line) => line && line !== '@' && !/^\+\d+$/.test(line));
        const cardHref = new URL(href, 'https://crushon.ai').toString();
        const isUnfiltered = tags.some((tag) => normalizeCrushonCreatorLabel(tag) === 'unfiltered');

        characters.push({
            id: characterId,
            name: cardName,
            description,
            tags,
            likes,
            nsfw: isUnfiltered,
            avatar: imageUrl,
            characterAvatar: { avatar: imageUrl },
            user: {
                id: userId,
                name: creatorName,
            },
            creator: creatorName,
            metric: {
                likeCount: likes,
                message_count: interactionCount,
            },
            _profileHref: cardHref,
            _profilePageVisible: true,
        });
    }

    return {
        profile: {
            name: profileName,
            followerCount: parseCrushonHumanCount(followersButton?.textContent || ''),
            followingCount: parseCrushonHumanCount(followingButton?.textContent || ''),
            allCharacterMsgCount: parseCrushonHumanCount(interactionsButton?.textContent || ''),
        },
        characters,
        total: characters.length,
    };
}

function parseCrushonCreatorCursor(cursor) {
    if (cursor === null || cursor === undefined || cursor === '') {
        return { sfw: null, nsfw: null };
    }

    if (typeof cursor === 'number') {
        return { sfw: Number.isFinite(cursor) ? cursor : null, nsfw: Number.isFinite(cursor) ? cursor : null };
    }

    const text = String(cursor).trim();
    if (!text) return { sfw: null, nsfw: null };

    try {
        const parsed = JSON.parse(text);
        return {
            sfw: parsed?.sfw ?? null,
            nsfw: parsed?.nsfw ?? null,
        };
    } catch {
        const numeric = Number(text);
        return {
            sfw: Number.isFinite(numeric) ? numeric : null,
            nsfw: Number.isFinite(numeric) ? numeric : null,
        };
    }
}

function encodeCrushonCreatorCursor(cursor) {
    if (!cursor) return null;
    const sfw = cursor.sfw ?? null;
    const nsfw = cursor.nsfw ?? null;
    if (sfw == null && nsfw == null) return null;
    return JSON.stringify({ sfw, nsfw });
}

function mergeCrushonCharacterLists(...lists) {
    const merged = new Map();

    for (const list of lists) {
        for (const card of Array.isArray(list) ? list : []) {
            const id = String(card?.id || '').trim();
            if (!id) continue;
            if (!merged.has(id)) {
                merged.set(id, card);
                continue;
            }

            const current = merged.get(id);
            const currentScore = (current?.likes || current?.metric?.likeCount || 0) + (current?.metric?.message_count || 0);
            const nextScore = (card?.likes || card?.metric?.likeCount || 0) + (card?.metric?.message_count || 0);
            if (nextScore > currentScore) merged.set(id, card);
        }
    }

    return [...merged.values()];
}

async function resolveCrushonUserIdByCreatorName(creatorName, options = {}) {
    const {
        allowNsfw = true,
        locale = 'en',
        count = 72,
    } = options;

    const needle = normalizeCrushonCreatorLabel(creatorName);
    if (!needle) return '';

    const searchModes = allowNsfw ? [false, true] : [false];
    const matches = new Map();

    for (const nsfw of searchModes) {
        let result = null;
        try {
            result = await searchCrushonCharacters({
                query: creatorName,
                nsfw,
                gender: 0,
                sortTag: 'all',
                tags: [],
                flyingNsfw: false,
                count,
                locale,
                total: -1,
                proxyChain: CRUSHON_CREATOR_PROXY_CHAIN,
            });
        } catch {
            continue;
        }

        for (const card of Array.isArray(result?.characters) ? result.characters : []) {
            const creator = normalizeCrushonCreatorLabel(card?.creator || card?.user?.name || '');
            const userId = String(card?.user?.id || '').trim();
            if (!userId || creator !== needle) continue;

            const bucket = matches.get(userId) || {
                id: userId,
                count: 0,
                likeCount: 0,
                messageCount: 0,
            };
            bucket.count += 1;
            bucket.likeCount += Number(card?.likes || card?.metric?.likeCount || 0) || 0;
            bucket.messageCount += Number(card?.metric?.message_count || 0) || 0;
            matches.set(userId, bucket);
        }
    }

    const ranked = [...matches.values()].sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        if (b.likeCount !== a.likeCount) return b.likeCount - a.likeCount;
        return b.messageCount - a.messageCount;
    });

    return ranked[0]?.id || '';
}

export async function getCrushonCreatorCharacters(userNeedle, locale = 'en', options = {}) {
    const {
        count = 48,
        cursor = null,
        gender = 0,
        filterTags = [],
        allowNsfw = true,
    } = options;

    const userId = /^[0-9a-f-]{36}$/i.test(String(userNeedle || '').trim())
        ? String(userNeedle || '').trim()
        : await resolveCrushonUserIdByCreatorName(userNeedle, {
            allowNsfw,
            locale,
            count: Math.max(count, 72),
        });

    if (!userId) {
        return {
            userId: '',
            characters: [],
            total: 0,
            nextCursor: null,
            hasMore: false,
        };
    }

    const parsedCursor = parseCrushonCreatorCursor(cursor);
    const sharedOptions = {
        count,
        gender,
        filterTags,
        proxyChain: CRUSHON_CREATOR_PROXY_CHAIN,
    };
    const publicSharedOptions = {
        count: Math.min(count, 12),
        gender,
        filterTags,
        proxyChain: [PROXY_TYPES.CORSPROXY_IO, PROXY_TYPES.CORS_LOL, PROXY_TYPES.PUTER],
        service: 'default',
        allowEmptyCharactersWithTotal: true,
    };

    const [profile, sfwResult, nsfwResult, profilePageResult] = await Promise.all([
        getCrushonUserProfile(userId, {
            proxyChain: CRUSHON_CREATOR_PROXY_CHAIN,
            service: 'crushon',
        }).catch(() => null),
        getCrushonUserCharacters(userId, false, locale, {
            ...sharedOptions,
            cursor: parsedCursor.sfw,
        }).catch(() => ({
            characters: [],
            total: 0,
            nextCursor: null,
            hasMore: false,
        })),
        allowNsfw
            ? getCrushonUserCharacters(userId, true, locale, {
                ...sharedOptions,
                cursor: parsedCursor.nsfw,
            }).catch(() => ({
                characters: [],
                total: 0,
                nextCursor: null,
                hasMore: false,
            }))
            : Promise.resolve({
                characters: [],
                total: 0,
                nextCursor: null,
                hasMore: false,
            }),
        fetchCrushonProfilePageHtml(userId)
            .then((html) => parseCrushonProfileCardsHtml(html, userId))
            .catch(() => ({
                profile: null,
                characters: [],
                total: 0,
            })),
    ]);

    const publicSummary = await getCrushonPublicCreatorSummary(userId, locale, {
        ...publicSharedOptions,
        allowNsfw,
    }).catch(() => ({
        total: 0,
        profile: { publicCardsCount: 0 },
    }));

    const characters = mergeCrushonCharacterLists(
        sfwResult?.characters || [],
        nsfwResult?.characters || [],
        profilePageResult?.characters || [],
    );
    const publicTotal = Number(publicSummary?.total || 0) || 0;

    const total = Math.max(
        Number(sfwResult?.total || 0) || 0,
        Number(nsfwResult?.total || 0) || 0,
        publicTotal,
        Number(profilePageResult?.total || 0) || 0,
        characters.length,
    );
    const nextCursor = encodeCrushonCreatorCursor({
        sfw: sfwResult?.nextCursor ?? null,
        nsfw: allowNsfw ? (nsfwResult?.nextCursor ?? null) : null,
    });

    return {
        userId,
        profile: {
            ...(profilePageResult?.profile || {}),
            ...(publicSummary?.profile || {}),
            ...(profile || {}),
            publicCardsCount: publicTotal,
        },
        characters,
        total,
        nextCursor,
        hasMore: Boolean(sfwResult?.hasMore || (allowNsfw && nsfwResult?.hasMore)),
    };
}

/**
 * Transform tag objects to string array
 */
function extractTags(tags) {
    if (!Array.isArray(tags)) return [];
    return tags.map(t => (typeof t === 'string' ? t : t.label || t.slug || '')).filter(Boolean);
}

function normalizeCrushonTimestamp(value) {
    if (value === null || value === undefined || value === '') return '';

    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
        const date = new Date(numeric > 1e12 ? numeric : numeric * 1000);
        if (!Number.isNaN(date.getTime())) return date.toISOString();
    }

    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? String(value || '') : date.toISOString();
}

function pickCrushonCreatorName(card) {
    return card?.creator?.name
        || card?.creator?.username
        || card?.creator?.nickname
        || card?.user?.name
        || card?.user?.nickname
        || card?.user?.username
        || (typeof card?.creator === 'string' ? card.creator : '')
        || 'Unknown';
}

function pickCrushonCreatorAvatar(card) {
    return String(
        card?.creator?.avatar
        || card?.creator?.avatarUrl
        || card?.creator?.image
        || card?.user?.avatar
        || card?.user?.avatarUrl
        || card?.user?.image
        || '',
    ).trim();
}

/**
 * Transform browse card to BotBrowser format
 */
export function transformCrushonCard(card) {
    const galleryImages = uniqueCrushonValues([
        card.characterAvatar?.avatar,
        card.characterAvatar?.thumbnailAvatar,
        card.characterAvatar?.keyframeAvatar,
        card.characterAvatar?.keyframeThumbnailAvatar,
        card.avatar,
        card.thumbnailAvatar,
        card.characterSceneCard?.image,
        card.characterSceneCard?.croppedImage,
    ]);

    return {
        id: card.id || '',
        name: card.name || 'Unnamed',
        creator: pickCrushonCreatorName(card),
        _creatorId: card.user?.id || '',
        _creatorProfileAvatarUrl: pickCrushonCreatorAvatar(card),
        avatar_url: card.avatar || card.characterAvatar?.avatar || '',
        image_url: card.avatar || card.characterAvatar?.avatar || '',
        tags: extractTags(card.tags),
        description: card.description || '',
        desc_preview: card.description || '',
        first_mes: '',
        first_message: '',
        created_at: normalizeCrushonTimestamp(card.createAt || card.createdAt || ''),
        updated_at: normalizeCrushonTimestamp(card.updateAt || card.updatedAt || ''),
        possibleNsfw: card.rating >= 2 || false,
        likeCount: card.likes || card.metric?.likeCount || 0,
        messageCount: card.metric?.message_count || 0,
        total_chars: card.messages || card.metric?.message_count || 0,
        visibility: card.visibility,
        reviewState: card.reviewState,
        reviewMsg: card.reviewMsg || '',
        rating: card.rating || 0,
        conversationCount: card.conversationCount || 0,
        canShowAlbumCount: card.canShowAlbumCount || 0,
        appearance: card.appearance || '',
        age: card.age || 0,
        thumbnailAvatar: card.characterAvatar?.thumbnailAvatar || card.thumbnailAvatar || '',
        voice: card.voice || null,
        gamePlayTypes: Array.isArray(card.gamePlayTypes) ? card.gamePlayTypes : [],
        gallery_images: galleryImages,
        service: 'crushon',
        sourceService: 'crushon',
        isCrushon: true,
        isLiveApi: true
    };
}

function uniqueCrushonValues(values = []) {
    return [...new Set(values.filter(Boolean).map(value => String(value).trim()).filter(Boolean))];
}

function extractCrushonAlbumImages(value) {
    const items = Array.isArray(value?.characterImages)
        ? value.characterImages
        : Array.isArray(value)
            ? value
            : [];

    return items.flatMap((item) => [
        item?.coverImageUrl,
        item?.imageUrl,
        item?.originImageUrl,
    ]);
}

function extractCrushonEmbeddedImageUrls(...values) {
    const urls = [];
    const imageRegex = /!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/gi;

    for (const value of values) {
        const text = String(value || '');
        if (!text) continue;

        let match;
        while ((match = imageRegex.exec(text)) !== null) {
            if (match[1]) urls.push(match[1]);
        }
    }

    return urls;
}

function buildCrushonExampleDialogue(char) {
    const modernMessages = Array.isArray(char?.newExampleConversation?.messages)
        ? char.newExampleConversation.messages
        : Array.isArray(char?.newExampleConversation)
            ? char.newExampleConversation
            : [];

    if (modernMessages.length > 0) {
        return `<START>\n${modernMessages.map((message) => {
            const role = String(message?.role || '').toLowerCase();
            const speaker = role === 'user'
                ? '{{user}}'
                : role === 'assistant' || role === 'character'
                    ? '{{char}}'
                    : (message?.name === char?.name ? '{{char}}' : '{{user}}');
            const content = message?.text || message?.content || message?.message || '';
            return content ? `${speaker}: ${content}` : '';
        }).filter(Boolean).join('\n')}`;
    }

    const legacy = char?.example_conversation;
    if (Array.isArray(legacy) && legacy.length > 0) {
        return `<START>\n${legacy.map((message) => {
            const role = message?.name === char?.name ? '{{char}}' : '{{user}}';
            const content = message?.text || message?.content || '';
            return content ? `${role}: ${content}` : '';
        }).filter(Boolean).join('\n')}`;
    }

    return typeof legacy === 'string' ? legacy : '';
}

/**
 * Transform full character detail for import
 */
export function transformFullCrushonCharacter(char) {
    const mesExample = buildCrushonExampleDialogue(char);
    const creatorName = pickCrushonCreatorName(char);
    const websiteDescription = char.description || '';
    const primaryDefinition = char.personality || char.scenario || char.appearance || websiteDescription || char.greeting || '';
    const usedGreetingFallback = !char.personality && !char.scenario && !char.appearance && !websiteDescription && !!char.greeting;
    const galleryImages = uniqueCrushonValues([
        char.avatar,
        char.thumbnailAvatar,
        char.characterAvatar?.avatar,
        char.characterAvatar?.thumbnailAvatar,
        char.characterAvatar?.keyframeAvatar,
        char.characterAvatar?.keyframeThumbnailAvatar,
        char.characterSceneCard?.avatar,
        char.characterSceneCard?.thumbnailAvatar,
        char.characterSceneCard?.image,
        char.characterSceneCard?.croppedImage,
        ...extractCrushonAlbumImages(char.characterImages),
        ...extractCrushonAlbumImages(char.album),
        ...extractCrushonEmbeddedImageUrls(char.greeting, char.description),
    ]);
    const creatorNotes = [
        'Imported from CrushOn.AI',
        creatorName ? `Creator: ${creatorName}` : '',
        char.appearance ? `Appearance: ${char.appearance}` : '',
        char.likes ? `Likes: ${Number(char.likes).toLocaleString()}` : '',
        char.messages ? `Total chars: ${Number(char.messages).toLocaleString()}` : '',
        char.conversationCount ? `Conversations: ${Number(char.conversationCount).toLocaleString()}` : '',
        char.thumbsUpCount ? `Thumbs up: ${Number(char.thumbsUpCount).toLocaleString()}` : '',
        char.shareCount ? `Shares: ${Number(char.shareCount).toLocaleString()}` : '',
        char.canShowAlbumCount ? `Album images: ${char.canShowAlbumCount}` : '',
        char.visibility !== undefined ? `Visibility: ${char.visibility}` : '',
        char.definitionVisibility !== undefined ? `Definition visibility: ${char.definitionVisibility}` : '',
        char.rating ? `Rating: ${char.rating}` : '',
        char.reviewState ? `Review state: ${char.reviewState}` : '',
        char.reviewMsg ? `Review note: ${char.reviewMsg}` : '',
        char.voice?.name ? `Voice: ${char.voice.name}` : '',
        usedGreetingFallback ? 'Public definition text is hidden on CrushOn; Primary Definition fell back to the visible greeting.' : '',
    ].filter(Boolean).join('\n');

    return {
        name: char.name || '',
        description: primaryDefinition,
        personality: char.appearance || '',
        scenario: char.scenario || '',
        first_mes: char.greeting || '',
        first_message: char.greeting || '',
        mes_example: mesExample,
        creator_notes: creatorNotes,
        website_description: websiteDescription,
        system_prompt: '',
        alternate_greetings: [],
        character_book: undefined,
        gallery_images: galleryImages,
        appearance: char.appearance || '',
        definitionVisibility: char.definitionVisibility,
        reviewState: char.reviewState,
        reviewMsg: char.reviewMsg || '',
        conversationCount: char.conversationCount || 0,
        canShowAlbumCount: char.canShowAlbumCount || 0,
        total_chars: char.messages || 0,
        visibility: char.visibility,
        created_at: normalizeCrushonTimestamp(char.createAt || char.createdAt || ''),
        updated_at: normalizeCrushonTimestamp(char.updateAt || char.updatedAt || ''),
        _creatorProfileAvatarUrl: pickCrushonCreatorAvatar(char),
        characterImages: Array.isArray(char.characterImages) ? char.characterImages : [],
        tags: extractTags(char.tags),
        creator: creatorName
    };
}
