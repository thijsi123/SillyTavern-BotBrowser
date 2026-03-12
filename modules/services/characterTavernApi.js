/**
 * Character Tavern API Service
 * Live API for searching and importing characters from character-tavern.com
 */

import { proxiedFetch } from './corsProxy.js';
import { extractCharacterDataFromPngArrayBuffer } from './embeddedCardParser.js';

const CT_SITE_BASE = 'https://character-tavern.com';
const CT_API_BASE = `${CT_SITE_BASE}/api/search/cards`;

// API state for pagination
export const characterTavernApiState = {
    page: 1,
    hasMore: true,
    isLoading: false,
    totalHits: 0,
    totalPages: 1,
    lastSearch: '',
    lastSort: ''
};

function normalizeCtDate(value) {
    if (value == null || value === '') return '';

    if (typeof value === 'number' && Number.isFinite(value)) {
        const normalized = value > 1e12 ? value : (value > 1e9 ? value * 1000 : value);
        const date = new Date(normalized);
        return Number.isNaN(date.getTime()) ? '' : date.toISOString();
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function getCharacterTavernCreator(node = {}) {
    if (typeof node.creator === 'string' && node.creator.trim()) return node.creator.trim();
    if (typeof node.path === 'string' && node.path.includes('/')) {
        const [username] = node.path.split('/');
        if (username) return username;
    }
    if (typeof node.authorName === 'string' && node.authorName.trim()) return node.authorName.trim();
    if (node.author != null && node.author !== '') return String(node.author);
    return 'Unknown';
}

function getCharacterTavernImageUrl(path) {
    return path ? `https://cards.character-tavern.com/${path}.png` : '';
}

export function getCharacterTavernDownloadUrl(path) {
    return path ? `https://cards.character-tavern.com/${path}.png?action=download` : '';
}

export async function getCharacterTavernEmbeddedCard(path) {
    if (!path) throw new Error('Character Tavern path is required');

    const response = await proxiedFetch(getCharacterTavernDownloadUrl(path), {
        service: 'character_tavern',
        fetchOptions: {
            headers: {
                Accept: 'image/png,image/*;q=0.9,*/*;q=0.8',
            },
        },
    });

    if (!response.ok) {
        throw new Error(`Character Tavern card PNG error: ${response.status}`);
    }

    return extractCharacterDataFromPngArrayBuffer(await response.arrayBuffer());
}

function parseCharacterTavernMetric(doc, labelText) {
    const target = String(labelText || '').trim().toLowerCase();
    const metricRows = [...doc.querySelectorAll('div, span')]
        .map((node) => node.textContent?.trim())
        .filter(Boolean);

    for (let i = 0; i < metricRows.length - 1; i++) {
        if (metricRows[i].toLowerCase() === target) {
            return metricRows[i - 1] || '';
        }
    }

    return '';
}

function parseCharacterTavernAuthorCards(doc, username) {
    const anchors = [...doc.querySelectorAll('a[href^="/character/"]')];
    const dedup = new Map();

    for (const anchor of anchors) {
        const href = anchor.getAttribute('href') || '';
        const match = href.match(/^\/character\/([^/?#]+\/[^/?#]+)/i);
        if (!match) continue;

        const path = match[1];
        if (dedup.has(path)) continue;

        const title = anchor.querySelector('h3')?.textContent?.trim()
            || anchor.getAttribute('aria-label')
            || path.split('/').pop()?.replace(/[_-]+/g, ' ')
            || 'Unknown';
        const description = anchor.querySelector('p')?.textContent?.trim() || '';
        const image = anchor.querySelector('img')?.getAttribute('src') || getCharacterTavernImageUrl(path);

        dedup.set(path, {
            id: path,
            name: title,
            creator: username,
            avatar_url: image,
            image_url: image,
            gallery_images: image ? [image] : [],
            tags: [],
            description,
            desc_preview: description ? description.substring(0, 300) : '',
            created_at: '',
            possibleNsfw: false,
            service: 'character_tavern',
            sourceService: 'character_tavern_author_page',
            isCharacterTavern: true,
            fullPath: path,
            path,
        });
    }

    return [...dedup.values()];
}

/**
 * Search Character Tavern for cards
 * @param {Object} options - Search options
 * @returns {Promise<Array>} Array of transformed cards
 */
export async function searchCharacterTavern(options = {}) {
    const {
        query = '',
        page = 1,
        limit = 30,
        hasLorebook,
        isOC,
        minTokens,
        maxTokens,
        excludeTags = [],
        tags = [],
        sort
    } = options;

    characterTavernApiState.isLoading = true;

    try {
        const params = new URLSearchParams();

        if (query) params.set('query', query);
        params.set('limit', limit.toString());
        params.set('page', page.toString());

        if (hasLorebook === true) params.set('hasLorebook', 'true');
        if (isOC === true) params.set('isOC', 'true');
        if (minTokens) params.set('minimum_tokens', minTokens.toString());
        if (maxTokens) params.set('maximum_tokens', maxTokens.toString());
        if (tags.length > 0) params.set('tags', tags.join(','));
        if (excludeTags.length > 0) params.set('exclude_tags', excludeTags.join(','));
        if (sort) params.set('sort', sort);

        const url = `${CT_API_BASE}?${params}`;
        console.log('[Bot Browser] Character Tavern API request:', url);

        const response = await proxiedFetch(url, {
            service: 'character_tavern',
            fetchOptions: {
                headers: {
                    'Accept': 'application/json'
                }
            }
        });

        if (!response.ok) {
            throw new Error(`Character Tavern API error: ${response.status}`);
        }

        const data = await response.json();

        // Update pagination state
        characterTavernApiState.page = data.page || 1;
        characterTavernApiState.totalPages = data.totalPages || 1;
        characterTavernApiState.hasMore = (data.page || 1) < (data.totalPages || 1);
        characterTavernApiState.totalHits = data.totalHits || 0;
        characterTavernApiState.lastSearch = query;

        console.log('[Bot Browser] Character Tavern API response:', {
            hits: data.hits?.length || 0,
            totalHits: data.totalHits,
            page: data.page,
            totalPages: data.totalPages
        });

        return (data.hits || []).map(transformCharacterTavernCard);
    } catch (error) {
        console.error('[Bot Browser] Character Tavern API error:', error);
        throw error;
    } finally {
        characterTavernApiState.isLoading = false;
    }
}

export async function getCharacterTavernCharacter(path) {
    if (!path) throw new Error('Character Tavern path is required');

    const response = await proxiedFetch(`${CT_SITE_BASE}/api/character/${path}`, {
        service: 'character_tavern',
        fetchOptions: {
            headers: {
                Accept: 'application/json',
            },
        },
    });

    if (!response.ok) {
        throw new Error(`Character Tavern detail error: ${response.status}`);
    }

    return response.json();
}

export async function getCharacterTavernAlternativeGreetings(id) {
    if (!id) return [];

    const response = await proxiedFetch(`${CT_SITE_BASE}/api/character/${id}/alternative-greetings`, {
        service: 'character_tavern',
        fetchOptions: {
            headers: {
                Accept: 'application/json',
            },
        },
    });

    if (!response.ok) {
        if (response.status === 404) return [];
        throw new Error(`Character Tavern alt greetings error: ${response.status}`);
    }

    const data = await response.json();
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.alternativeGreetings)) return data.alternativeGreetings;
    return [];
}

function transformCharacterTavernLorebookToCharacterBook(lorebook) {
    if (!lorebook || typeof lorebook !== 'object') return null;

    const rawEntries = Array.isArray(lorebook.entries) ? lorebook.entries : [];
    if (rawEntries.length === 0) return {
        name: lorebook.name || 'Imported Lorebook',
        description: lorebook.description || '',
        scanDepth: Number(lorebook.scanDepth ?? 4),
        entries: [],
    };

    return {
        name: lorebook.name || 'Imported Lorebook',
        description: lorebook.description || '',
        scanDepth: Number(lorebook.scanDepth ?? 4),
        entries: rawEntries.map((entry, index) => ({
            id: entry?.id || index,
            key: Array.isArray(entry?.keys) ? entry.keys : [],
            keysecondary: Array.isArray(entry?.secondaryKeys) ? entry.secondaryKeys : [],
            comment: entry?.name || `Entry ${index + 1}`,
            content: entry?.content || '',
            constant: !!entry?.constant,
            selective: entry?.constant ? false : true,
            order: Number(entry?.insertionOrder ?? entry?.order ?? 100),
            disable: entry?.enabled === false,
            depth: Number(entry?.depth ?? lorebook.scanDepth ?? 4),
            position: Number(entry?.position ?? 0),
            role: Number(entry?.role ?? 0),
        })),
    };
}

export async function getCharacterTavernLorebook(id) {
    if (!id) return null;

    const url = `${CT_SITE_BASE}/api/character/${id}/lorebook`;
    let response;
    try {
        response = await fetch(`https://corsproxy.io/?url=${encodeURIComponent(url)}`, {
            headers: {
                Accept: 'application/json',
            },
        });
    } catch {
        response = null;
    }

    if (!response || !response.ok) {
        response = await proxiedFetch(url, {
            service: 'character_tavern',
            fetchOptions: {
                headers: {
                    Accept: 'application/json',
                },
            },
        });
    }

    if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`Character Tavern lorebook error: ${response.status}`);
    }

    const data = await response.json();
    if (!data || (Array.isArray(data) && data.length === 0)) return null;
    return {
        raw: data,
        characterBook: transformCharacterTavernLorebookToCharacterBook(data),
    };
}

export async function getCharacterTavernAuthorProfile(username) {
    if (!username) throw new Error('Character Tavern username is required');

    const response = await proxiedFetch(`${CT_SITE_BASE}/author/${encodeURIComponent(username)}`, {
        service: 'character_tavern',
        fetchOptions: {
            headers: {
                Accept: 'text/html',
            },
        },
    });

    if (!response.ok) {
        throw new Error(`Character Tavern author page error: ${response.status}`);
    }

    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const displayName = doc.querySelector('h1')?.textContent?.trim() || username;
    const bannerStyle = doc.querySelector('[style*="background-image"]')?.getAttribute('style') || '';
    const bannerMatch = bannerStyle.match(/background-image:\s*url\(([^)]+)\)/i);
    const avatarNode = [...doc.querySelectorAll('img')].find((img) => (img.getAttribute('alt') || '').trim() === displayName);
    const cards = parseCharacterTavernAuthorCards(doc, username);
    const cardsCount = Number(cards.length || 0);

    return {
        profile: {
            username,
            displayName,
            avatarURL: avatarNode?.getAttribute('src') || '',
            bannerURL: bannerMatch?.[1] || '',
            cardsCount,
            followersCount: parseCharacterTavernMetric(doc, 'followers'),
            messages: parseCharacterTavernMetric(doc, 'messages'),
            chats: parseCharacterTavernMetric(doc, 'chats'),
            bio: doc.querySelector('aside p.text-xs')?.textContent?.trim() || '',
        },
        cards,
    };
}

