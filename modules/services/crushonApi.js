// CrushOn.AI API Module
// tRPC-based API, NSFW NOT auth-gated (nsfw param)

import { getProxyChainForService, proxiedFetch } from './corsProxy.js';

const BASE = 'https://crushon.ai/api/trpc';

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
    const { validate = null } = options;
    const url = trpcUrl(procedure, input);
    const proxies = getProxyChainForService('crushon');
    let lastError = null;

    for (const proxyType of proxies) {
        try {
            const response = await proxiedFetch(url, {
                service: 'crushon',
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
        version = 5864093
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
        validate: (payload) => {
            const { characters, total } = extractCrushonCollectionPayload(payload);
            if (total > 0 && characters.length === 0) {
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
