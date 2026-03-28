import { extension_settings } from '../../../../../scripts/extensions.js';
import { saveSettingsDebounced, getRequestHeaders, callPopup } from '../../../../../script.js';
import { SECRET_KEYS, writeSecret, findSecret, readSecretState, secret_state } from '../../../../../scripts/secrets.js';

// Import rotateSecret if available (added in newer SillyTavern versions)
let rotateSecret = null;
let deleteSecret = null;
try {
    const secretsModule = await import('../../../../../scripts/secrets.js');
    rotateSecret = secretsModule.rotateSecret || null;
    deleteSecret = secretsModule.deleteSecret || null;
} catch (e) {
    console.log('Optional secrets helpers are not available in this SillyTavern version');
}
import { oai_settings } from '../../../../../scripts/openai.js';

// 扩展名称
const MODULE_NAME = 'api-config-manager';

const CHAT_COMPLETION_SOURCES = {
    CUSTOM: 'custom',
    MAKERSUITE: 'makersuite',
};

const SOURCE_LABELS = {
    [CHAT_COMPLETION_SOURCES.CUSTOM]: 'Custom (OpenAI兼容)',
    [CHAT_COMPLETION_SOURCES.MAKERSUITE]: 'Google AI Studio',
};

const SOURCE_MODEL_SELECTORS = {
    [CHAT_COMPLETION_SOURCES.CUSTOM]: '#model_custom_select',
    [CHAT_COMPLETION_SOURCES.MAKERSUITE]: '#model_google_select',
};

const SOURCE_MODEL_SETTING_KEYS = {
    [CHAT_COMPLETION_SOURCES.CUSTOM]: 'custom_model',
    [CHAT_COMPLETION_SOURCES.MAKERSUITE]: 'google_model',
};

const SOURCE_SECRET_KEYS = {
    [CHAT_COMPLETION_SOURCES.CUSTOM]: SECRET_KEYS.CUSTOM,
    [CHAT_COMPLETION_SOURCES.MAKERSUITE]: SECRET_KEYS.MAKERSUITE,
};

const STORED_SECRET_KEYS = {
    [CHAT_COMPLETION_SOURCES.CUSTOM]: `${MODULE_NAME}_custom_api_key`,
    [CHAT_COMPLETION_SOURCES.MAKERSUITE]: `${MODULE_NAME}_makersuite_api_key`,
    MAKERSUITE_PROXY_PASSWORD: `${MODULE_NAME}_makersuite_proxy_password`,
};

const LIST_SORT_MODES = {
    GROUP: 'group',
    USAGE: 'usage',
    NAME: 'name',
};

const USAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_USAGE_EVENTS = 2000;
const MOBILE_LAYOUT_MAX_WIDTH = 720;
const MOBILE_PANES = {
    LIST: 'list',
    EDITOR: 'editor',
};

const AUTO_GROUP_HOST_SKIP = new Set([
    'api',
    'www',
    'gateway',
    'proxy',
    'service',
    'chat',
    'llm',
    'openai',
]);

const AUTO_GROUP_TLD_SKIP = new Set([
    'com',
    'cn',
    'net',
    'org',
    'io',
    'ai',
    'co',
    'dev',
    'app',
    'top',
    'vip',
    'pro',
    'site',
    'cloud',
    'art',
]);

const OPTIONS_MENU_SELECTOR = '#options .options-content';
const OPTIONS_MENU_ITEM_ID = 'option_api_config_manager';
const INLINE_API_ENTRY_ID = 'api_config_manager_inline_entry';
const INLINE_API_ENTRY_OPEN_BTN_ID = 'api_config_manager_inline_open';
const INLINE_API_LEGACY_SAVE_BTN_ID = 'api-config-legacy-save';
const INLINE_API_LEGACY_CANCEL_BTN_ID = 'api-config-legacy-cancel';
const INLINE_API_LEGACY_LIST_ID = 'api-config-legacy-list';
const INLINE_API_LEGACY_SORT_BTN_ID = 'api-config-legacy-sort-toggle';
const INLINE_API_LEGACY_VISIBLE_COUNT_ID = 'api-config-legacy-visible-count';

// 扩展信息
const EXTENSION_INFO = {
    name: 'API配置管理器',
    version: '1.3.1',
    author: 'Lorenzzz-Elio',
    repository: 'https://github.com/Lorenzzz-Elio/api-config-manager'
};

// 默认设置
function createDefaultSettings() {
    return {
        configs: [],
        collapsedGroups: {},
        listSortMode: LIST_SORT_MODES.GROUP,
        lastAppliedSignature: null,
        usageHistory: [],
        legacyVisibleCount: 6,
    };
}

// 编辑状态
let editingIndex = -1;
let activePopupContent = null;
let mobilePaneMode = MOBILE_PANES.LIST;
let legacyEditingIndex = -1;
let applyOperationCounter = 0;

async function findExistingSecretIdByValue(key, value) {
    const secrets = Array.isArray(secret_state?.[key]) ? secret_state[key] : [];

    for (const secret of secrets) {
        if (!secret?.id) continue;
        if (typeof secret.value === 'string' && secret.value === value) {
            return secret.id;
        }
    }

    // If secret values are masked, trying to read every entry would be very slow.
    // Only attempt server-side reads if we can read at least one secret value.
    const probeId = secrets.find(s => s?.id)?.id;
    if (!probeId) return null;
    const probeValue = await findSecret(key, probeId);
    if (!probeValue) return null;

    for (const secret of secrets) {
        if (!secret?.id) continue;
        const realValue = await findSecret(key, secret.id);
        if (realValue && realValue === value) {
            return secret.id;
        }
    }

    return null;
}

async function ensureSecretActive(key, value, label) {
    if (!value) return null;

    await ensureSecretStateLoaded();

    const existingId = await findExistingSecretIdByValue(key, value);
    if (existingId) {
        if (rotateSecret) {
            await rotateSecret(key, existingId);
        }
        return existingId;
    }

    return await writeSecret(key, value, label);
}

async function ensureSecretStateLoaded() {
    if (!secret_state || Object.keys(secret_state).length === 0) {
        await readSecretState();
    }
}

function getSecretsForKey(key) {
    return Array.isArray(secret_state?.[key]) ? secret_state[key] : [];
}

function getActiveSecretId(key) {
    const activeSecret = getSecretsForKey(key).find(secret => secret?.active);
    return activeSecret?.id || null;
}

async function rotateSecretById(key, id) {
    if (!key || !id || !rotateSecret) return false;

    await ensureSecretStateLoaded();
    const hasSecret = getSecretsForKey(key).some(secret => secret?.id === id);
    if (!hasSecret) return false;

    await rotateSecret(key, id);
    await ensureSecretStateLoaded();
    return true;
}

async function deleteSecretById(key, id) {
    if (!key || !id || !deleteSecret) return;
    try {
        await deleteSecret(key, id);
    } catch (error) {
        console.warn(`Failed to delete temporary secret for ${key}:`, error);
    } finally {
        await ensureSecretStateLoaded();
    }
}

function getStoredApiSecretKey(source) {
    return STORED_SECRET_KEYS[normalizeSource(source)] || STORED_SECRET_KEYS[CHAT_COMPLETION_SOURCES.CUSTOM];
}

function getRuntimeApiSecretKey(source) {
    return SOURCE_SECRET_KEYS[normalizeSource(source)] || SOURCE_SECRET_KEYS[CHAT_COMPLETION_SOURCES.CUSTOM];
}

function ensureSecretIdsObject(config) {
    if (!config || typeof config !== 'object') return {};
    if (!config.secretIds || typeof config.secretIds !== 'object' || Array.isArray(config.secretIds)) {
        config.secretIds = {};
    }
    return config.secretIds;
}

function setConfigSecretId(config, secretKey, id) {
    if (!config || typeof config !== 'object' || !secretKey) return;

    const secretIds = ensureSecretIdsObject(config);
    if (id) {
        secretIds[secretKey] = id;
    } else {
        delete secretIds[secretKey];
    }

    if (Object.keys(secretIds).length === 0) {
        config.secretIds = undefined;
    }
}

function getLegacyRuntimeSecretId(config, source) {
    if (!config || typeof config !== 'object') return null;
    const normalized = normalizeSource(source);
    const runtimeKey = getRuntimeApiSecretKey(normalized);

    if (config.secretIds && typeof config.secretIds === 'object' && config.secretIds[runtimeKey]) {
        return config.secretIds[runtimeKey];
    }

    if (normalized === CHAT_COMPLETION_SOURCES.CUSTOM && config.secretId) {
        return config.secretId;
    }

    return null;
}

function getStoredSourceSecretId(config, source) {
    if (!config || typeof config !== 'object') return null;
    const storedKey = getStoredApiSecretKey(source);
    if (config.secretIds && typeof config.secretIds === 'object' && config.secretIds[storedKey]) {
        return config.secretIds[storedKey];
    }
    return getLegacyRuntimeSecretId(config, source);
}

function getStoredProxyPasswordSecretId(config) {
    if (!config || typeof config !== 'object') return null;
    if (config.secretIds && typeof config.secretIds === 'object' && config.secretIds[STORED_SECRET_KEYS.MAKERSUITE_PROXY_PASSWORD]) {
        return config.secretIds[STORED_SECRET_KEYS.MAKERSUITE_PROXY_PASSWORD];
    }
    return null;
}

function clearLegacySecretReferences(config, source) {
    if (!config || typeof config !== 'object') return;

    const runtimeKey = getRuntimeApiSecretKey(source);
    if (config.secretIds && typeof config.secretIds === 'object') {
        delete config.secretIds[runtimeKey];
        if (Object.keys(config.secretIds).length === 0) {
            config.secretIds = undefined;
        }
    }

    if (normalizeSource(source) === CHAT_COMPLETION_SOURCES.CUSTOM) {
        config.secretId = undefined;
    }
}

async function readConfigSecretValue(secretKey, secretId) {
    if (!secretKey || !secretId) return '';
    try {
        const value = await findSecret(secretKey, secretId);
        return String(value || '').trim();
    } catch {
        return '';
    }
}

async function readStoredSourceSecretValue(config, source) {
    if (!config || typeof config !== 'object') return '';

    const normalized = normalizeSource(source);
    const storedKey = getStoredApiSecretKey(normalized);
    const storedId = config.secretIds?.[storedKey];
    if (storedId) {
        const storedValue = await readConfigSecretValue(storedKey, storedId);
        if (storedValue) return storedValue;
    }

    const legacyRuntimeId = getLegacyRuntimeSecretId(config, normalized);
    if (legacyRuntimeId) {
        const legacyValue = await readConfigSecretValue(getRuntimeApiSecretKey(normalized), legacyRuntimeId);
        if (legacyValue) return legacyValue;
    }

    return String(config.key || '').trim();
}

async function readStoredProxyPasswordValue(config) {
    if (!config || typeof config !== 'object') return '';

    const storedId = getStoredProxyPasswordSecretId(config);
    if (storedId) {
        const storedValue = await readConfigSecretValue(STORED_SECRET_KEYS.MAKERSUITE_PROXY_PASSWORD, storedId);
        if (storedValue) return storedValue;
    }

    return String(config.proxyPassword || '').trim();
}

async function storeConfigSecretValue(secretKey, value, label) {
    const normalizedValue = String(value || '').trim();
    if (!secretKey || !normalizedValue) return null;

    await ensureSecretStateLoaded();

    const existingId = await findExistingSecretIdByValue(secretKey, normalizedValue);
    if (existingId) {
        return existingId;
    }

    const secretId = await writeSecret(secretKey, normalizedValue, label);
    await ensureSecretStateLoaded();
    return secretId;
}

async function persistConfigSecrets(config, previousConfig = null) {
    if (!config || typeof config !== 'object') return false;

    const normalized = normalizeSource(config.source);
    const sameSourceAsPrevious = normalizeSource(previousConfig?.source) === normalized;
    let mutated = false;

    const storedApiKey = getStoredApiSecretKey(normalized);
    const rawApiKey = String(config.key || '').trim();
    const preservedApiValue = sameSourceAsPrevious ? await readStoredSourceSecretValue(previousConfig, normalized) : '';
    const nextApiSecretId = rawApiKey
        ? await storeConfigSecretValue(storedApiKey, rawApiKey, `ACM: ${config.name || getSourceLabel(normalized)}`)
        : (preservedApiValue
            ? await storeConfigSecretValue(storedApiKey, preservedApiValue, `ACM: ${config.name || getSourceLabel(normalized)}`)
            : null);

    setConfigSecretId(config, storedApiKey, nextApiSecretId);
    clearLegacySecretReferences(config, normalized);
    if (config.key !== undefined) {
        config.key = undefined;
        mutated = true;
    }

    if (normalized === CHAT_COMPLETION_SOURCES.MAKERSUITE) {
        const rawProxyPassword = String(config.proxyPassword || '').trim();
        const preservedProxyValue = sameSourceAsPrevious ? await readStoredProxyPasswordValue(previousConfig) : '';
        const nextProxySecretId = rawProxyPassword
            ? await storeConfigSecretValue(
                STORED_SECRET_KEYS.MAKERSUITE_PROXY_PASSWORD,
                rawProxyPassword,
                `ACM Proxy: ${config.name || getSourceLabel(normalized)}`
            )
            : (preservedProxyValue
                ? await storeConfigSecretValue(
                    STORED_SECRET_KEYS.MAKERSUITE_PROXY_PASSWORD,
                    preservedProxyValue,
                    `ACM Proxy: ${config.name || getSourceLabel(normalized)}`
                )
                : null);

        setConfigSecretId(config, STORED_SECRET_KEYS.MAKERSUITE_PROXY_PASSWORD, nextProxySecretId);
        if (config.proxyPassword !== undefined) {
            config.proxyPassword = undefined;
            mutated = true;
        }
    } else {
        if (getStoredProxyPasswordSecretId(config)) {
            setConfigSecretId(config, STORED_SECRET_KEYS.MAKERSUITE_PROXY_PASSWORD, null);
            mutated = true;
        }
        if (config.proxyPassword !== undefined) {
            config.proxyPassword = undefined;
            mutated = true;
        }
    }

    if (nextApiSecretId || rawApiKey) {
        mutated = true;
    }

    return mutated;
}