/**
 * Transform a Character Tavern card to BotBrowser format
 * @param {Object} node - Raw card data from API
 * @returns {Object} Transformed card
 */
export function transformCharacterTavernCard(node) {
    const imageUrl = getCharacterTavernImageUrl(node.path);
    const creator = getCharacterTavernCreator(node);

    // Use characterDefinition as the real description, tagline is just website meta
    const description = node.characterDefinition || node.pageDescription || node.tagline || '';
    const descPreview = description ? description.substring(0, 300) : '';

    return {
        id: node.id,
        name: node.name || node.inChatName || 'Unknown',
        creator,
        avatar_url: imageUrl,
        image_url: imageUrl,
        gallery_images: imageUrl ? [imageUrl] : [],
        tags: node.tags || [],
        // Use actual character definition as description
        description: description,
        desc_preview: descPreview,
        desc_search: description,
        // Character fields for detail modal display
        personality: node.characterPersonality || '',
        scenario: node.characterScenario || '',
        first_message: node.characterFirstMessage || '',
        mes_example: node.characterExampleMessages || '',
        alternate_greetings: node.alternativeFirstMessage || [],
        post_history_instructions: node.characterPostHistoryPrompt || '',
        system_prompt: node.characterSystemPrompt || '',
        creator_notes: node.pageDescription || node.tagline || '',
        // Metadata
        created_at: normalizeCtDate(node.createdAt),
        updated_at: normalizeCtDate(node.lastUpdateAt),
        nTokens: node.totalTokens || 0,
        possibleNsfw: node.isNSFW || false,
        service: 'character_tavern',
        sourceService: 'character_tavern_live',
        isCharacterTavern: true,
        hasLorebook: node.hasLorebook || false,
        isOC: node.isOC || false,
        views: node.views || node.analytics_views || 0,
        analytics_views: node.views || node.analytics_views || 0,
        downloads: node.downloads || node.analytics_downloads || 0,
        analytics_downloads: node.downloads || node.analytics_downloads || 0,
        likes: node.likes || 0,
        dislikes: node.dislikes || 0,
        messages: node.messages || node.analytics_messages || 0,
        analytics_messages: node.messages || node.analytics_messages || 0,
        fullPath: node.path,
        visibility: node.visibility || '',
        versionId: node.versionId || '',
        ownerCTId: node.ownerCTId || '',
        lorebookId: node.lorebookId || '',
        // Store full data for import
        _rawData: {
            characterDefinition: node.characterDefinition || '',
            characterPersonality: node.characterPersonality || '',
            characterScenario: node.characterScenario || '',
            characterFirstMessage: node.characterFirstMessage || '',
            characterExampleMessages: node.characterExampleMessages || '',
            characterSystemPrompt: node.characterSystemPrompt || '',
            characterPostHistoryPrompt: node.characterPostHistoryPrompt || '',
            alternativeFirstMessage: node.alternativeFirstMessage || [],
            inChatName: node.inChatName || '',
            creatorNotes: node.pageDescription || node.tagline || '',
        }
    };
}

