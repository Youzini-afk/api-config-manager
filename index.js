import { extension_settings } from '../../../../../scripts/extensions.js';
import { saveSettingsDebounced, getRequestHeaders, callPopup } from '../../../../../script.js';
import { SECRET_KEYS, writeSecret, findSecret, readSecretState, secret_state } from '../../../../../scripts/secrets.js';

// Import rotateSecret if available (added in newer SillyTavern versions)
let rotateSecret = null;
try {
    const secretsModule = await import('../../../../../scripts/secrets.js');
    rotateSecret = secretsModule.rotateSecret || null;
} catch (e) {
    console.log('rotateSecret not available in this SillyTavern version');
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

// 扩展信息
const EXTENSION_INFO = {
    name: 'API配置管理器',
    version: '1.3.1',
    author: 'Lorenzzz-Elio',
    repository: 'https://github.com/Lorenzzz-Elio/api-config-manager'
};

// 默认设置
const defaultSettings = {
    configs: [], // 存储配置列表: [{name: string, url: string, key: string, model?: string}]
    collapsedGroups: {}, // 存储折叠状态: {groupName: boolean}
    listSortMode: LIST_SORT_MODES.GROUP,
    lastAppliedSignature: null,
    usageHistory: [],
};

// 编辑状态
let editingIndex = -1;
let activePopupContent = null;
let mobilePaneMode = MOBILE_PANES.LIST;
let legacyEditingIndex = -1;

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

    if (!secret_state || Object.keys(secret_state).length === 0) {
        await readSecretState();
    }

    const existingId = await findExistingSecretIdByValue(key, value);
    if (existingId) {
        if (rotateSecret) {
            await rotateSecret(key, existingId);
        }
        return existingId;
    }

    return await writeSecret(key, value, label);
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

function getModelSelectSelector(source) {
    return SOURCE_MODEL_SELECTORS[normalizeSource(source)] || SOURCE_MODEL_SELECTORS[CHAT_COMPLETION_SOURCES.CUSTOM];
}

function buildConfigRuntimeSignature(config, sourceOverride = null) {
    const source = normalizeSource(sourceOverride ?? config?.source);
    return {
        source,
        endpoint: getConfigEndpointValue(config, source),
        model: String(config?.model || '').trim(),
        name: String(config?.name || '').trim(),
    };
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
        if (signature.endpoint !== current.endpoint) return;

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

async function setSourceSecretIfProvided(source, configName, value, config) {
    const normalized = normalizeSource(source);
    const secretKey = SOURCE_SECRET_KEYS[normalized];
    if (!secretKey || !value) return;

    const label = `ACM: ${configName || getSourceLabel(normalized)}`;

    if (!secret_state || Object.keys(secret_state).length === 0) {
        await readSecretState();
    }

    const knownId =
        (config?.secretIds && typeof config.secretIds === 'object' && config.secretIds[secretKey]) ||
        (normalized === CHAT_COMPLETION_SOURCES.CUSTOM ? config?.secretId : null);

    const secrets = Array.isArray(secret_state?.[secretKey]) ? secret_state[secretKey] : [];
    const hasKnownSecret = knownId ? secrets.some(s => s?.id === knownId) : false;

    if (hasKnownSecret) {
        if (rotateSecret) {
            await rotateSecret(secretKey, knownId);
        }
        return;
    }

    const id = await ensureSecretActive(secretKey, value, label);
    if (!id) return;

    if (!config.secretIds || typeof config.secretIds !== 'object') {
        config.secretIds = {};
    }
    config.secretIds[secretKey] = id;
}

// 初始化扩展设置
function initSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = defaultSettings;
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

        if (config.secretId && (!config.secretIds || typeof config.secretIds !== 'object')) {
            config.secretIds = { [SECRET_KEYS.CUSTOM]: config.secretId };
            migrated = true;
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
        setChatCompletionSource(source);

        if (source === CHAT_COMPLETION_SOURCES.CUSTOM) {
            const customUrl = (typeof config.customUrl === 'string' ? config.customUrl : config.url) || '';
            $('#custom_api_url_text').val(customUrl).trigger('input');
            if (typeof oai_settings !== 'undefined') {
                oai_settings.custom_url = customUrl;
            }
        } else if (source === CHAT_COMPLETION_SOURCES.MAKERSUITE) {
            setReverseProxyFields(config.reverseProxy, config.proxyPassword);
        }

        // 通过secrets系统设置密钥（仅在配置里填写了key时覆盖/激活）
        await setSourceSecretIfProvided(source, config.name, config.key, config);

        // 记录最近一次应用的配置，用于左侧状态高亮判定
        extension_settings[MODULE_NAME].lastAppliedSignature = buildConfigRuntimeSignature(config, source);
        const now = Date.now();
        const usageHistory = normalizeUsageHistory(extension_settings[MODULE_NAME].usageHistory, now);
        usageHistory.push({
            ts: now,
            signature: buildConfigRuntimeSignature(config, source),
        });
        if (usageHistory.length > MAX_USAGE_EVENTS) {
            usageHistory.splice(0, usageHistory.length - MAX_USAGE_EVENTS);
        }
        extension_settings[MODULE_NAME].usageHistory = usageHistory;

        // 保存设置
        saveSettingsDebounced();
        renderConfigList();

        // 显示应用成功消息
        toastr.success(`正在连接到: ${config.name}（${getSourceLabel(source)}）`, 'API配置管理器');

        // 如果有指定模型，先尝试设置（连接完成后会再次尝试自动选中）
        if (config.model) {
            setPreferredModel(config.model, config.name, source);
        }

        // 自动重新连接
        $('#api_button_openai').trigger('click');

        // 监听连接状态变化，连接成功后立即设置模型
        if (config.model) {
            waitForConnectionAndSetModel(config.model, config.name, source);
        }

    } catch (error) {
        console.error('应用配置时出错:', error);
        toastr.error(`应用配置失败: ${error.message}`, 'API配置管理器');
    }
}

// 智能等待连接并设置模型
function waitForConnectionAndSetModel(modelName, configName, source) {
    let attempts = 0;
    const maxAttempts = 20; // 最多尝试20次，每次500ms，总共10秒

    const checkConnection = () => {
        attempts++;

        // 检查是否已连接（通过检查模型下拉列表是否有选项）
        const modelSelect = $(getModelSelectSelector(source));
        const hasModels = modelSelect.find('option').length > 1; // 除了默认选项外还有其他选项

        if (hasModels) {
            // 连接成功，设置模型
            setPreferredModel(modelName, configName, source);
            return;
        }

        if (attempts < maxAttempts) {
            // 继续等待
            setTimeout(checkConnection, 500);
        } else {
            // 超时，但仍然尝试设置模型
            setPreferredModel(modelName, configName, source);
        }
    };

    // 开始检查
    setTimeout(checkConnection, 1000); // 1秒后开始检查
}

// 设置首选模型
function setPreferredModel(modelName, configName, source) {
    try {
        const normalized = normalizeSource(source);

        // 更新oai_settings
        if (typeof oai_settings !== 'undefined') {
            const settingKey = SOURCE_MODEL_SETTING_KEYS[normalized];
            if (settingKey) {
                oai_settings[settingKey] = modelName;
            }
        }

        if (normalized === CHAT_COMPLETION_SOURCES.CUSTOM) {
            $('#custom_model_id').val(modelName).trigger('input');
        }

        // 检查下拉列表中是否有该模型
        const modelSelect = $(getModelSelectSelector(normalized));
        if (!modelSelect.length) {
            toastr.info(`已设置首选模型: ${modelName}（未找到模型下拉框，连接后可用）`, 'API配置管理器');
            saveSettingsDebounced();
            return;
        }

        const modelOption = modelSelect.find(`option[value="${modelName}"]`);

        if (modelOption.length > 0) {
            // 模型在下拉列表中，选择它
            modelSelect.val(modelName).trigger('change');
            toastr.success(`已自动选择模型: ${modelName}`, 'API配置管理器');
        } else {
            // 模型不在下拉列表中：允许手动输入的来源（尤其是Custom）可以临时注入选项以便生效
            if (modelSelect.is('select')) {
                modelSelect.append(`<option value="${modelName}">${modelName}</option>`);
                modelSelect.val(modelName).trigger('change');
                toastr.success(`已设置模型: ${modelName}（手动添加）`, 'API配置管理器');
            } else {
                toastr.info(`已设置首选模型: ${modelName}（模型将在连接后可用）`, 'API配置管理器');
            }
        }

        // 保存设置
        saveSettingsDebounced();

    } catch (error) {
        console.error('设置模型时出错:', error);
        toastr.warning(`无法自动设置模型 ${modelName}，请手动选择`, 'API配置管理器');
    }
}

// 获取可用模型列表
async function fetchAvailableModels() {
    const source = normalizeSource($('#api-config-source').val());

    const customUrl = $('#api-config-url').val().trim();
    const apiKey = $('#api-config-key').val().trim();
    const reverseProxy = $('#api-config-reverse-proxy').val().trim();
    const proxyPassword = $('#api-config-proxy-password').val().trim();

    if (source === CHAT_COMPLETION_SOURCES.CUSTOM && !customUrl) {
        toastr.error('请先输入Custom API URL', 'API配置管理器');
        return;
    }

    const button = $('#api-config-fetch-models');
    const originalText = button.text();
    button.text('获取中...').prop('disabled', true);

    try {
        if (source === CHAT_COMPLETION_SOURCES.CUSTOM) {
            if (apiKey) {
                await ensureSecretActive(SECRET_KEYS.CUSTOM, apiKey, 'ACM: Fetch models (Custom)');
            }
        } else if (source === CHAT_COMPLETION_SOURCES.MAKERSUITE) {
            if (!reverseProxy && apiKey) {
                await ensureSecretActive(SECRET_KEYS.MAKERSUITE, apiKey, 'ACM: Fetch models (AI Studio)');
            }
        }

        /** @type {any} */
        const requestData = {
            chat_completion_source: source,
            reverse_proxy: reverseProxy,
            proxy_password: proxyPassword,
        };

        if (source === CHAT_COMPLETION_SOURCES.CUSTOM) {
            requestData.custom_url = customUrl;
        }

        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(requestData),
            cache: 'no-cache'
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        if (data.error) {
            throw new Error('API连接失败，请检查URL和密钥是否正确');
        }

        if (data.data && Array.isArray(data.data)) {
            const modelSelect = $('#api-config-model-select');
            modelSelect.empty().append('<option value="">选择模型...</option>');

            // 按模型ID排序
            const models = data.data.sort((a, b) => a.id.localeCompare(b.id));

            models.forEach(model => {
                modelSelect.append(`<option value="${model.id}">${model.id}</option>`);
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

// 保存新配置（从用户输入）
function saveNewConfig() {
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
        const secretKey = SOURCE_SECRET_KEYS[source];
        const prevSource = normalizeSource(previousConfig?.source);
        const prevSecretId =
            (previousConfig?.secretIds && typeof previousConfig.secretIds === 'object' && secretKey ? previousConfig.secretIds[secretKey] : null) ||
            (source === CHAT_COMPLETION_SOURCES.CUSTOM ? previousConfig?.secretId : null);

        if (prevSecretId && previousConfig?.key === config.key && prevSource === source) {
            config.secretId = previousConfig.secretId;
            config.secretIds = previousConfig.secretIds;
        }

        extension_settings[MODULE_NAME].configs[editingIndex] = config;
        const syncCount = maybeSyncConfigsWithSameEndpoint(editingIndex, previousConfig, config);
        toastr.success(`已更新配置: ${name}`, 'API配置管理器');
        showEndpointSyncToastIfNeeded(syncCount, source);
        editingIndex = -1; // 重置编辑状态
        $('#api-config-save').text('保存配置'); // 重置按钮文本
        $('#api-config-cancel').hide(); // 隐藏取消按钮
    } else {
        // 检查是否已存在同名配置
        const existingIndex = extension_settings[MODULE_NAME].configs.findIndex(c => c.name === name);

        if (existingIndex >= 0) {
            // 更新现有配置
            const previousConfig = extension_settings[MODULE_NAME].configs[existingIndex];
            const secretKey = SOURCE_SECRET_KEYS[source];
            const prevSource = normalizeSource(previousConfig?.source);
            const prevSecretId =
                (previousConfig?.secretIds && typeof previousConfig.secretIds === 'object' && secretKey ? previousConfig.secretIds[secretKey] : null) ||
                (source === CHAT_COMPLETION_SOURCES.CUSTOM ? previousConfig?.secretId : null);

            if (prevSecretId && previousConfig?.key === config.key && prevSource === source) {
                config.secretId = previousConfig.secretId;
                config.secretIds = previousConfig.secretIds;
            }

            extension_settings[MODULE_NAME].configs[existingIndex] = config;
            const syncCount = maybeSyncConfigsWithSameEndpoint(existingIndex, previousConfig, config);
            toastr.success(`已更新配置: ${name}`, 'API配置管理器');
            showEndpointSyncToastIfNeeded(syncCount, source);
        } else {
            // 添加新配置
            extension_settings[MODULE_NAME].configs.push(config);
            toastr.success(`已保存配置: ${name}`, 'API配置管理器');
        }
    }

    saveSettingsDebounced();
    $('#api-config-name').val('');
    $('#api-config-group').val('');
    $('#api-config-url').val('');
    $('#api-config-key').val('');
    $('#api-config-reverse-proxy').val('');
    $('#api-config-proxy-password').val('');
    $('#api-config-model').val('');
    $('#api-config-model-select').hide(); // 隐藏模型选择下拉框
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
    $('#api-config-legacy-name').val('');
    $('#api-config-legacy-url').val('');
    $('#api-config-legacy-key').val('');
    $('#api-config-legacy-model').val('');
    $('#api-config-legacy-model-select').hide().empty().append('<option value="">选择模型...</option>');
    setLegacyEditMode(false);
}

function buildLegacyCustomConfig(name, customUrl, key, model) {
    const autoGroup = detectAutoGroup({
        name,
        source: CHAT_COMPLETION_SOURCES.CUSTOM,
        customUrl,
        reverseProxy: '',
    });

    return {
        name,
        group: autoGroup || undefined,
        source: CHAT_COMPLETION_SOURCES.CUSTOM,
        url: customUrl,
        customUrl,
        key,
        reverseProxy: undefined,
        proxyPassword: undefined,
        model: model || undefined,
        secretId: undefined,
        secretIds: undefined,
    };
}

function saveLegacyConfig() {
    const name = String($('#api-config-legacy-name').val() || '').trim();
    const customUrl = String($('#api-config-legacy-url').val() || '').trim();
    const key = String($('#api-config-legacy-key').val() || '').trim();
    const model = String($('#api-config-legacy-model').val() || '').trim();

    if (!name) {
        toastr.error('请输入配置名称', 'API配置管理器');
        return;
    }

    if (!customUrl && !key) {
        toastr.error('请至少输入URL或密钥', 'API配置管理器');
        return;
    }

    const config = buildLegacyCustomConfig(name, customUrl, key, model);
    const configs = extension_settings[MODULE_NAME].configs;
    const targetIndex = (legacyEditingIndex >= 0 && legacyEditingIndex < configs.length)
        ? legacyEditingIndex
        : configs.findIndex(c => c.name === name);

    if (targetIndex >= 0) {
        const previousConfig = configs[targetIndex];
        const secretKey = SOURCE_SECRET_KEYS[CHAT_COMPLETION_SOURCES.CUSTOM];
        const prevSource = normalizeSource(previousConfig?.source);
        const prevSecretId =
            (previousConfig?.secretIds && typeof previousConfig.secretIds === 'object' && secretKey ? previousConfig.secretIds[secretKey] : null) ||
            previousConfig?.secretId;

        if (prevSecretId && previousConfig?.key === config.key && prevSource === CHAT_COMPLETION_SOURCES.CUSTOM) {
            config.secretId = previousConfig.secretId;
            config.secretIds = previousConfig.secretIds;
        }

        configs[targetIndex] = config;
        toastr.success(`已更新配置: ${name}`, 'API配置管理器');
    } else {
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

    if (normalizeSource(config.source) !== CHAT_COMPLETION_SOURCES.CUSTOM) {
        toastr.info('该配置不是Custom类型，请在新面板中编辑', 'API配置管理器');
        return;
    }

    legacyEditingIndex = index;
    $('#api-config-legacy-name').val(config.name || '');
    $('#api-config-legacy-url').val((typeof config.customUrl === 'string' ? config.customUrl : config.url) || '');
    $('#api-config-legacy-key').val(config.key || '');
    $('#api-config-legacy-model').val(config.model || '');
    setLegacyEditMode(true);
}

async function fetchLegacyModels() {
    const customUrl = String($('#api-config-legacy-url').val() || '').trim();
    const apiKey = String($('#api-config-legacy-key').val() || '').trim();
    if (!customUrl) {
        toastr.error('请先输入URL', 'API配置管理器');
        return;
    }

    const button = $('#api-config-legacy-fetch-models');
    const originalText = button.text();
    button.text('获取中...').prop('disabled', true);

    try {
        if (apiKey) {
            await ensureSecretActive(SECRET_KEYS.CUSTOM, apiKey, 'ACM: Legacy fetch models');
        }

        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                chat_completion_source: CHAT_COMPLETION_SOURCES.CUSTOM,
                custom_url: customUrl,
            }),
            cache: 'no-cache',
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        if (data.error || !Array.isArray(data.data)) {
            throw new Error('API连接失败，请检查URL和密钥');
        }

        const modelSelect = $('#api-config-legacy-model-select');
        modelSelect.empty().append('<option value="">选择模型...</option>');

        const models = data.data.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
        for (const model of models) {
            const modelId = String(model.id || '');
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
    const activeConfigIndex = findActiveConfigIndex(configs);
    container.empty();

    if (!configs.length) {
        container.append('<div class="api-config-empty">暂无已保存配置</div>');
        return;
    }

    configs.forEach((config, index) => {
        const source = normalizeSource(config.source);
        const endpoint = source === CHAT_COMPLETION_SOURCES.CUSTOM
            ? (config.customUrl || config.url || '未填写URL')
            : (config.reverseProxy || '默认连接');
        const model = config.model || '未设置模型';
        const canEditInLegacy = source === CHAT_COMPLETION_SOURCES.CUSTOM;
        const stateText = activeConfigIndex === index ? 'ON' : 'OFF';
        const stateClass = activeConfigIndex === index ? 'is-on' : 'is-off';

        const item = $(`
            <div class="api-config-legacy-item">
                <div class="api-config-legacy-item-top">
                    <div class="api-config-legacy-item-name">${escapeHtml(config.name || `配置 ${index + 1}`)}</div>
                    <span class="api-config-provider-state ${stateClass}">${stateText}</span>
                </div>
                <div class="api-config-legacy-item-sub">URL: ${escapeHtml(endpoint)}</div>
                <div class="api-config-legacy-item-sub">模型: ${escapeHtml(model)}</div>
                <div class="api-config-legacy-item-actions">
                    <button class="menu_button api-config-legacy-apply" data-index="${index}">应用</button>
                    <button class="menu_button api-config-legacy-edit" data-index="${index}" ${canEditInLegacy ? '' : 'disabled'}>编辑</button>
                    <button class="menu_button api-config-legacy-delete" data-index="${index}">删除</button>
                </div>
            </div>
        `);
        container.append(item);
    });
}

function updateFormBySource(sourceValue) {
    const source = normalizeSource(sourceValue);

    const $customUrl = $('#api-config-url');
    const $apiKey = $('#api-config-key');
    const $reverseProxy = $('#api-config-reverse-proxy');
    const $proxyPassword = $('#api-config-proxy-password');
    const $fetchModels = $('#api-config-fetch-models');
    const $hint = $('#api-config-source-hint');
    const $sourceChip = $('#api-config-source-chip');

    if (source === CHAT_COMPLETION_SOURCES.CUSTOM) {
        $customUrl.show().attr('placeholder', 'Custom API URL (例如: https://api.openai.com/v1)');
        $apiKey.show().attr('placeholder', 'Custom API密钥 (可选)');
        $reverseProxy.hide();
        $proxyPassword.hide();
        $fetchModels.prop('disabled', false);
        $hint.text('Custom：使用OpenAI兼容接口（可用于反代OpenAI兼容服务）。');
        $sourceChip.text('当前来源：Custom').removeClass('is-makersuite').addClass('is-custom');
    } else if (source === CHAT_COMPLETION_SOURCES.MAKERSUITE) {
        $customUrl.hide();
        $apiKey.show().attr('placeholder', 'Google AI Studio API Key (可选；不填则使用酒馆已保存的密钥)');
        $reverseProxy.show().attr('placeholder', '反代服务器URL (可选；留空使用默认)');
        $proxyPassword.show().attr('placeholder', '反代密码/Key (可选；反代需要时填写)');
        $fetchModels.prop('disabled', false);
        $hint.text('Google AI Studio：支持直接Key或使用反代（reverse_proxy + proxy_password）。');
        $sourceChip.text('当前来源：Google AI Studio').removeClass('is-custom').addClass('is-makersuite');
    }
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
    const sortButton = $('#api-config-sort-toggle');
    if (sortButton.length) {
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
        const nextLabel = buttonLabelMap[nextModeMap[sortMode]] || '按组排列';
        sortButton
            .toggleClass('is-group', sortMode === LIST_SORT_MODES.GROUP)
            .toggleClass('is-usage', sortMode === LIST_SORT_MODES.USAGE)
            .text(buttonLabelMap[sortMode] || '按组排列')
            .attr('title', `当前${buttonLabelMap[sortMode] || '按组排列'}，点击切换为${nextLabel}`);
    }

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
        const configGroup = groupName || '未分组';
        const endpointSummary = normalizeSource(config.source) === CHAT_COMPLETION_SOURCES.CUSTOM
            ? (config.customUrl || config.url || '未填写Custom URL')
            : (config.reverseProxy || '默认连接');
        const modelSummary = config.model || '未设置模型';
        const displayName = escapeHtml(config.name || `配置 ${index + 1}`);
        const displayEndpoint = escapeHtml(`URL: ${endpointSummary}`);
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

    // 填充表单
    $('#api-config-name').val(config.name);
    $('#api-config-group').val(config.group || '');
    $('#api-config-source').val(normalizeSource(config.source)).trigger('change');
    $('#api-config-url').val((typeof config.customUrl === 'string' ? config.customUrl : config.url) || '');
    $('#api-config-key').val(config.key || '');
    $('#api-config-reverse-proxy').val(config.reverseProxy || '');
    $('#api-config-proxy-password').val(config.proxyPassword || '');
    $('#api-config-model').val(config.model || '');

    // 隐藏模型选择下拉框
    $('#api-config-model-select').hide();

    // 设置编辑模式
    editingIndex = index;
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
    $('#api-config-model-select').hide(); // 隐藏模型选择下拉框
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
        console.error('找不到左下菜单容器，无法注册API配置管理器入口');
        return;
    }

    if ($(`#${OPTIONS_MENU_ITEM_ID}`).length) {
        return;
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
            <div class="inline-drawer api-config-legacy-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>经典配置方式</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="api-config-legacy-section">
                        <h4>添加或编辑配置</h4>
                        <div class="flex-container flexFlowColumn flexGap5">
                            <input type="text" id="api-config-legacy-name" placeholder="配置名称" class="text_pole">
                            <input type="text" id="api-config-legacy-url" placeholder="API URL (例如: https://api.openai.com/v1)" class="text_pole">
                            <input type="password" id="api-config-legacy-key" placeholder="API密钥 (可选)" class="text_pole">
                            <div class="flex-container flexGap5">
                                <input type="text" id="api-config-legacy-model" placeholder="首选模型 (可选)" class="text_pole" style="flex: 1;">
                                <button id="api-config-legacy-fetch-models" class="menu_button" style="white-space: nowrap;">获取模型</button>
                            </div>
                            <select id="api-config-legacy-model-select" class="text_pole" style="display: none;">
                                <option value="">选择模型...</option>
                            </select>
                            <div class="flex-container flexGap5">
                                <button id="${INLINE_API_LEGACY_SAVE_BTN_ID}" class="menu_button">保存配置</button>
                                <button id="${INLINE_API_LEGACY_CANCEL_BTN_ID}" class="menu_button" style="display: none;">取消编辑</button>
                            </div>
                        </div>
                        <small>经典方式默认保存为Custom配置；Google AI Studio请使用上方新面板。</small>
                    </div>
                    <div class="api-config-legacy-section">
                        <h4>已保存配置</h4>
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
    ensureOptionsMenuEntry();
    scheduleEnsureInlineApiEntry();
}



// 绑定事件
function bindEvents() {
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
    $(document).on('keypress', '#api-config-legacy-name, #api-config-legacy-url, #api-config-legacy-key, #api-config-legacy-model', function (e) {
        if (e.which === 13) {
            saveLegacyConfig();
        }
    });

    // 输入名称时更新右侧标题
    $(document).on('input', '#api-config-name', updateEditorHeader);
}

// 扩展初始化函数
async function initExtension() {
    initSettings();
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
    if (extension_settings.disabledExtensions.includes(MODULE_NAME)) {
        return;
    }

    await initExtension();
});