async function activateSourceSecretValue(source, configName, value) {
    const runtimeKey = getRuntimeApiSecretKey(source);
    if (!runtimeKey || !value) return null;
    return await ensureSecretActive(runtimeKey, value, `ACM: ${configName || getSourceLabel(source)}`);
}

async function withTemporarySourceSecret(source, value, config, task) {
    const runtimeKey = getRuntimeApiSecretKey(source);
    if (!runtimeKey) {
        return await task();
    }

    const normalizedValue = String(value || '').trim() || await readStoredSourceSecretValue(config, source);
    if (!normalizedValue) {
        return await task();
    }

    await ensureSecretStateLoaded();

    const previousActiveId = getActiveSecretId(runtimeKey);
    let targetSecretId = null;
    let tempSecretId = null;

    if (previousActiveId) {
        const existingId = await findExistingSecretIdByValue(runtimeKey, normalizedValue);
        targetSecretId = existingId || await writeSecret(runtimeKey, normalizedValue, 'ACM: Temporary runtime secret');
        tempSecretId = existingId ? null : targetSecretId;
    } else {
        targetSecretId = await writeSecret(runtimeKey, normalizedValue, 'ACM: Temporary runtime secret');
        tempSecretId = targetSecretId;
    }

    await ensureSecretStateLoaded();

    if (rotateSecret && targetSecretId) {
        await rotateSecret(runtimeKey, targetSecretId);
    }

    try {
        return await task();
    } finally {
        if (previousActiveId) {
            await rotateSecretById(runtimeKey, previousActiveId);
        }
        if (tempSecretId) {
            await deleteSecretById(runtimeKey, tempSecretId);
        }
    }
}

function normalizeSource(source) {
    if (source === CHAT_COMPLETION_SOURCES.MAKERSUITE) return CHAT_COMPLETION_SOURCES.MAKERSUITE;
    return CHAT_COMPLETION_SOURCES.CUSTOM;
}

function getSourceLabel(source) {
    const normalized = normalizeSource(source);
    if (normalized !== source && source) {
        return `Unsupported (${source})`;
    }
    return SOURCE_LABELS[normalized] || SOURCE_LABELS[CHAT_COMPLETION_SOURCES.CUSTOM];
}

function normalizeGroupText(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (/^[a-z0-9][a-z0-9._-]*$/i.test(text)) {
        return text.toLowerCase();
    }
    return text;
}

function detectLeadingLatinGroupFromName(name) {
    const text = String(name || '').trim();
    if (!text) return '';
    const match = text.match(/^([A-Za-z][A-Za-z0-9]{1,31})(?=[\s\-_·/|:：]|$)/);
    return match ? normalizeGroupText(match[1]) : '';
}

function detectGroupFromEndpoint(endpoint) {
    const raw = String(endpoint || '').trim();
    if (!raw) return '';

    const withProtocol = raw.includes('://') ? raw : `https://${raw}`;
    let hostname = '';
    try {
        hostname = new URL(withProtocol).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        return '';
    }

    const parts = hostname.split('.').filter(Boolean);
    if (parts.length === 0) return '';

    for (const part of parts) {
        if (AUTO_GROUP_HOST_SKIP.has(part)) continue;
        if (AUTO_GROUP_TLD_SKIP.has(part)) continue;
        if (part.length < 2) continue;
        return normalizeGroupText(part);
    }

    if (parts.length >= 2) {
        return normalizeGroupText(parts[parts.length - 2]);
    }

    return normalizeGroupText(parts[0]);
}

function detectGroupFromName(name) {
    const leadingLatinGroup = detectLeadingLatinGroupFromName(name);
    if (leadingLatinGroup) return leadingLatinGroup;

    const text = String(name || '').trim();
    if (!text) return '';

    const separators = ['-', '_', '·', '/', '|', '：', ':', ' '];
    let splitIndex = -1;
    for (const separator of separators) {
        const index = text.indexOf(separator);
        if (index > 1 && (splitIndex === -1 || index < splitIndex)) {
            splitIndex = index;
        }
    }

    if (splitIndex > 1) {
        const candidate = text.slice(0, splitIndex).trim();
        if (candidate.length >= 2) return normalizeGroupText(candidate);
    }

    const firstToken = text.split(/\s+/).find(Boolean);
    if (firstToken && firstToken.length >= 2) {
        return normalizeGroupText(firstToken);
    }

    return '';
}

function detectAutoGroup({ name, source, customUrl, reverseProxy }) {
    const nameGroup = detectGroupFromName(name);
    if (nameGroup) return nameGroup;

    const normalizedSource = normalizeSource(source);
    const endpoint = normalizedSource === CHAT_COMPLETION_SOURCES.CUSTOM ? customUrl : reverseProxy;
    const endpointGroup = detectGroupFromEndpoint(endpoint);
    if (endpointGroup) return endpointGroup;

    return normalizedSource === CHAT_COMPLETION_SOURCES.MAKERSUITE ? 'Google' : 'Custom';
}

function getConfigGroup(config) {
    if (!config || typeof config !== 'object') return '';
    const manualGroup = String(config.group || '').trim();
    if (manualGroup) return manualGroup;
    return detectAutoGroup({
        name: config.name,
        source: config.source,
        customUrl: typeof config.customUrl === 'string' ? config.customUrl : config.url,
        reverseProxy: config.reverseProxy,
    });
}

function getListSortMode() {
    const mode = extension_settings?.[MODULE_NAME]?.listSortMode;
    return Object.values(LIST_SORT_MODES).includes(mode) ? mode : LIST_SORT_MODES.GROUP;
}

function normalizeLegacyVisibleCount(value) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return 6;
    return Math.min(20, Math.max(2, parsed));
}

function getLegacyVisibleCount() {
    return normalizeLegacyVisibleCount(extension_settings?.[MODULE_NAME]?.legacyVisibleCount);
}

function setLegacyVisibleCount(value) {
    extension_settings[MODULE_NAME].legacyVisibleCount = normalizeLegacyVisibleCount(value);
    saveSettingsDebounced();
}

function updateLegacyListViewportHeight() {
    const container = $(`#${INLINE_API_LEGACY_LIST_ID}`);
    if (!container.length) return;

    const visibleCount = getLegacyVisibleCount();
    const firstItem = container.children('.api-config-legacy-item').first();
    const estimatedItemHeight = firstItem.length ? Math.ceil(firstItem.outerHeight(true)) : 150;
    const maxHeight = Math.max(260, estimatedItemHeight * visibleCount + 12);

    container.css('max-height', `${maxHeight}px`);
}

function updateSortToggleButtons() {
    const sortMode = getListSortMode();
    const buttonLabelMap = {
        [LIST_SORT_MODES.GROUP]: '按组排列',
        [LIST_SORT_MODES.USAGE]: '按习惯排列',
        [LIST_SORT_MODES.NAME]: '按名称排列',
    };
    const nextModeMap = {
        [LIST_SORT_MODES.GROUP]: LIST_SORT_MODES.USAGE,
        [LIST_SORT_MODES.USAGE]: LIST_SORT_MODES.NAME,
        [LIST_SORT_MODES.NAME]: LIST_SORT_MODES.GROUP,
    };
    const currentLabel = buttonLabelMap[sortMode] || '按组排列';
    const nextLabel = buttonLabelMap[nextModeMap[sortMode]] || '按组排列';

    const buttons = $(`#api-config-sort-toggle, #${INLINE_API_LEGACY_SORT_BTN_ID}`);
    buttons.each(function () {
        const btn = $(this);
        btn
            .toggleClass('is-group', sortMode === LIST_SORT_MODES.GROUP)
            .toggleClass('is-usage', sortMode === LIST_SORT_MODES.USAGE)
            .text(currentLabel)
            .attr('title', `当前${currentLabel}，点击切换为${nextLabel}`);
    });
}

function getModelSelectSelector(source) {
    return SOURCE_MODEL_SELECTORS[normalizeSource(source)] || SOURCE_MODEL_SELECTORS[CHAT_COMPLETION_SOURCES.CUSTOM];
}

function buildConfigRuntimeSignature(config, sourceOverride = null, overrides = {}) {
    const source = normalizeSource(sourceOverride ?? overrides.source ?? config?.source);
    return {
        source,
        endpoint: String(overrides.endpoint ?? (getConfigEndpointValue(config, source) || '')).trim(),
        model: String(overrides.model ?? (config?.model || '')).trim(),
        name: String(overrides.name ?? (config?.name || '')).trim(),
    };
}

function isCurrentApplyOperation(operationId) {
    return operationId === applyOperationCounter;
}

function isRuntimeSnapshotCompatible(signature) {
    if (!signature || typeof signature !== 'object') return true;
    const current = getCurrentRuntimeConnectionSnapshot();
    return normalizeSource(signature.source) === current.source
        && String(signature.endpoint || '').trim() === String(current.endpoint || '').trim();
}

function getCurrentRuntimeConnectionSnapshot() {
    const sourceFromUi = $('#chat_completion_source').val();
    const sourceFromSettings = typeof oai_settings !== 'undefined' ? oai_settings?.chat_completion_source : null;
    const source = normalizeSource(sourceFromUi || sourceFromSettings);

    const customEndpoint = String(
        $('#custom_api_url_text').val() || (typeof oai_settings !== 'undefined' ? oai_settings?.custom_url : '') || ''
    ).trim();
    const reverseProxy = String(
        $('#openai_reverse_proxy').val() || (typeof oai_settings !== 'undefined' ? oai_settings?.reverse_proxy : '') || ''
    ).trim();
    const endpoint = source === CHAT_COMPLETION_SOURCES.CUSTOM ? customEndpoint : reverseProxy;

    const selectorModel = String($(getModelSelectSelector(source)).val() || '').trim();
    const modelSettingKey = SOURCE_MODEL_SETTING_KEYS[source];
    const settingsModel =
        typeof oai_settings !== 'undefined' && modelSettingKey
            ? String(oai_settings?.[modelSettingKey] || '').trim()
            : '';

    return {
        source,
        endpoint,
        model: selectorModel || settingsModel,
    };
}

function isSameConfigSignature(a, b) {
    if (!a || !b) return false;
    return normalizeSource(a.source) === normalizeSource(b.source)
        && String(a.endpoint || '').trim() === String(b.endpoint || '').trim()
        && String(a.model || '').trim() === String(b.model || '').trim()
        && String(a.name || '').trim() === String(b.name || '').trim();
}

function hasConfigMatchingSignature(configs, signature) {
    if (!signature || !Array.isArray(configs)) return false;
    return configs.some(config => isSameConfigSignature(buildConfigRuntimeSignature(config), signature));
}

function normalizeUsageHistory(history, now = Date.now()) {
    const cutoff = now - USAGE_WINDOW_MS;
    const normalized = [];
    if (!Array.isArray(history)) return normalized;

    for (const item of history) {
        if (!item || typeof item !== 'object') continue;
        const ts = Number(item.ts);
        if (!Number.isFinite(ts) || ts < cutoff) continue;
        const signature = item.signature;
        if (!signature || typeof signature !== 'object') continue;
        normalized.push({
            ts,
            signature: {
                source: normalizeSource(signature.source),
                endpoint: String(signature.endpoint || '').trim(),
                model: String(signature.model || '').trim(),
                name: String(signature.name || '').trim(),
            },
        });
    }

    if (normalized.length > MAX_USAGE_EVENTS) {
        return normalized.slice(normalized.length - MAX_USAGE_EVENTS);
    }

    return normalized;
}

function getUsageHistory() {
    const state = extension_settings?.[MODULE_NAME];
    return Array.isArray(state?.usageHistory) ? state.usageHistory : [];
}

function getConfigUsageScore(config, now = Date.now(), history = getUsageHistory()) {
    const signature = buildConfigRuntimeSignature(config);
    const cutoff = now - USAGE_WINDOW_MS;
    let score = 0;
    for (const item of history) {
        if (!item || typeof item !== 'object') continue;
        if (Number(item.ts) < cutoff) continue;
        if (isSameConfigSignature(item.signature, signature)) {
            score += 1;
        }
    }
    return score;
}