/**
 * Transform Character Tavern card to SillyTavern import format
 * @param {Object} card - BotBrowser card format
 * @returns {Object} SillyTavern character format
 */
export function transformFullCharacterTavernCard(card) {
    const raw = card._rawData || {};
    const creator = getCharacterTavernCreator(card);
    const imageUrl = card.avatar_url || card.image_url || getCharacterTavernImageUrl(card.path || card.fullPath);
    const characterBook = card.character_book || card.characterBook || null;
    const alternateGreetings = Array.isArray(card.alternate_greetings)
        ? card.alternate_greetings
        : Array.isArray(card.alternativeFirstMessage)
        ? card.alternativeFirstMessage
        : (Array.isArray(raw.alternativeFirstMessage) ? raw.alternativeFirstMessage : []);
    const creatorNotes = card.creator_notes
        || card.pageDescription
        || card.website_description
        || raw.creatorNotes
        || card.tagline
        || '';

    return {
        id: card.id || '',
        name: card.name,
        creator,
        avatar_url: imageUrl,
        image_url: imageUrl,
        gallery_images: imageUrl ? [imageUrl] : [],
        description: card.definition_character_description || card.description || raw.characterDefinition || '',
        personality: card.definition_personality || card.personality || raw.characterPersonality || '',
        scenario: card.definition_scenario || card.scenario || raw.characterScenario || '',
        first_mes: card.definition_first_message || card.first_mes || card.first_message || raw.characterFirstMessage || '',
        first_message: card.definition_first_message || card.first_mes || card.first_message || raw.characterFirstMessage || '',
        mes_example: card.definition_example_messages || card.mes_example || raw.characterExampleMessages || '',
        system_prompt: card.definition_system_prompt || card.system_prompt || raw.characterSystemPrompt || '',
        post_history_instructions: card.definition_post_history_prompt || card.post_history_instructions || raw.characterPostHistoryPrompt || '',
        alternate_greetings: alternateGreetings,
        creator_notes: creatorNotes,
        tags: card.tags || [],
        created_at: normalizeCtDate(card.createdAt),
        updated_at: normalizeCtDate(card.lastUpdatedAt || card.lastUpdateAt),
        visibility: card.visibility || '',
        versionId: card.versionId || '',
        ownerCTId: card.ownerCTId || '',
        analytics_views: card.analytics_views || card.views || 0,
        analytics_downloads: card.analytics_downloads || card.downloads || 0,
        analytics_messages: card.analytics_messages || card.messages || 0,
        tokenTotal: card.tokenTotal || card.totalTokens || 0,
        tokenDescription: card.tokenDescription || 0,
        tokenPersonality: card.tokenPersonality || 0,
        tokenScenario: card.tokenScenario || 0,
        tokenMesExample: card.tokenMesExample || 0,
        tokenFirstMes: card.tokenFirstMes || 0,
        tokenSystemPrompt: card.tokenSystemPrompt || 0,
        tokenPostHistoryInstructions: card.tokenPostHistoryInstructions || 0,
        character_version: '',
        extensions: {
            talkativeness: '0.5',
            fav: false,
            world: '',
            depth_prompt: {
                prompt: '',
                depth: 4
            }
        },
        // Additional metadata
        lorebook: card.lorebook || undefined,
        character_book: characterBook || undefined
    };
}

/**
 * Reset pagination state
 */
export function resetCharacterTavernState() {
    characterTavernApiState.page = 1;
    characterTavernApiState.hasMore = true;
    characterTavernApiState.isLoading = false;
    characterTavernApiState.totalHits = 0;
    characterTavernApiState.totalPages = 1;
    characterTavernApiState.lastSearch = '';
    characterTavernApiState.lastSort = '';
}