function findActiveConfigIndex(configs) {
    if (!Array.isArray(configs) || configs.length === 0) return -1;

    const current = getCurrentRuntimeConnectionSnapshot();
    const lastApplied = extension_settings?.[MODULE_NAME]?.lastAppliedSignature;
    const candidates = [];

    configs.forEach((config, index) => {
        const signature = buildConfigRuntimeSignature(config);
        if (signature.source !== current.source) return;
        const endpointMatches = signature.endpoint === current.endpoint
            || (
                signature.source === CHAT_COMPLETION_SOURCES.CUSTOM
                && !signature.endpoint
                && lastApplied
                && String(lastApplied.name || '').trim() === String(signature.name || '').trim()
                && String(lastApplied.endpoint || '').trim() === String(current.endpoint || '').trim()
            );
        if (!endpointMatches) return;

        let score = 1;
        if (signature.model && current.model && signature.model === current.model) {
            score += 2;
        }
        if (lastApplied && isSameConfigSignature(signature, lastApplied)) {
            score += 3;
        }
        candidates.push({ index, score });
    });

    if (candidates.length > 0) {
        candidates.sort((a, b) => (b.score - a.score) || (a.index - b.index));
        return candidates[0].index;
    }

    if (lastApplied) {
        const matchedByLastApplied = configs.findIndex(config => isSameConfigSignature(buildConfigRuntimeSignature(config), lastApplied));
        if (matchedByLastApplied >= 0) return matchedByLastApplied;
    }

    return -1;
}

function setChatCompletionSource(source) {
    const normalized = normalizeSource(source);
    $('#chat_completion_source').val(normalized).trigger('change');
    if (typeof oai_settings !== 'undefined') {
        oai_settings.chat_completion_source = normalized;
    }
}

function setReverseProxyFields(reverseProxy, proxyPassword) {
    if (reverseProxy !== undefined) {
        $('#openai_reverse_proxy').val(reverseProxy ?? '').trigger('input');
        if (typeof oai_settings !== 'undefined') {
            oai_settings.reverse_proxy = reverseProxy ?? '';
        }
    }

    if (proxyPassword !== undefined) {
        $('#openai_proxy_password').val(proxyPassword ?? '').trigger('input');
        if (typeof oai_settings !== 'undefined') {
            oai_settings.proxy_password = proxyPassword ?? '';
        }
    }
}

function buildStatusRequestData(source, { customUrl = '', reverseProxy = '', proxyPassword = '' } = {}) {
    const normalized = normalizeSource(source);
    const requestData = {
        chat_completion_source: normalized,
        reverse_proxy: String(reverseProxy || '').trim(),
        proxy_password: String(proxyPassword || '').trim(),
    };

    if (normalized === CHAT_COMPLETION_SOURCES.CUSTOM) {
        requestData.custom_url = String(customUrl || '').trim();
    }

    return requestData;
}

async function requestConnectionStatus(source, options = {}) {
    const response = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(buildStatusRequestData(source, options)),
        cache: 'no-cache',
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
}

async function verifyConnectionSettings(source, options = {}) {
    const data = await requestConnectionStatus(source, options);
    if (data?.error) {
        return {
            ok: false,
            bypass: false,
            data,
            errorMessage: 'API连接失败，请检查配置是否正确',
        };
    }

    return {
        ok: true,
        bypass: Boolean(data?.bypass),
        data,
        errorMessage: '',
    };
}

function pushUsageSignature(signature) {
    const now = Date.now();
    const usageHistory = normalizeUsageHistory(extension_settings[MODULE_NAME].usageHistory, now);
    usageHistory.push({ ts: now, signature });
    if (usageHistory.length > MAX_USAGE_EVENTS) {
        usageHistory.splice(0, usageHistory.length - MAX_USAGE_EVENTS);
    }
    extension_settings[MODULE_NAME].usageHistory = usageHistory;
}

function recordSuccessfulApply(signature) {
    extension_settings[MODULE_NAME].lastAppliedSignature = signature;
    pushUsageSignature(signature);
    saveSettingsDebounced();
    renderConfigList();
}

function getCurrentCustomEndpoint() {
    return String(
        $('#custom_api_url_text').val() || (typeof oai_settings !== 'undefined' ? oai_settings?.custom_url : '') || ''
    ).trim();
}

function getResolvedCustomUrlForApply(config) {
    const savedUrl = String((typeof config?.customUrl === 'string' ? config.customUrl : config?.url) || '').trim();
    if (savedUrl) {
        return { value: savedUrl, inherited: false };
    }

    const currentUrl = getCurrentCustomEndpoint();
    if (currentUrl) {
        return { value: currentUrl, inherited: true };
    }

    return { value: '', inherited: false };
}

// 初始化扩展设置
async function initSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = createDefaultSettings();
    }

    let migrated = false;

    // 确保configs数组存在
    if (!extension_settings[MODULE_NAME].configs) {
        extension_settings[MODULE_NAME].configs = [];
        migrated = true;
    }

    // 确保collapsedGroups对象存在
    if (!extension_settings[MODULE_NAME].collapsedGroups) {
        extension_settings[MODULE_NAME].collapsedGroups = {};
        migrated = true;
    }

    if (!Object.values(LIST_SORT_MODES).includes(extension_settings[MODULE_NAME].listSortMode)) {
        extension_settings[MODULE_NAME].listSortMode = LIST_SORT_MODES.GROUP;
        migrated = true;
    }

    if (
        extension_settings[MODULE_NAME].lastAppliedSignature !== null
        && typeof extension_settings[MODULE_NAME].lastAppliedSignature !== 'object'
    ) {
        extension_settings[MODULE_NAME].lastAppliedSignature = null;
        migrated = true;
    }

    if (!Array.isArray(extension_settings[MODULE_NAME].usageHistory)) {
        extension_settings[MODULE_NAME].usageHistory = [];
        migrated = true;
    } else {
        const normalizedHistory = normalizeUsageHistory(extension_settings[MODULE_NAME].usageHistory);
        if (normalizedHistory.length !== extension_settings[MODULE_NAME].usageHistory.length) {
            extension_settings[MODULE_NAME].usageHistory = normalizedHistory;
            migrated = true;
        }
    }

    const normalizedLegacyVisibleCount = normalizeLegacyVisibleCount(extension_settings[MODULE_NAME].legacyVisibleCount);
    if (normalizedLegacyVisibleCount !== extension_settings[MODULE_NAME].legacyVisibleCount) {
        extension_settings[MODULE_NAME].legacyVisibleCount = normalizedLegacyVisibleCount;
        migrated = true;
    }

    // 兼容旧配置结构
    for (const config of extension_settings[MODULE_NAME].configs) {
        if (!config || typeof config !== 'object') continue;

        if (!config.source) {
            config.source = CHAT_COMPLETION_SOURCES.CUSTOM;
            migrated = true;
        }

        if (config.source === CHAT_COMPLETION_SOURCES.CUSTOM) {
            if (config.customUrl === undefined && typeof config.url === 'string') {
                config.customUrl = config.url;
                migrated = true;
            }
            if (typeof config.customUrl === 'string' && config.url !== config.customUrl) {
                config.url = config.customUrl;
                migrated = true;
            }
        }

        if (!String(config.group || '').trim()) {
            const autoGroup = detectAutoGroup({
                name: config.name,
                source: config.source,
                customUrl: config.customUrl || config.url,
                reverseProxy: config.reverseProxy,
            });
            if (autoGroup) {
                config.group = autoGroup;
                migrated = true;
            }
        }

        if (await persistConfigSecrets(config, config)) {
            migrated = true;
        }
    }

    const lastAppliedSignature = extension_settings[MODULE_NAME].lastAppliedSignature;
    if (lastAppliedSignature && !hasConfigMatchingSignature(extension_settings[MODULE_NAME].configs, lastAppliedSignature)) {
        extension_settings[MODULE_NAME].lastAppliedSignature = null;
        migrated = true;
    }

    if (migrated) {
        saveSettingsDebounced();
    }
}

// 获取当前API配置
async function getCurrentApiConfig() {
    const url = $('#custom_api_url_text').val() || '';
    // 从secrets系统获取密钥
    const key = secret_state[SECRET_KEYS.CUSTOM] ? await findSecret(SECRET_KEYS.CUSTOM) : '';
    return { url, key };
}

// 应用配置到表单
async function applyConfig(config) {
    try {
        if (!$('#api_button_openai').length || !$('#chat_completion_source').length) {
            throw new Error('未找到API连接界面元素，请在OpenAI/Chat Completions设置页使用此扩展');
        }

        const rawSource = typeof config?.source === 'string' ? config.source : CHAT_COMPLETION_SOURCES.CUSTOM;
        if (rawSource && ![CHAT_COMPLETION_SOURCES.CUSTOM, CHAT_COMPLETION_SOURCES.MAKERSUITE].includes(rawSource)) {
            toastr.error(`该配置的来源“${rawSource}”已不再受此扩展支持，请编辑配置并改为Custom/Google AI Studio`, 'API配置管理器');
            return;
        }

        const source = normalizeSource(rawSource);
        const operationId = ++applyOperationCounter;
        let resolvedEndpoint = '';
        let resolvedProxyPassword = '';
        let shouldPersistInheritedCustomUrl = false;

        setChatCompletionSource(source);

        if (source === CHAT_COMPLETION_SOURCES.CUSTOM) {
            const resolvedCustomUrl = getResolvedCustomUrlForApply(config);
            if (!resolvedCustomUrl.value) {
                throw new Error('Custom配置缺少URL，且当前连接页没有可继承的Custom URL');
            }

            resolvedEndpoint = resolvedCustomUrl.value;
            shouldPersistInheritedCustomUrl = resolvedCustomUrl.inherited;
            $('#custom_api_url_text').val(resolvedEndpoint).trigger('input');
            if (typeof oai_settings !== 'undefined') {
                oai_settings.custom_url = resolvedEndpoint;
            }
        } else {
            resolvedEndpoint = String(config.reverseProxy || '').trim();
            resolvedProxyPassword = await readStoredProxyPasswordValue(config);
            setReverseProxyFields(resolvedEndpoint, resolvedProxyPassword);
        }

        const storedApiKey = await readStoredSourceSecretValue(config, source);
        if (storedApiKey) {
            await activateSourceSecretValue(source, config.name, storedApiKey);
        }

        const appliedSignature = buildConfigRuntimeSignature(config, source, { endpoint: resolvedEndpoint });

        toastr.info(`正在连接到: ${config.name}（${getSourceLabel(source)}）`, 'API配置管理器');
        $('#api_button_openai').trigger('click');

        const verification = await verifyConnectionSettings(source, {
            customUrl: source === CHAT_COMPLETION_SOURCES.CUSTOM ? resolvedEndpoint : '',
            reverseProxy: source === CHAT_COMPLETION_SOURCES.MAKERSUITE ? resolvedEndpoint : '',
            proxyPassword: resolvedProxyPassword,
        });

        if (!isCurrentApplyOperation(operationId)) {
            return;
        }

        if (!verification.ok) {
            renderConfigList();
            toastr.error(verification.errorMessage, 'API配置管理器');
            return;
        }

        if (shouldPersistInheritedCustomUrl) {
            setConfigEndpointValue(config, source, resolvedEndpoint);
            saveSettingsDebounced();
        }

        recordSuccessfulApply(appliedSignature);
        toastr.success(`已应用配置: ${config.name}（${getSourceLabel(source)}）`, 'API配置管理器');

        if (config.model) {
            setPreferredModel(config.model, config.name, source, {
                operationId,
                expectedSignature: appliedSignature,
            });
            waitForConnectionAndSetModel(config.model, config.name, source, operationId, appliedSignature);
        }

    } catch (error) {
        console.error('应用配置时出错:', error);
        toastr.error(`应用配置失败: ${error.message}`, 'API配置管理器');
    }
}

// 智能等待连接并设置模型
function waitForConnectionAndSetModel(modelName, configName, source, operationId = null, expectedSignature = null) {
    let attempts = 0;
    const maxAttempts = 20; // 最多尝试20次，每次500ms，总共10秒

    const checkConnection = () => {
        if (operationId !== null && !isCurrentApplyOperation(operationId)) return;
        if (expectedSignature && !isRuntimeSnapshotCompatible(expectedSignature)) return;

        attempts++;

        // 检查是否已连接（通过检查模型下拉列表是否有选项）
        const modelSelect = $(getModelSelectSelector(source));
        const hasModels = modelSelect.find('option').length > 1; // 除了默认选项外还有其他选项

        if (hasModels) {
            // 连接成功，设置模型
            setPreferredModel(modelName, configName, source, { operationId, expectedSignature });
            return;
        }

        if (attempts < maxAttempts) {
            // 继续等待
            setTimeout(checkConnection, 500);
        } else {
            // 超时，但仍然尝试设置模型
            setPreferredModel(modelName, configName, source, { operationId, expectedSignature });
        }
    };

    // 开始检查
    setTimeout(checkConnection, 1000); // 1秒后开始检查
}

// 设置首选模型
function setPreferredModel(modelName, configName, source, { operationId = null, expectedSignature = null } = {}) {
    try {
        if (operationId !== null && !isCurrentApplyOperation(operationId)) {
            return false;
        }
        if (expectedSignature && !isRuntimeSnapshotCompatible(expectedSignature)) {
            return false;
        }

        const normalized = normalizeSource(source);
        const normalizedModelName = String(modelName || '').trim();
        if (!normalizedModelName) {
            return false;
        }

        // 更新oai_settings
        if (typeof oai_settings !== 'undefined') {
            const settingKey = SOURCE_MODEL_SETTING_KEYS[normalized];
            if (settingKey) {
                oai_settings[settingKey] = normalizedModelName;
            }
        }

        if (normalized === CHAT_COMPLETION_SOURCES.CUSTOM) {
            $('#custom_model_id').val(normalizedModelName).trigger('input');
        }

        // 检查下拉列表中是否有该模型
        const modelSelect = $(getModelSelectSelector(normalized));
        if (!modelSelect.length) {
            toastr.info(`已设置首选模型: ${normalizedModelName}（未找到模型下拉框，连接后可用）`, 'API配置管理器');
            saveSettingsDebounced();
            return true;
        }

        const modelOption = modelSelect
            .find('option')
            .filter(function () { return String($(this).val() || '') === normalizedModelName; });

        if (modelOption.length > 0) {
            // 模型在下拉列表中，选择它
            modelSelect.val(normalizedModelName).trigger('change');
            toastr.success(`已自动选择模型: ${normalizedModelName}`, 'API配置管理器');
        } else {
            // 模型不在下拉列表中：允许手动输入的来源（尤其是Custom）可以临时注入选项以便生效
            if (modelSelect.is('select')) {
                modelSelect.append($('<option></option>').val(normalizedModelName).text(normalizedModelName));
                modelSelect.val(normalizedModelName).trigger('change');
                toastr.success(`已设置模型: ${normalizedModelName}（手动添加）`, 'API配置管理器');
            } else {
                toastr.info(`已设置首选模型: ${normalizedModelName}（模型将在连接后可用）`, 'API配置管理器');
            }
        }

        // 保存设置
        saveSettingsDebounced();
        return true;

    } catch (error) {
        console.error('设置模型时出错:', error);
        toastr.warning(`无法自动设置模型 ${modelName}，请手动选择`, 'API配置管理器');
        return false;
    }
}

// 获取可用模型列表
async function fetchAvailableModels() {
    const source = normalizeSource($('#api-config-source').val());
    const currentEditingConfig = editingIndex >= 0 ? extension_settings[MODULE_NAME].configs[editingIndex] : null;
    const editingConfig = currentEditingConfig && normalizeSource(currentEditingConfig.source) === source
        ? currentEditingConfig
        : null;

    const customUrl = String($('#api-config-url').val() || '').trim();
    const apiKey = String($('#api-config-key').val() || '').trim();
    const reverseProxy = String($('#api-config-reverse-proxy').val() || '').trim();
    let proxyPassword = String($('#api-config-proxy-password').val() || '').trim();

    if (source === CHAT_COMPLETION_SOURCES.CUSTOM && !customUrl) {
        toastr.error('请先输入Custom API URL', 'API配置管理器');
        return;
    }

    const button = $('#api-config-fetch-models');
    const originalText = button.text();
    button.text('获取中...').prop('disabled', true);

    try {
        if (!proxyPassword && reverseProxy && editingConfig && normalizeSource(editingConfig.source) === source) {
            proxyPassword = await readStoredProxyPasswordValue(editingConfig);
        }

        const data = await withTemporarySourceSecret(source, apiKey, editingConfig, async () => (
            await requestConnectionStatus(source, {
                customUrl,
                reverseProxy,
                proxyPassword,
            })
        ));

        if (data.error) {
            throw new Error('API连接失败，请检查URL和密钥是否正确');
        }

        if (data.data && Array.isArray(data.data)) {
            const modelSelect = $('#api-config-model-select');
            modelSelect.empty().append($('<option></option>').val('').text('选择模型...'));

            // 按模型ID排序
            const models = data.data.sort((a, b) => String(a?.id || '').localeCompare(String(b?.id || '')));

            models.forEach(model => {
                const modelId = String(model?.id || '').trim();
                if (!modelId) return;
                modelSelect.append($('<option></option>').val(modelId).text(modelId));
            });

            modelSelect.show();
            toastr.success(`已获取到 ${models.length} 个可用模型`, 'API配置管理器');
        } else {
            throw new Error('API返回的数据格式不正确');
        }

    } catch (error) {
        console.error('获取模型列表失败:', error);
        toastr.error(`获取模型列表失败: ${error.message}`, 'API配置管理器');
    } finally {
        button.text(originalText).prop('disabled', false);
    }
}

function getEndpointFieldLabel(source) {
    return normalizeSource(source) === CHAT_COMPLETION_SOURCES.CUSTOM ? 'URL' : '反代地址';
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getConfigEndpointValue(config, source = normalizeSource(config?.source)) {
    const normalized = normalizeSource(source);
    if (!config || typeof config !== 'object') return '';

    if (normalized === CHAT_COMPLETION_SOURCES.CUSTOM) {
        const raw = (typeof config.customUrl === 'string' ? config.customUrl : config.url) || '';
        return String(raw).trim();
    }

    if (normalized === CHAT_COMPLETION_SOURCES.MAKERSUITE) {
        return String(config.reverseProxy || '').trim();
    }

    return '';
}

function setConfigEndpointValue(config, source, endpoint) {
    if (!config || typeof config !== 'object') return;
    const normalized = normalizeSource(source);
    const value = String(endpoint || '').trim();

    if (normalized === CHAT_COMPLETION_SOURCES.CUSTOM) {
        config.customUrl = value;
        config.url = value;
    } else if (normalized === CHAT_COMPLETION_SOURCES.MAKERSUITE) {
        config.reverseProxy = value;
    }
}

function maybeSyncConfigsWithSameEndpoint(referenceIndex, previousConfig, newConfig) {
    const prevSource = normalizeSource(previousConfig?.source);
    const newSource = normalizeSource(newConfig?.source);
    if (prevSource !== newSource) return 0;

    const oldEndpoint = getConfigEndpointValue(previousConfig, prevSource);
    const nextEndpoint = getConfigEndpointValue(newConfig, newSource);
    if (oldEndpoint === nextEndpoint) return 0;

    const linkedIndexes = extension_settings[MODULE_NAME].configs
        .map((cfg, idx) => ({ cfg, idx }))
        .filter(({ cfg, idx }) =>
            idx !== referenceIndex &&
            normalizeSource(cfg?.source) === prevSource &&
            getConfigEndpointValue(cfg, prevSource) === oldEndpoint)
        .map(({ idx }) => idx);

    if (linkedIndexes.length === 0) return 0;

    const fieldLabel = getEndpointFieldLabel(prevSource);
    const oldLabel = oldEndpoint || '（空地址）';
    const nextLabel = nextEndpoint || '（空地址）';
    const shouldSync = confirm(
        `检测到还有 ${linkedIndexes.length} 个配置使用同一${fieldLabel}：\n` +
        `${oldLabel}\n\n是否将这些配置也更新为：\n${nextLabel}？`
    );

    if (!shouldSync) return 0;

    for (const idx of linkedIndexes) {
        const linkedConfig = extension_settings[MODULE_NAME].configs[idx];
        setConfigEndpointValue(linkedConfig, prevSource, nextEndpoint);
    }

    return linkedIndexes.length;
}

function showEndpointSyncToastIfNeeded(syncCount, source) {
    if (syncCount <= 0) return;
    const fieldLabel = getEndpointFieldLabel(source);
    toastr.success(`已同步更新 ${syncCount} 个同${fieldLabel}配置`, 'API配置管理器');
}

function configHasStoredApiKey(config, source) {
    const normalized = normalizeSource(source);
    return Boolean(getStoredSourceSecretId(config, normalized) || String(config?.key || '').trim());
}

function configHasStoredProxyPassword(config) {
    return Boolean(getStoredProxyPasswordSecretId(config) || String(config?.proxyPassword || '').trim());
}

function getEditorConfigForSource(source) {
    if (editingIndex < 0) return null;
    const config = extension_settings[MODULE_NAME].configs[editingIndex];
    if (!config || normalizeSource(config.source) !== normalizeSource(source)) return null;
    return config;
}

function getLegacyEditorConfigForSource(source) {
    if (legacyEditingIndex < 0) return null;
    const config = extension_settings[MODULE_NAME].configs[legacyEditingIndex];
    if (!config || normalizeSource(config.source) !== normalizeSource(source)) return null;
    return config;
}

function refreshEditorSensitivePlaceholders(sourceValue = $('#api-config-source').val()) {
    const source = normalizeSource(sourceValue);
    const config = getEditorConfigForSource(source);
    const apiKeyPlaceholder = source === CHAT_COMPLETION_SOURCES.CUSTOM
        ? (configHasStoredApiKey(config, source) ? '已保存Custom API密钥（留空保持不变）' : 'Custom API密钥 (可选)')
        : (configHasStoredApiKey(config, source) ? '已保存Google AI Studio API Key（留空保持不变）' : 'Google AI Studio API Key (可选；不填则使用酒馆已保存的密钥)');
    const proxyPasswordPlaceholder = configHasStoredProxyPassword(config)
        ? '已保存反代密码/Token（留空保持不变）'
        : '反代密码/Token (可选；反代需要时填写)';

    $('#api-config-key').attr('placeholder', apiKeyPlaceholder);
    $('#api-config-proxy-password').attr('placeholder', proxyPasswordPlaceholder);
}

function refreshLegacySensitivePlaceholders(sourceValue = $('#api-config-legacy-source').val()) {
    const source = normalizeSource(sourceValue);
    const config = getLegacyEditorConfigForSource(source);
    const apiKeyPlaceholder = source === CHAT_COMPLETION_SOURCES.CUSTOM
        ? (configHasStoredApiKey(config, source) ? '已保存Custom API密钥（留空保持不变）' : 'Custom API密钥 (可选)')
        : (configHasStoredApiKey(config, source) ? '已保存Google AI Studio API Key（留空保持不变）' : 'Google AI Studio API Key (可选；不填则使用酒馆已保存的密钥)');
    const proxyPasswordPlaceholder = configHasStoredProxyPassword(config)
        ? '已保存反代密码/Key（留空保持不变）'
        : '反代密码/Key (可选；反代需要时填写)';

    $('#api-config-legacy-key').attr('placeholder', apiKeyPlaceholder);
    $('#api-config-legacy-proxy-password').attr('placeholder', proxyPasswordPlaceholder);
}

// 保存新配置（从用户输入）
async function saveNewConfig() {
    const name = $('#api-config-name').val().trim();
    const manualGroup = $('#api-config-group').val().trim();
    const source = normalizeSource($('#api-config-source').val());

    const customUrl = $('#api-config-url').val().trim();
    const key = $('#api-config-key').val().trim();
    const reverseProxy = $('#api-config-reverse-proxy').val().trim();
    const proxyPassword = $('#api-config-proxy-password').val().trim();
    const model = $('#api-config-model').val().trim();
    const autoGroup = manualGroup || detectAutoGroup({
        name,
        source,
        customUrl,
        reverseProxy,
    });
    const usedAutoGroup = !manualGroup && Boolean(autoGroup);

    if (!name) {
        toastr.error('请输入配置名称', 'API配置管理器');
        return;
    }

    if (source === CHAT_COMPLETION_SOURCES.CUSTOM) {
        if (!customUrl && !key) {
            toastr.error('Custom配置请至少输入URL或密钥', 'API配置管理器');
            return;
        }
    } else if (source === CHAT_COMPLETION_SOURCES.MAKERSUITE) {
        if (!reverseProxy && !key) {
            toastr.info('未填写反代URL和密钥：将使用酒馆已保存的Google AI Studio密钥（如已配置）', 'API配置管理器');
        }
    }

    const config = {
        name: name,
        group: autoGroup || undefined,
        source: source,
        url: source === CHAT_COMPLETION_SOURCES.CUSTOM ? customUrl : undefined,
        customUrl: source === CHAT_COMPLETION_SOURCES.CUSTOM ? customUrl : undefined,
        key: key,
        reverseProxy: source === CHAT_COMPLETION_SOURCES.MAKERSUITE ? reverseProxy : undefined,
        proxyPassword: source === CHAT_COMPLETION_SOURCES.MAKERSUITE ? proxyPassword : undefined,
        model: model || undefined, // 只有在有值时才保存model字段
        secretId: undefined,
        secretIds: undefined,
    };

    if (editingIndex >= 0) {
        // 更新现有配置（编辑模式）
        const previousConfig = extension_settings[MODULE_NAME].configs[editingIndex];
        try {
            await persistConfigSecrets(config, previousConfig);
        } catch (error) {
            toastr.error(`保存配置失败: ${error.message}`, 'API配置管理器');
            return;
        }

        extension_settings[MODULE_NAME].configs[editingIndex] = config;
        const syncCount = maybeSyncConfigsWithSameEndpoint(editingIndex, previousConfig, config);
        toastr.success(`已更新配置: ${name}`, 'API配置管理器');
        showEndpointSyncToastIfNeeded(syncCount, source);
        editingIndex = -1; // 重置编辑状态
        $('#api-config-save').text('保存配置'); // 重置按钮文本
        $('#api-config-cancel').hide(); // 隐藏取消按钮
    } else {
        // 新建模式：允许同名配置共存
        try {
            await persistConfigSecrets(config);
        } catch (error) {
            toastr.error(`保存配置失败: ${error.message}`, 'API配置管理器');
            return;
        }
        extension_settings[MODULE_NAME].configs.push(config);
        toastr.success(`已保存配置: ${name}`, 'API配置管理器');
    }

    saveSettingsDebounced();
    $('#api-config-name').val('');
    $('#api-config-group').val('');
    $('#api-config-url').val('');
    $('#api-config-key').val('');
    $('#api-config-reverse-proxy').val('');
    $('#api-config-proxy-password').val('');
    $('#api-config-model').val('');
    $('#api-config-model-select').hide().empty().append($('<option></option>').val('').text('选择模型...'));
    updateFormBySource($('#api-config-source').val());
    updateEditorHeader();
    renderConfigList();
    refreshMobileLayoutState(MOBILE_PANES.LIST);
    if (usedAutoGroup) {
        toastr.info(`已自动识别分组: ${autoGroup}`, 'API配置管理器');
    }
}

function setLegacyEditMode(isEditing) {
    $(`#${INLINE_API_LEGACY_SAVE_BTN_ID}`).text(isEditing ? '更新配置' : '保存配置');
    $(`#${INLINE_API_LEGACY_CANCEL_BTN_ID}`).toggle(isEditing);
}

function resetLegacyForm() {
    legacyEditingIndex = -1;
    $('#api-config-legacy-source').val(CHAT_COMPLETION_SOURCES.CUSTOM);
    $('#api-config-legacy-name').val('');
    $('#api-config-legacy-url').val('');
    $('#api-config-legacy-key').val('');
    $('#api-config-legacy-reverse-proxy').val('');
    $('#api-config-legacy-proxy-password').val('');
    $('#api-config-legacy-model').val('');
    $('#api-config-legacy-model-select').hide().empty().append($('<option></option>').val('').text('选择模型...'));
    updateLegacyFormBySource(CHAT_COMPLETION_SOURCES.CUSTOM);
    setLegacyEditMode(false);
    refreshLegacySensitivePlaceholders(CHAT_COMPLETION_SOURCES.CUSTOM);
}

function updateLegacyFormBySource(sourceValue) {
    const source = normalizeSource(sourceValue);
    const $source = $('#api-config-legacy-source');
    const $customUrl = $('#api-config-legacy-url');
    const $apiKey = $('#api-config-legacy-key');
    const $reverseProxy = $('#api-config-legacy-reverse-proxy');
    const $proxyPassword = $('#api-config-legacy-proxy-password');
    const $hint = $('#api-config-legacy-source-hint');

    if ($source.length) {
        $source.val(source);
    }

    if (source === CHAT_COMPLETION_SOURCES.CUSTOM) {
        $customUrl.show().attr('placeholder', 'Custom API URL (例如: https://api.openai.com/v1)');
        $reverseProxy.hide();
        $proxyPassword.hide();
        $hint.text('Custom：使用OpenAI兼容接口。');
    } else {
        $customUrl.hide();
        $reverseProxy.show().attr('placeholder', '反代服务器URL (可选；留空使用默认)');
        $proxyPassword.show();
        $hint.text('Google AI Studio：支持直接Key或使用反代。');
    }

    refreshLegacySensitivePlaceholders(source);
}

function buildLegacyConfig(name, source, customUrl, key, reverseProxy, proxyPassword, model) {
    const autoGroup = detectAutoGroup({
        name,
        source,
        customUrl,
        reverseProxy,
    });

    return {
        name,
        group: autoGroup || undefined,
        source,
        url: source === CHAT_COMPLETION_SOURCES.CUSTOM ? customUrl : undefined,
        customUrl: source === CHAT_COMPLETION_SOURCES.CUSTOM ? customUrl : undefined,
        key,
        reverseProxy: source === CHAT_COMPLETION_SOURCES.MAKERSUITE ? reverseProxy : undefined,
        proxyPassword: source === CHAT_COMPLETION_SOURCES.MAKERSUITE ? proxyPassword : undefined,
        model: model || undefined,
        secretId: undefined,
        secretIds: undefined,
    };
}

async function saveLegacyConfig() {
    const source = normalizeSource($('#api-config-legacy-source').val());
    const name = String($('#api-config-legacy-name').val() || '').trim();
    const customUrl = String($('#api-config-legacy-url').val() || '').trim();
    const key = String($('#api-config-legacy-key').val() || '').trim();
    const reverseProxy = String($('#api-config-legacy-reverse-proxy').val() || '').trim();
    const proxyPassword = String($('#api-config-legacy-proxy-password').val() || '').trim();
    const model = String($('#api-config-legacy-model').val() || '').trim();

    if (!name) {
        toastr.error('请输入配置名称', 'API配置管理器');
        return;
    }

    if (source === CHAT_COMPLETION_SOURCES.CUSTOM) {
        if (!customUrl && !key) {
            toastr.error('Custom配置请至少输入URL或密钥', 'API配置管理器');
            return;
        }
    } else if (source === CHAT_COMPLETION_SOURCES.MAKERSUITE) {
        if (!reverseProxy && !key) {
            toastr.info('未填写反代URL和密钥：将使用酒馆已保存的Google AI Studio密钥（如已配置）', 'API配置管理器');
        }
    }

    const config = buildLegacyConfig(name, source, customUrl, key, reverseProxy, proxyPassword, model);
    const configs = extension_settings[MODULE_NAME].configs;
    const targetIndex = (legacyEditingIndex >= 0 && legacyEditingIndex < configs.length)
        ? legacyEditingIndex
        : -1;

    if (targetIndex >= 0) {
        const previousConfig = configs[targetIndex];
        try {
            await persistConfigSecrets(config, previousConfig);
        } catch (error) {
            toastr.error(`保存配置失败: ${error.message}`, 'API配置管理器');
            return;
        }

        configs[targetIndex] = config;
        const syncCount = maybeSyncConfigsWithSameEndpoint(targetIndex, previousConfig, config);
        toastr.success(`已更新配置: ${name}`, 'API配置管理器');
        showEndpointSyncToastIfNeeded(syncCount, source);
    } else {
        try {
            await persistConfigSecrets(config);
        } catch (error) {
            toastr.error(`保存配置失败: ${error.message}`, 'API配置管理器');
            return;
        }
        configs.push(config);
        toastr.success(`已保存配置: ${name}`, 'API配置管理器');
    }

    saveSettingsDebounced();
    resetLegacyForm();
    renderConfigList();
}

function editLegacyConfig(index) {
    const config = extension_settings[MODULE_NAME].configs[index];
    if (!config) return;

    const source = normalizeSource(config.source);
    legacyEditingIndex = index;
    $('#api-config-legacy-source').val(source);
    $('#api-config-legacy-name').val(config.name || '');
    $('#api-config-legacy-url').val((typeof config.customUrl === 'string' ? config.customUrl : config.url) || '');
    $('#api-config-legacy-key').val('');
    $('#api-config-legacy-reverse-proxy').val(config.reverseProxy || '');
    $('#api-config-legacy-proxy-password').val('');
    $('#api-config-legacy-model').val(config.model || '');
    updateLegacyFormBySource(source);
    setLegacyEditMode(true);
}

async function fetchLegacyModels() {
    const source = normalizeSource($('#api-config-legacy-source').val());
    const currentEditingConfig = legacyEditingIndex >= 0 ? extension_settings[MODULE_NAME].configs[legacyEditingIndex] : null;
    const editingConfig = currentEditingConfig && normalizeSource(currentEditingConfig.source) === source
        ? currentEditingConfig
        : null;
    const customUrl = String($('#api-config-legacy-url').val() || '').trim();
    const apiKey = String($('#api-config-legacy-key').val() || '').trim();
    const reverseProxy = String($('#api-config-legacy-reverse-proxy').val() || '').trim();
    let proxyPassword = String($('#api-config-legacy-proxy-password').val() || '').trim();

    if (source === CHAT_COMPLETION_SOURCES.CUSTOM && !customUrl) {
        toastr.error('请先输入Custom URL', 'API配置管理器');
        return;
    }

    const button = $('#api-config-legacy-fetch-models');
    const originalText = button.text();
    button.text('获取中...').prop('disabled', true);

    try {
        if (!proxyPassword && reverseProxy && editingConfig && normalizeSource(editingConfig.source) === source) {
            proxyPassword = await readStoredProxyPasswordValue(editingConfig);
        }

        const data = await withTemporarySourceSecret(source, apiKey, editingConfig, async () => (
            await requestConnectionStatus(source, {
                customUrl,
                reverseProxy,
                proxyPassword,
            })
        ));

        if (data.error || !Array.isArray(data.data)) {
            throw new Error('API连接失败，请检查URL和密钥');
        }

        const modelSelect = $('#api-config-legacy-model-select');
        modelSelect.empty().append($('<option></option>').val('').text('选择模型...'));

        const models = data.data.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
        for (const model of models) {
            const modelId = String(model.id || '');
            if (!modelId) continue;
            modelSelect.append($('<option></option>').val(modelId).text(modelId));
        }
        modelSelect.show();
        toastr.success(`已获取到 ${models.length} 个模型`, 'API配置管理器');
    } catch (error) {
        console.error('经典模式获取模型失败:', error);
        toastr.error(`获取模型失败: ${error.message}`, 'API配置管理器');
    } finally {
        button.text(originalText).prop('disabled', false);
    }
}

function renderLegacyInlineList() {
    const container = $(`#${INLINE_API_LEGACY_LIST_ID}`);
    if (!container.length) return;

    const configs = extension_settings[MODULE_NAME].configs;
    const sortMode = getListSortMode();
    const activeConfigIndex = findActiveConfigIndex(configs);
    const visibleCount = getLegacyVisibleCount();
    updateSortToggleButtons();
    $(`#${INLINE_API_LEGACY_VISIBLE_COUNT_ID}`).val(String(visibleCount));
    container.empty();

    if (!configs.length) {
        container.append('<div class="api-config-empty">暂无已保存配置</div>');
        updateLegacyListViewportHeight();
        return;
    }

    const collator = new Intl.Collator('zh-Hans-CN', { sensitivity: 'base', numeric: true });
    const usageHistory = getUsageHistory();
    const now = Date.now();
    const enhanced = configs.map((config, index) => ({
        config,
        index,
        groupName: getConfigGroup(config) || '未分组',
        usageScore: getConfigUsageScore(config, now, usageHistory),
    }));

    const byName = (a, b) => collator.compare(String(a.config.name || ''), String(b.config.name || ''));
    const byUsageThenName = (a, b) => {
        if (b.usageScore !== a.usageScore) return b.usageScore - a.usageScore;
        return byName(a, b);
    };

    const ordered = [];
    const groupedHeaderNames = new Set();

    if (sortMode === LIST_SORT_MODES.GROUP) {
        const groupMap = new Map();
        for (const item of enhanced) {
            const key = item.groupName;
            if (!groupMap.has(key)) {
                groupMap.set(key, []);
            }
            groupMap.get(key).push(item);
        }

        const multiGroups = [];
        const singleItems = [];

        for (const [groupName, items] of groupMap.entries()) {
            if (items.length > 1) {
                multiGroups.push({
                    groupName,
                    items,
                    groupUsage: items.reduce((sum, it) => sum + it.usageScore, 0),
                });
            } else {
                singleItems.push(items[0]);
            }
        }

        const buckets = [
            ...multiGroups.map(group => ({
                type: 'group',
                key: group.groupName,
                rank: group.groupUsage,
                group,
            })),
            ...singleItems.map(item => ({
                type: 'single',
                key: String(item.config?.name || ''),
                rank: item.usageScore,
                item,
            })),
        ];

        buckets.sort((a, b) => {
            if (b.rank !== a.rank) return b.rank - a.rank;
            return collator.compare(a.key, b.key);
        });

        for (const bucket of buckets) {
            if (bucket.type === 'group') {
                const group = bucket.group;
                group.items.sort(byUsageThenName);
                groupedHeaderNames.add(group.groupName);
                ordered.push(...group.items);
            } else {
                ordered.push(bucket.item);
            }
        }
    } else if (sortMode === LIST_SORT_MODES.USAGE) {
        enhanced.sort(byUsageThenName);
        ordered.push(...enhanced);
    } else {
        enhanced.sort(byName);
        ordered.push(...enhanced);
    }

    let lastGroup = '';
    ordered.forEach(({ config, index, groupName }) => {
        const source = normalizeSource(config.source);
        const reverseProxyValue = String(config.reverseProxy || '').trim();
        const hasReverseProxy = reverseProxyValue.length > 0;
        const endpoint = source === CHAT_COMPLETION_SOURCES.CUSTOM
            ? (config.customUrl || config.url || '沿用当前Custom URL')
            : (hasReverseProxy ? reverseProxyValue : '默认连接（非反代）');
        const endpointLabel = source === CHAT_COMPLETION_SOURCES.CUSTOM
            ? 'URL'
            : (hasReverseProxy ? '反代地址' : '连接方式');
        const model = config.model || '未设置模型';
        const sourceLabel = getSourceLabel(source);
        const stateText = activeConfigIndex === index ? 'ON' : 'OFF';
        const stateClass = activeConfigIndex === index ? 'is-on' : 'is-off';
        const configGroup = groupName || '未分组';
        const shouldShowGroupHeader = sortMode === LIST_SORT_MODES.GROUP && groupedHeaderNames.has(configGroup);
        if (shouldShowGroupHeader && configGroup !== lastGroup) {
            container.append(`<div class="api-config-list-group-header"><span>${escapeHtml(configGroup)}</span></div>`);
            lastGroup = configGroup;
        }

        const item = $(`
            <div class="api-config-legacy-item">
                <div class="api-config-legacy-item-top">
                    <div class="api-config-legacy-item-name">${escapeHtml(config.name || `配置 ${index + 1}`)}</div>
                    <span class="api-config-provider-state ${stateClass}">${stateText}</span>
                </div>
                <div class="api-config-legacy-item-sub">来源: ${escapeHtml(sourceLabel)}</div>
                <div class="api-config-legacy-item-sub">${escapeHtml(endpointLabel)}: ${escapeHtml(endpoint)}</div>
                <div class="api-config-legacy-item-sub">模型: ${escapeHtml(model)}</div>
                <div class="api-config-legacy-item-actions">
                    <button class="menu_button api-config-legacy-apply" data-index="${index}">应用</button>
                    <button class="menu_button api-config-legacy-edit" data-index="${index}">编辑</button>
                    <button class="menu_button api-config-legacy-delete" data-index="${index}">删除</button>
                </div>
            </div>
        `);
        container.append(item);
    });

    updateLegacyListViewportHeight();
}

function updateFormBySource(sourceValue) {
    const source = normalizeSource(sourceValue);

    const $customUrl = $('#api-config-url');
    const $reverseProxy = $('#api-config-reverse-proxy');
    const $proxyPassword = $('#api-config-proxy-password');
    const $fetchModels = $('#api-config-fetch-models');
    const $hint = $('#api-config-source-hint');
    const $sourceChip = $('#api-config-source-chip');

    if (source === CHAT_COMPLETION_SOURCES.CUSTOM) {
        $customUrl.show().attr('placeholder', 'Custom API URL (例如: https://api.openai.com/v1)');
        $reverseProxy.hide();
        $proxyPassword.hide();
        $fetchModels.prop('disabled', false);
        $hint.text('Custom：使用OpenAI兼容接口（可用于反代OpenAI兼容服务）。');
        $sourceChip.text('当前来源：Custom').removeClass('is-makersuite').addClass('is-custom');
    } else if (source === CHAT_COMPLETION_SOURCES.MAKERSUITE) {
        $customUrl.hide();
        $reverseProxy.show().attr('placeholder', '反代服务器URL (可选；留空使用默认)');
        $proxyPassword.show();
        $fetchModels.prop('disabled', false);
        $hint.text('Google AI Studio：支持直接Key或使用反代（reverse_proxy + proxy_password）。');
        $sourceChip.text('当前来源：Google AI Studio').removeClass('is-custom').addClass('is-makersuite');
    }

    refreshEditorSensitivePlaceholders(source);
}

// 检查更新
async function checkForUpdates() {
    try {
        const response = await fetch(`${EXTENSION_INFO.repository}/raw/main/manifest.json`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const remoteManifest = await response.json();
        const currentVersion = EXTENSION_INFO.version;
        const remoteVersion = remoteManifest.version;



        if (compareVersions(remoteVersion, currentVersion) > 0) {
            return {
                hasUpdate: true,
                currentVersion,
                remoteVersion,
                changelog: remoteManifest.changelog || '无更新日志'
            };
        }

        return { hasUpdate: false, currentVersion };
    } catch (error) {
        console.error('检查更新失败:', error);
        throw error;
    }
}

// 版本比较函数
function compareVersions(version1, version2) {
    const v1parts = version1.split('.').map(Number);
    const v2parts = version2.split('.').map(Number);

    for (let i = 0; i < Math.max(v1parts.length, v2parts.length); i++) {
        const v1part = v1parts[i] || 0;
        const v2part = v2parts[i] || 0;

        if (v1part > v2part) return 1;
        if (v1part < v2part) return -1;
    }

    return 0;
}

// 自动更新扩展
async function updateExtension() {
    const button = $('#api-config-update');
    const originalText = button.text();
    button.text('更新中...').prop('disabled', true);

    try {
        // 使用SillyTavern的官方扩展更新API
        const response = await fetch('/api/extensions/update', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName: 'api-config-manager',
                global: true // 第三方扩展通常是全局的
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`更新请求失败: ${response.status} - ${errorText}`);
        }

        const result = await response.json();

        if (result.isUpToDate) {
            toastr.info('扩展已是最新版本', 'API配置管理器');
        } else {
            toastr.success('扩展已成功更新！请刷新页面以应用更新', 'API配置管理器');

            // 显示更新成功对话框
            const shouldReload = confirm('扩展已成功更新！是否立即刷新页面以应用更新？');
            if (shouldReload) {
                location.reload();
            }
        }

    } catch (error) {
        console.error('更新过程中发生错误:', error);
        toastr.error(`更新失败: ${error.message}`, 'API配置管理器');
    } finally {
        button.text(originalText).prop('disabled', false);
    }
}

// 检查扩展版本状态
async function checkExtensionStatus() {
    try {
        const response = await fetch('/api/extensions/version', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName: 'api-config-manager',
                global: true
            })
        });

        if (response.ok) {
            const result = await response.json();
            return {
                hasUpdate: !result.isUpToDate,
                currentVersion: EXTENSION_INFO.version,
                remoteUrl: result.remoteUrl,
                commitHash: result.currentCommitHash
            };
        }
    } catch (error) {
        console.warn('检查扩展状态失败:', error);
    }

    // 回退到手动检查
    return await checkForUpdates();
}

// 检查并提示更新
async function checkAndPromptUpdate() {
    try {
        const updateInfo = await checkExtensionStatus();

        if (updateInfo.hasUpdate) {
            const message = `发现新版本可用\n\n是否立即更新？`;

            if (confirm(message)) {
                await updateExtension();
            } else {
                // 显示更新按钮高亮提示
                $('#api-config-update').addClass('update-available');
                toastr.info('新版本可用，点击更新按钮进行更新', 'API配置管理器');
            }
        }
    } catch (error) {
        console.warn('检查更新失败，将跳过自动更新检查');
    }
}

// 删除配置
function deleteConfig(index) {
    const config = extension_settings[MODULE_NAME].configs[index];
    if (!config) return;
    if (confirm(`确定要删除配置 "${config.name}" 吗？`)) {
        const removedSignature = buildConfigRuntimeSignature(config);
        extension_settings[MODULE_NAME].configs.splice(index, 1);
        const lastAppliedSignature = extension_settings[MODULE_NAME].lastAppliedSignature;
        if (lastAppliedSignature && isSameConfigSignature(removedSignature, lastAppliedSignature)) {
            extension_settings[MODULE_NAME].lastAppliedSignature = null;
        }
        let handledByCancel = false;
        if (editingIndex === index) {
            cancelEditConfig(false);
            handledByCancel = true;
        } else if (editingIndex > index) {
            editingIndex -= 1;
        }
        saveSettingsDebounced();
        if (!handledByCancel) {
            updateEditorHeader();
            renderConfigList();
        }
        toastr.success(`已删除配置: ${config.name}`, 'API配置管理器');
    }
}

// 渲染配置列表
function renderConfigList() {
    const container = $('#api-config-list');
    container.empty();

    const configs = extension_settings[MODULE_NAME].configs;
    const sortMode = getListSortMode();
    const activeConfigIndex = findActiveConfigIndex(configs);
    $('#api-config-summary-count').text(String(configs.length));
    $('#api-config-inline-count').text(String(configs.length));
    renderLegacyInlineList();
    updateSortToggleButtons();

    const keyword = String($('#api-config-search').val() || '').trim().toLowerCase();
    const filtered = configs
        .map((config, index) => ({ config, index }))
        .filter(({ config }) => {
            if (!keyword) return true;
            const sourceLabel = getSourceLabel(config.source);
            const endpoint = getConfigEndpointValue(config, config.source);
            const group = getConfigGroup(config);
            const text = [
                config.name,
                group,
                sourceLabel,
                endpoint,
                config.model,
            ].filter(Boolean).join(' ').toLowerCase();

            return text.includes(keyword);
        });

    if (configs.length === 0) {
        container.append('<div class="api-config-empty">还没有配置，点击下方“+ 添加”创建第一个服务商</div>');
        return;
    }

    if (filtered.length === 0) {
        container.append('<div class="api-config-empty">没有匹配的配置</div>');
        return;
    }

    const collator = new Intl.Collator('zh-Hans-CN', { sensitivity: 'base', numeric: true });
    const usageHistory = getUsageHistory();
    const now = Date.now();
    const enhanced = filtered.map(item => ({
        ...item,
        groupName: getConfigGroup(item.config) || '未分组',
        usageScore: getConfigUsageScore(item.config, now, usageHistory),
    }));

    const byName = (a, b) => collator.compare(String(a.config.name || ''), String(b.config.name || ''));
    const byUsageThenName = (a, b) => {
        if (b.usageScore !== a.usageScore) return b.usageScore - a.usageScore;
        return byName(a, b);
    };

    const ordered = [];
    const groupedHeaderNames = new Set();

    if (sortMode === LIST_SORT_MODES.GROUP) {
        const groupMap = new Map();
        for (const item of enhanced) {
            const key = item.groupName;
            if (!groupMap.has(key)) {
                groupMap.set(key, []);
            }
            groupMap.get(key).push(item);
        }

        const multiGroups = [];
        const singleItems = [];

        for (const [groupName, items] of groupMap.entries()) {
            if (items.length > 1) {
                multiGroups.push({
                    groupName,
                    items,
                    groupUsage: items.reduce((sum, it) => sum + it.usageScore, 0),
                });
            } else {
                singleItems.push(items[0]);
            }
        }

        const buckets = [
            ...multiGroups.map(group => ({
                type: 'group',
                key: group.groupName,
                rank: group.groupUsage,
                group,
            })),
            ...singleItems.map(item => ({
                type: 'single',
                key: String(item.config?.name || ''),
                rank: item.usageScore,
                item,
            })),
        ];

        buckets.sort((a, b) => {
            if (b.rank !== a.rank) return b.rank - a.rank;
            return collator.compare(a.key, b.key);
        });

        for (const bucket of buckets) {
            if (bucket.type === 'group') {
                const group = bucket.group;
                group.items.sort(byUsageThenName);
                groupedHeaderNames.add(group.groupName);
                ordered.push(...group.items);
            } else {
                ordered.push(bucket.item);
            }
        }
    } else if (sortMode === LIST_SORT_MODES.USAGE) {
        enhanced.sort(byUsageThenName);
        ordered.push(...enhanced);
    } else {
        enhanced.sort(byName);
        ordered.push(...enhanced);
    }

    let lastGroup = '';
    ordered.forEach(({ config, index, groupName }) => {
        const source = normalizeSource(config.source);
        const reverseProxyValue = String(config.reverseProxy || '').trim();
        const hasReverseProxy = reverseProxyValue.length > 0;
        const configGroup = groupName || '未分组';
        const endpointSummary = source === CHAT_COMPLETION_SOURCES.CUSTOM
            ? (config.customUrl || config.url || '沿用当前Custom URL')
            : (hasReverseProxy ? reverseProxyValue : '默认连接（非反代）');
        const endpointLabel = source === CHAT_COMPLETION_SOURCES.CUSTOM
            ? 'URL'
            : (hasReverseProxy ? '反代地址' : '连接方式');
        const modelSummary = config.model || '未设置模型';
        const displayName = escapeHtml(config.name || `配置 ${index + 1}`);
        const displayEndpoint = escapeHtml(`${endpointLabel}: ${endpointSummary}`);
        const displayModel = escapeHtml(`模型: ${modelSummary}`);
        const groupLabel = sortMode !== LIST_SORT_MODES.GROUP
            ? `<span class="api-config-provider-group">${escapeHtml(configGroup)}</span>`
            : '';
        const avatarText = escapeHtml((config.name || 'A').charAt(0).toLowerCase());
        const isActive = editingIndex === index ? 'is-active' : '';
        const isEnabled = activeConfigIndex === index;
        const stateClass = isEnabled ? 'is-on' : 'is-off';
        const stateText = isEnabled ? 'ON' : 'OFF';
        const applyLabel = isEnabled ? '已应用' : '应用配置';
        const applyClass = isEnabled ? 'is-current' : '';

        const shouldShowGroupHeader = sortMode === LIST_SORT_MODES.GROUP && groupedHeaderNames.has(configGroup);
        if (shouldShowGroupHeader && configGroup !== lastGroup) {
            const groupHeader = $(`
                <div class="api-config-list-group-header">
                    <span>${escapeHtml(configGroup)}</span>
                </div>
            `);
            container.append(groupHeader);
            lastGroup = configGroup;
        }

        const configItem = $(`
            <div class="api-config-provider-item ${isActive}">
                <div class="api-config-provider-head">
                    <div class="api-config-provider-main api-config-edit" data-index="${index}">
                        <div class="api-config-provider-avatar">${avatarText}</div>
                        <div class="api-config-provider-text">
                            <div class="api-config-provider-name">${displayName}</div>
                            <div class="api-config-provider-sub">${displayEndpoint}</div>
                            <div class="api-config-provider-model">${displayModel}</div>
                            ${groupLabel}
                        </div>
                    </div>
                    <div class="api-config-provider-right">
                        <span class="api-config-provider-state ${stateClass}">${stateText}</span>
                    </div>
                </div>
                <div class="api-config-provider-mobile-actions">
                    <button class="menu_button api-config-provider-apply ${applyClass}" data-index="${index}" ${isEnabled ? 'disabled' : ''}>
                        <i class="fa-solid fa-bolt"></i> ${applyLabel}
                    </button>
                </div>
            </div>
        `);
        container.append(configItem);
    });
}

function updateEditorActionButtons() {
    const hasSelection = editingIndex >= 0;
    const applyBtn = $('#api-config-apply-current');
    const deleteBtn = $('#api-config-delete-current');

    if (!applyBtn.length || !deleteBtn.length) return;

    if (hasSelection) {
        applyBtn.show().attr('data-index', String(editingIndex));
        deleteBtn.show().attr('data-index', String(editingIndex));
    } else {
        applyBtn.hide().removeAttr('data-index');
        deleteBtn.hide().removeAttr('data-index');
    }
}

function updateEditorHeader() {
    const name = String($('#api-config-name').val() || '').trim();
    const displayName = name || (editingIndex >= 0 ? '编辑配置' : '新建配置');
    const modeText = editingIndex >= 0 ? '编辑模式' : '创建模式';

    $('#api-config-editor-name').text(displayName);
    $('#api-config-editor-mode').text(modeText);
    updateEditorActionButtons();
}

function toggleListSortMode() {
    const currentMode = getListSortMode();
    const nextModeMap = {
        [LIST_SORT_MODES.GROUP]: LIST_SORT_MODES.USAGE,
        [LIST_SORT_MODES.USAGE]: LIST_SORT_MODES.NAME,
        [LIST_SORT_MODES.NAME]: LIST_SORT_MODES.GROUP,
    };
    extension_settings[MODULE_NAME].listSortMode = nextModeMap[currentMode] || LIST_SORT_MODES.GROUP;
    saveSettingsDebounced();
    renderConfigList();
}

function isMobileLayoutViewport() {
    return window.matchMedia(`(max-width: ${MOBILE_LAYOUT_MAX_WIDTH}px)`).matches;
}

function setMobilePane(pane) {
    if (!activePopupContent?.length || !activePopupContent.hasClass('is-mobile-layout')) {
        return;
    }

    mobilePaneMode = pane === MOBILE_PANES.EDITOR ? MOBILE_PANES.EDITOR : MOBILE_PANES.LIST;

    activePopupContent
        .toggleClass('is-mobile-pane-list', mobilePaneMode === MOBILE_PANES.LIST)
        .toggleClass('is-mobile-pane-editor', mobilePaneMode === MOBILE_PANES.EDITOR);

    const tabs = activePopupContent.find('.api-config-mobile-tab');
    tabs.removeClass('is-active').attr('aria-pressed', 'false');
    activePopupContent
        .find(`.api-config-mobile-tab[data-pane="${mobilePaneMode}"]`)
        .addClass('is-active')
        .attr('aria-pressed', 'true');
}

function refreshMobileLayoutState(preferredPane) {
    if (!activePopupContent?.length) return;

    const useMobileLayout = isMobileLayoutViewport();
    activePopupContent.toggleClass('is-mobile-layout', useMobileLayout);

    if (!useMobileLayout) {
        activePopupContent.removeClass('is-mobile-pane-list is-mobile-pane-editor');
        return;
    }

    const targetPane = preferredPane || (editingIndex >= 0 ? MOBILE_PANES.EDITOR : mobilePaneMode);
    setMobilePane(targetPane);
}

function getPopupHostByContent(popupContent) {
    if (popupContent?.closest) {
        const host = popupContent.closest('.popup, .dialogue_popup, .modal, .popup-window');
        if (host.length) return host;
    }

    const fallback = $('.popup:has(.api-config-popup), .dialogue_popup:has(.api-config-popup), .modal:has(.api-config-popup), .popup-window:has(.api-config-popup)').last();
    return fallback;
}

function normalizePopupCloseButton(popupContent) {
    const forceButtonStyles = (buttons) => {
        const styleEntries = [
            ['min-width', '96px'],
            ['width', 'max-content'],
            ['max-width', 'none'],
            ['height', '36px'],
            ['padding', '0 12px'],
            ['border-radius', '10px'],
            ['border', '1px solid #2f3a4a'],
            ['background', '#131923'],
            ['color', '#eff4ff'],
            ['white-space', 'nowrap'],
            ['word-break', 'keep-all'],
            ['writing-mode', 'horizontal-tb'],
            ['text-orientation', 'mixed'],
            ['line-height', '1.2'],
            ['display', 'inline-flex'],
            ['align-items', 'center'],
            ['justify-content', 'center'],
        ];

        buttons.each(function () {
            for (const [key, value] of styleEntries) {
                this.style.setProperty(key, value, 'important');
            }
        });
    };

    const forceDescendantTextHorizontal = (button) => {
        button.find('*').each(function () {
            this.style.setProperty('writing-mode', 'horizontal-tb', 'important');
            this.style.setProperty('text-orientation', 'mixed', 'important');
            this.style.setProperty('white-space', 'nowrap', 'important');
            this.style.setProperty('word-break', 'keep-all', 'important');
            this.style.setProperty('display', 'inline', 'important');
        });
    };

    const findCloseButtonsByText = (scope) => {
        return scope
            .find('button, .menu_button, .popup-button, input[type="button"], input[type="submit"], a')
            .filter(function () {
                const text = String($(this).text() || $(this).val() || '').replace(/\s+/g, '').trim().toLowerCase();
                return text === '关闭' || text === 'close';
            });
    };

    const applyStyle = () => {
        const popupRoot = getPopupHostByContent(popupContent);
        if (popupRoot.length) {
            popupRoot.addClass('api-config-popup-host');
        }

        const searchScope = popupRoot.length ? popupRoot : $(document.body);
        const footerButtons = searchScope.find(
            '.popup-button-container button, .popup-button-container .menu_button, .popup-controls button, .popup-controls .menu_button, .dialogue_popup_buttons button, .dialogue_popup_buttons .menu_button, .popup-button'
        );
        footerButtons.addClass('api-config-popup-action-btn');
        forceButtonStyles(footerButtons);

        const closeButtonsByText = findCloseButtonsByText(searchScope);
        if (closeButtonsByText.length) {
            closeButtonsByText.addClass('api-config-popup-close-btn');
            forceButtonStyles(closeButtonsByText);
            closeButtonsByText.each(function () {
                forceDescendantTextHorizontal($(this));
            });
            return true;
        }

        const closeButton = footerButtons.filter('#dialogue_popup_ok, #dialogue_popup_cancel').last();

        if (!closeButton.length) return false;

        closeButton.addClass('api-config-popup-close-btn');
        forceButtonStyles(closeButton);
        forceDescendantTextHorizontal(closeButton);

        return true;
    };

    for (const delay of [0, 50, 140, 320, 700, 1200, 2000, 3200]) {
        setTimeout(applyStyle, delay);
    }
}

// 编辑配置
function editConfig(index) {
    const config = extension_settings[MODULE_NAME].configs[index];
    if (!config) return;

    // 填充表单
    editingIndex = index;
    $('#api-config-name').val(config.name);
    $('#api-config-group').val(config.group || '');
    $('#api-config-source').val(normalizeSource(config.source)).trigger('change');
    $('#api-config-url').val((typeof config.customUrl === 'string' ? config.customUrl : config.url) || '');
    $('#api-config-key').val('');
    $('#api-config-reverse-proxy').val(config.reverseProxy || '');
    $('#api-config-proxy-password').val('');
    $('#api-config-model').val(config.model || '');

    // 隐藏模型选择下拉框
    $('#api-config-model-select').hide().empty().append($('<option></option>').val('').text('选择模型...'));

    // 设置编辑模式
    $('#api-config-save').text('更新配置');
    $('#api-config-cancel').show(); // 显示取消按钮

    // 滚动到表单顶部
    $('#api-config-name')[0].scrollIntoView({ behavior: 'smooth' });

    // 聚焦到名称字段
    $('#api-config-name').focus();

    updateEditorHeader();
    renderConfigList();
    refreshMobileLayoutState(MOBILE_PANES.EDITOR);
}

// 取消编辑配置
function cancelEditConfig(showToast = true) {
    // 重置编辑状态
    editingIndex = -1;
    $('#api-config-save').text('保存配置');
    $('#api-config-cancel').hide(); // 隐藏取消按钮

    // 清空表单
    $('#api-config-name').val('');
    $('#api-config-group').val('');
    $('#api-config-url').val('');
    $('#api-config-key').val('');
    $('#api-config-reverse-proxy').val('');
    $('#api-config-proxy-password').val('');
    $('#api-config-model').val('');
    $('#api-config-model-select').hide().empty().append($('<option></option>').val('').text('选择模型...'));
    updateFormBySource($('#api-config-source').val());

    updateEditorHeader();
    renderConfigList();
    refreshMobileLayoutState(MOBILE_PANES.LIST);
    if (showToast) {
        toastr.info('已取消编辑，切换到新建配置模式', 'API配置管理器');
    }
}

function buildPopupSettingsHtml() {
    return `
        <div class="api_config_settings api-config-popup">
            <div class="api-config-shell">
                <div class="api-config-mobile-nav">
                    <button type="button" class="menu_button api-config-mobile-tab is-active" data-pane="${MOBILE_PANES.LIST}" aria-pressed="true">
                        <i class="fa-solid fa-list"></i> 配置列表
                    </button>
                    <button type="button" class="menu_button api-config-mobile-tab" data-pane="${MOBILE_PANES.EDITOR}" aria-pressed="false">
                        <i class="fa-solid fa-sliders"></i> 编辑配置
                    </button>
                </div>
                <aside class="api-config-sidebar">
                    <div class="api-config-search-wrap">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input id="api-config-search" type="text" class="text_pole" placeholder="搜索模型平台...">
                    </div>
                    <div class="api-config-sidebar-actions">
                        <button id="api-config-sort-toggle" class="menu_button api-config-sort-toggle">按组排列</button>
                    </div>
                    <div id="api-config-list" class="api-config-provider-list"></div>
                    <button id="api-config-new-entry" class="menu_button api-config-new-entry">
                        <i class="fa-solid fa-plus"></i> 添加
                    </button>
                </aside>

                <section class="api-config-main">
                    <div class="api-config-main-header">
                        <div class="api-config-main-title">
                            <span id="api-config-editor-name">新建配置</span>
                            <span id="api-config-editor-mode">创建模式</span>
                        </div>
                        <div class="api-config-main-tools">
                            <span id="api-config-source-chip" class="api-config-source-chip is-custom">当前来源：Custom</span>
                            <button id="api-config-update" class="menu_button api-config-update-btn" title="检查并更新扩展">
                                <i class="fa-solid fa-download"></i>
                            </button>
                        </div>
                    </div>

                    <div class="api-config-main-meta">
                        <span class="api-config-version">v${EXTENSION_INFO.version}</span>
                        <span id="api-config-summary-count">0</span>
                        <small>个配置</small>
                    </div>

                    <div class="api-config-form">
                        <label class="api-config-label" for="api-config-key">API密钥</label>
                        <div class="api-config-inline-field">
                            <input type="password" id="api-config-key" placeholder="输入密钥（可选）" class="text_pole">
                            <button id="api-config-fetch-models" class="menu_button">获取模型</button>
                        </div>

                        <label class="api-config-label" for="api-config-source">接入类型</label>
                        <select id="api-config-source" class="text_pole">
                            <option value="${CHAT_COMPLETION_SOURCES.CUSTOM}">Custom (OpenAI兼容)</option>
                            <option value="${CHAT_COMPLETION_SOURCES.MAKERSUITE}">Google AI Studio</option>
                        </select>

                        <label class="api-config-label" for="api-config-url">API地址</label>
                        <input type="text" id="api-config-url" placeholder="Custom API URL (例如: https://api.openai.com/v1)" class="text_pole">
                        <input type="text" id="api-config-reverse-proxy" placeholder="反代服务器URL (可选)" class="text_pole" style="display: none;">
                        <input type="password" id="api-config-proxy-password" placeholder="反代密码/Token (可选)" class="text_pole" style="display: none;">

                        <div class="api-config-inline-double">
                            <div>
                                <label class="api-config-label" for="api-config-name">配置名称</label>
                                <input type="text" id="api-config-name" placeholder="例如: 自定义平台-主配置" class="text_pole">
                            </div>
                            <div>
                                <label class="api-config-label" for="api-config-group">分组</label>
                                <input type="text" id="api-config-group" placeholder="可选分组（留空自动识别）" class="text_pole">
                            </div>
                        </div>

                        <label class="api-config-label" for="api-config-model">模型</label>
                        <input type="text" id="api-config-model" placeholder="首选模型（可选）" class="text_pole">
                        <select id="api-config-model-select" class="text_pole" style="display: none;">
                            <option value="">选择模型...</option>
                        </select>

                        <small id="api-config-source-hint">Custom：使用OpenAI兼容接口（可用于反代OpenAI兼容服务）。</small>

                        <div class="flex-container flexGap5 button-container">
                            <button id="api-config-save" class="menu_button"><i class="fa-solid fa-floppy-disk"></i> 保存配置</button>
                            <button id="api-config-cancel" class="menu_button" style="display: none;"><i class="fa-solid fa-ban"></i> 取消</button>
                            <div class="api-config-editor-actions">
                                <button id="api-config-apply-current" class="menu_button" style="display: none;">
                                    <i class="fa-solid fa-bolt"></i> 应用配置
                                </button>
                                <button id="api-config-delete-current" class="menu_button" style="display: none;" title="删除当前配置">
                                    <i class="fa-solid fa-trash"></i>
                                </button>
                            </div>
                        </div>
                    </div>
                </section>
            </div>
        </div>
    `;
}

function ensureOptionsMenuEntry() {
    const optionsMenu = $(OPTIONS_MENU_SELECTOR);
    if (!optionsMenu.length) {
        return false;
    }

    if ($(`#${OPTIONS_MENU_ITEM_ID}`).length) {
        return true;
    }

    const menuItemHtml = `
        <a id="${OPTIONS_MENU_ITEM_ID}">
            <i class="fa-lg fa-solid fa-server"></i>
            <span>API配置管理器</span>
        </a>
    `;

    const insertAfter = optionsMenu.find('#option_select_chat').last();
    if (insertAfter.length) {
        insertAfter.after(menuItemHtml);
    } else {
        optionsMenu.append(menuItemHtml);
    }

    return true;
}

function buildInlineApiEntryHtml() {
    return `
        <div id="${INLINE_API_ENTRY_ID}" class="api-config-inline-launcher">
            <div class="api-config-inline-launcher-title">
                <i class="fa-solid fa-server"></i>
                <span>API配置管理器</span>
            </div>
            <div class="api-config-inline-launcher-sub">
                已保存 <span id="api-config-inline-count">0</span> 个配置
            </div>
            <button id="${INLINE_API_ENTRY_OPEN_BTN_ID}" class="menu_button api-config-inline-launcher-btn">
                打开配置面板
            </button>
            <div class="api-config-inline-launcher-tip">
                也可通过点击左下角选择API配置管理器进行配置
            </div>
            <div class="inline-drawer api-config-legacy-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>经典配置方式</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="api-config-legacy-section">
                        <h4>添加或编辑配置</h4>
                        <div class="flex-container flexFlowColumn flexGap5">
                            <select id="api-config-legacy-source" class="text_pole">
                                <option value="${CHAT_COMPLETION_SOURCES.CUSTOM}">Custom (OpenAI兼容)</option>
                                <option value="${CHAT_COMPLETION_SOURCES.MAKERSUITE}">Google AI Studio</option>
                            </select>
                            <input type="text" id="api-config-legacy-name" placeholder="配置名称" class="text_pole">
                            <input type="text" id="api-config-legacy-url" placeholder="API URL (例如: https://api.openai.com/v1)" class="text_pole">
                            <input type="password" id="api-config-legacy-key" placeholder="API密钥 (可选)" class="text_pole">
                            <input type="text" id="api-config-legacy-reverse-proxy" placeholder="反代服务器URL (可选)" class="text_pole" style="display: none;">
                            <input type="password" id="api-config-legacy-proxy-password" placeholder="反代密码/Key (可选)" class="text_pole" style="display: none;">
                            <div class="flex-container flexGap5">
                                <input type="text" id="api-config-legacy-model" placeholder="首选模型 (可选)" class="text_pole" style="flex: 1;">
                                <button id="api-config-legacy-fetch-models" class="menu_button" style="white-space: nowrap;">获取模型</button>
                            </div>
                            <select id="api-config-legacy-model-select" class="text_pole" style="display: none;">
                                <option value="">选择模型...</option>
                            </select>
                            <div class="flex-container flexGap5 api-config-legacy-save-row">
                                <button id="${INLINE_API_LEGACY_SAVE_BTN_ID}" class="menu_button">保存配置</button>
                                <button id="${INLINE_API_LEGACY_CANCEL_BTN_ID}" class="menu_button" style="display: none;">取消编辑</button>
                            </div>
                        </div>
                        <small id="api-config-legacy-source-hint">Custom：使用OpenAI兼容接口。</small>
                    </div>
                    <div class="api-config-legacy-section">
                        <h4>已保存配置</h4>
                        <div class="api-config-legacy-list-tools">
                            <button id="${INLINE_API_LEGACY_SORT_BTN_ID}" class="menu_button api-config-sort-toggle">按组排列</button>
                            <label class="api-config-legacy-visible-control" for="${INLINE_API_LEGACY_VISIBLE_COUNT_ID}">
                                显示
                                <input id="${INLINE_API_LEGACY_VISIBLE_COUNT_ID}" type="number" min="2" max="20" step="1" value="6" class="text_pole">
                                条
                            </label>
                        </div>
                        <div id="${INLINE_API_LEGACY_LIST_ID}" class="api-config-legacy-list"></div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function ensureInlineApiEntry() {
    if ($(`#${INLINE_API_ENTRY_ID}`).length) {
        return true;
    }

    const customApiForm = $('#custom_form');
    const entryHtml = buildInlineApiEntryHtml();

    if (customApiForm.length) {
        customApiForm.after(entryHtml);
        return true;
    }

    const fallbackContainer = $('#openai_settings, #chat_completion_settings, #extensions_settings, #extensions_settings2').first();
    if (fallbackContainer.length) {
        fallbackContainer.append(entryHtml);
        return true;
    }

    return false;
}

function scheduleEnsureInlineApiEntry() {
    let attempts = 0;
    const maxAttempts = 20;

    const tryAttach = () => {
        if (ensureInlineApiEntry()) {
            $('#api-config-inline-count').text(String(extension_settings[MODULE_NAME].configs.length));
            resetLegacyForm();
            renderLegacyInlineList();
            return;
        }

        attempts += 1;
        if (attempts < maxAttempts) {
            setTimeout(tryAttach, 1000);
        }
    };

    tryAttach();
}

function scheduleEnsureOptionsMenuEntry() {
    let attempts = 0;
    const maxAttempts = 20;

    const tryAttach = () => {
        if (ensureOptionsMenuEntry()) {
            return;
        }

        attempts += 1;
        if (attempts < maxAttempts) {
            setTimeout(tryAttach, 1000);
        } else {
            console.error('找不到左下菜单容器，无法注册API配置管理器入口');
        }
    };

    tryAttach();
}

async function openConfigPopup() {
    editingIndex = -1;
    const popupContent = $(buildPopupSettingsHtml());
    activePopupContent = popupContent;
    mobilePaneMode = MOBILE_PANES.LIST;
    const openInMobile = isMobileLayoutViewport();
    const popupPromise = callPopup(popupContent, 'text', '', {
        okButton: '关闭',
        wide: !openInMobile,
        large: !openInMobile,
        allowVerticalScrolling: true,
    });

    updateFormBySource($('#api-config-source').val());
    updateEditorHeader();
    renderConfigList();
    refreshMobileLayoutState(MOBILE_PANES.LIST);
    normalizePopupCloseButton(popupContent);

    const onResize = () => refreshMobileLayoutState();
    $(window).off('resize.api_config_popup_mobile').on('resize.api_config_popup_mobile', onResize);

    try {
        await popupPromise;
    } finally {
        $(window).off('resize.api_config_popup_mobile', onResize);
        activePopupContent = null;
    }
}

// 创建UI
async function createUI() {
    scheduleEnsureOptionsMenuEntry();
    scheduleEnsureInlineApiEntry();
}



// 绑定事件
function bindEvents() {
    $(document).on('click', '#options_button', function () {
        setTimeout(() => {
            ensureOptionsMenuEntry();
        }, 0);
    });

    // 左下三条杠菜单入口
    $(document).on('click', `#${OPTIONS_MENU_ITEM_ID}`, async function (e) {
        e.preventDefault();
        e.stopPropagation();
        $('#options_button').trigger('click');
        await openConfigPopup();
    });

    // API连接页入口
    $(document).on('click', `#${INLINE_API_ENTRY_OPEN_BTN_ID}`, async function (e) {
        e.preventDefault();
        e.stopPropagation();
        await openConfigPopup();
    });

    // 保存新配置
    $(document).on('click', '#api-config-save', saveNewConfig);
    $(document).on('click', `#${INLINE_API_LEGACY_SAVE_BTN_ID}`, saveLegacyConfig);
    $(document).on('click', `#${INLINE_API_LEGACY_CANCEL_BTN_ID}`, resetLegacyForm);
    $(document).on('click', '#api-config-legacy-fetch-models', fetchLegacyModels);

    // 经典方式列表操作
    $(document).on('click', '.api-config-legacy-edit', function () {
        const index = Number($(this).data('index'));
        if (!Number.isInteger(index) || index < 0) return;
        editLegacyConfig(index);
    });

    $(document).on('click', '.api-config-legacy-delete', function () {
        const index = Number($(this).data('index'));
        if (!Number.isInteger(index) || index < 0) return;

        const beforeLength = extension_settings[MODULE_NAME].configs.length;
        deleteConfig(index);
        if (extension_settings[MODULE_NAME].configs.length >= beforeLength) return;

        if (legacyEditingIndex === index) {
            resetLegacyForm();
        } else if (legacyEditingIndex > index) {
            legacyEditingIndex -= 1;
            setLegacyEditMode(true);
        }
        renderLegacyInlineList();
    });

    $(document).on('click', '.api-config-legacy-apply', async function () {
        const index = Number($(this).data('index'));
        if (!Number.isInteger(index) || index < 0) return;
        const config = extension_settings[MODULE_NAME].configs[index];
        if (!config) return;
        await applyConfig(config);
    });

    // 配置搜索
    $(document).on('input', '#api-config-search', renderConfigList);

    // 切换排序模式
    $(document).on('click', '#api-config-sort-toggle', toggleListSortMode);
    $(document).on('click', `#${INLINE_API_LEGACY_SORT_BTN_ID}`, toggleListSortMode);
    $(document).on('change', `#${INLINE_API_LEGACY_VISIBLE_COUNT_ID}`, function () {
        const normalized = normalizeLegacyVisibleCount($(this).val());
        $(this).val(String(normalized));
        setLegacyVisibleCount(normalized);
        updateLegacyListViewportHeight();
    });

    // 左侧新增按钮
    $(document).on('click', '#api-config-new-entry', function () {
        cancelEditConfig(false);
        refreshMobileLayoutState(MOBILE_PANES.EDITOR);
        $('#api-config-name').focus();
    });

    // 移动端列表/编辑切换
    $(document).on('click', '.api-config-mobile-tab', function () {
        const pane = String($(this).data('pane') || '');
        setMobilePane(pane);
    });

    // 取消编辑配置
    $(document).on('click', '#api-config-cancel', cancelEditConfig);

    // 获取模型列表
    $(document).on('click', '#api-config-fetch-models', fetchAvailableModels);

    // 切换来源（更新表单展示）
    $(document).on('change', '#api-config-source', function () {
        updateFormBySource($(this).val());
    });
    $(document).on('change', '#api-config-legacy-source', function () {
        updateLegacyFormBySource($(this).val());
    });

    // 更新扩展
    $(document).on('click', '#api-config-update', async function(e) {
        // 阻止事件冒泡，避免触发父元素的展开折叠
        e.stopPropagation();
        e.preventDefault();

        try {
            const updateInfo = await checkExtensionStatus();

            if (updateInfo.hasUpdate) {
                const message = `发现新版本可用\n\n是否立即更新？`;

                if (confirm(message)) {
                    await updateExtension();
                }
            } else {
                toastr.info(`当前已是最新版本 ${updateInfo.currentVersion}`, 'API配置管理器');
            }
        } catch (error) {
            toastr.error('检查更新失败，请检查网络连接', 'API配置管理器');
        }
    });

    // 模型选择下拉框变化
    $(document).on('change', '#api-config-model-select', function() {
        const selectedModel = $(this).val();
        if (selectedModel) {
            $('#api-config-model').val(selectedModel);
        }
    });
    $(document).on('change', '#api-config-legacy-model-select', function () {
        const selectedModel = String($(this).val() || '');
        if (selectedModel) {
            $('#api-config-legacy-model').val(selectedModel);
        }
    });

    // 编辑配置
    $(document).on('click', '.api-config-edit', function() {
        const index = parseInt($(this).data('index'));
        editConfig(index);
    });

    // 列表项直接应用配置（移动端为主）
    $(document).on('click', '.api-config-provider-apply', async function (e) {
        e.preventDefault();
        e.stopPropagation();

        const index = Number($(this).data('index'));
        if (!Number.isInteger(index) || index < 0) return;

        const config = extension_settings[MODULE_NAME].configs[index];
        if (!config) return;
        await applyConfig(config);
    });

    // 编辑区应用当前配置
    $(document).on('click', '#api-config-apply-current', async function() {
        if (editingIndex < 0) {
            toastr.info('请先从左侧选择一个配置', 'API配置管理器');
            return;
        }

        const config = extension_settings[MODULE_NAME].configs[editingIndex];
        if (!config) return;
        await applyConfig(config);
    });

    // 编辑区删除当前配置
    $(document).on('click', '#api-config-delete-current', function() {
        if (editingIndex < 0) {
            toastr.info('请先从左侧选择一个配置', 'API配置管理器');
            return;
        }

        deleteConfig(editingIndex);
    });

    // 回车保存配置
    $(document).on('keypress', '#api-config-name, #api-config-url, #api-config-key, #api-config-reverse-proxy, #api-config-proxy-password, #api-config-model', function(e) {
        if (e.which === 13) {
            saveNewConfig();
        }
    });
    $(document).on('keypress', '#api-config-legacy-name, #api-config-legacy-url, #api-config-legacy-key, #api-config-legacy-reverse-proxy, #api-config-legacy-proxy-password, #api-config-legacy-model', function (e) {
        if (e.which === 13) {
            saveLegacyConfig();
        }
    });

    // 输入名称时更新右侧标题
    $(document).on('input', '#api-config-name', updateEditorHeader);
}

// 扩展初始化函数
async function initExtension() {
    await initSettings();
    await createUI();
    bindEvents();

    // 延迟检查更新（避免影响扩展加载速度）
    setTimeout(() => {
        checkAndPromptUpdate().catch(error => {
            console.warn('自动检查更新失败:', error);
        });
    }, 3000);
}

// SillyTavern扩展初始化
jQuery(async () => {
    // 检查是否被禁用
    if (Array.isArray(extension_settings.disabledExtensions) && extension_settings.disabledExtensions.includes(MODULE_NAME)) {
        return;
    }

    await initExtension();
});
