/* ==========================================================================
 * 人物记忆库（st-character-memory）
 * SillyTavern 第三方扩展 · 手机端优化 · 本地存储
 *
 * 记忆类型：人物特征 / 物品特征 / 环境特征 / 社会结构 / 自定义类目
 * 提取方式：主对话 API（静默生成）或自配置的副 API（OpenAI 兼容接口）
 * 注入方式：setExtensionPrompt，按类目规则（全量 / 关键词 / 最近提及）
 * ========================================================================== */

import { getContext, extension_settings, saveSettingsDebounced } from '../../../extensions.js';
import {
    eventSource,
    event_types,
    generateQuietPrompt,
    saveMetadataDebounced,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
} from '../../../../script.js';

const EXT = 'st-character-memory';
const META_KEY = EXT + ':meta';
const VERSION = '1.0.0';
const MAX_ERRORS = 20;       // 报错栏保留最近 20 条
const MAX_SNAPSHOTS = 40;    // 撤回快照上限
const MAX_SUGGEST = 10;      // 每个人物的"建议修改"上限

/* --------------------------------------------------------------------------
 * 默认数据
 * ------------------------------------------------------------------------ */

/** 注入规则默认结构 */
function defaultRule() {
    return {
        enabled: true,          // 是否参与注入
        mode: 'always',         // always=全量 | keyword=关键词触发 | recent=最近提及
        keywords: [],           // 关键词数组
        depth: 4,               // 注入深度（IN_CHAT）
    };
}

function defaultSettings() {
    return {
        enabled: true,          // 自动提取总开关
        floorInterval: 6,       // 每 N 楼自动提取一次
        batchSize: 6,           // 单次提取最多合并的楼层数
        recentRange: 10,        // 注入筛选参考最近 K 楼
        injectMaster: true,     // 注入总开关
        useSubApi: false,       // 是否使用副 API 提取
        subApi: {
            baseUrl: '',        // 如 https://api.deepseek.com/v1
            apiKey: '',
            model: '',
            jsonMode: false,    // 是否附加 response_format: json_object
            maxTokens: 2000,
        },
        quietLen: 1600,         // 走主 API 时的最大返回长度
        globalLibrary: false,   // 全局库开关（默认按聊天隔离）
        ballPos: { right: 14, bottom: 110 },
        rules: {                // 一级类目注入规则
            chars: defaultRule(),
            items: defaultRule(),
            envs: defaultRule(),
            soc: defaultRule(),
        },
        globalStore: null,      // 全局库数据
    };
}

function defaultStore() {
    return {
        v: 1,
        characters: [],  // 人物
        items: [],       // 物品
        envs: [],        // 环境
        societies: [],   // 社会结构
        customCats: [],  // 自定义一级类目 {id,name,rule,entries:[{id,name,rule,content}]}
    };
}

function defaultMeta() {
    return {
        lastExtractedIndex: 0,  // 已提取到的楼层（不含）
        snapshots: [],          // 提取前快照，用于 swipe 撤回
        errors: [],             // 报错栏
        stats: { extractions: 0, lastTime: '', injectedChars: 0, injectedAt: '' },
        lastErrorRange: null,   // 最近一次失败的提取范围，供"重试"
    };
}

/** 新人物档案 */
function newCharacter(name) {
    return {
        id: uid(),
        name: name || '未命名',
        appearance: [],        // [{id,text,floor}] 只增不改
        appearanceSuggest: [], // [{id,oldText,newText,reason,ts}] 待确认的建议修改
        talent: [],            // [{id,text}] 天赋（性格/资质）
        skills: [],            // [{id,name,desc}]
        relations: [],         // [{id,target,relation,note}]
        property: [],          // [{id,name,kind,note}] 财产（物品/生物/货币）
        statusHealth: { text: '', floor: -1 }, // 情绪与健康状态（覆盖制）
        statusLook: { text: '', floor: -1 },   // 外表状态：穿着首饰（覆盖制）
        customFields: [],      // [{id,name,rule,content}] 子类目自定义条目
        rule: null,            // 该人物的注入规则覆盖（null=跟随类目）
    };
}

/* --------------------------------------------------------------------------
 * 工具
 * ------------------------------------------------------------------------ */

function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function norm(s) {
    return String(s ?? '').trim().toLowerCase();
}

function toast(msg, type = 'info') {
    try {
        if (typeof toastr !== 'undefined') toastr[type]?.(msg);
        else console.log('[记忆库]', msg);
    } catch { /* ignore */ }
}

function debounce(fn, ms) {
    let t = null;
    return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), ms);
    };
}

/** 深合并默认值（只补缺，不覆盖已有） */
function mergeDefaults(target, defaults) {
    for (const k of Object.keys(defaults)) {
        if (target[k] === undefined) target[k] = defaults[k];
        else if (defaults[k] && typeof defaults[k] === 'object' && !Array.isArray(defaults[k])
            && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
            mergeDefaults(target[k], defaults[k]);
        }
    }
    return target;
}

function clampInt(v, min, max, fallback) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

/* --------------------------------------------------------------------------
 * 设置 / 存储
 * ------------------------------------------------------------------------ */

function settings() {
    extension_settings[EXT] ??= {};
    return mergeDefaults(extension_settings[EXT], defaultSettings());
}

function saveSettings() {
    saveSettingsDebounced();
}

/** 当前记忆库（按聊天隔离 或 全局库） */
function getStore() {
    const s = settings();
    if (s.globalLibrary) {
        s.globalStore ??= defaultStore();
        mergeDefaults(s.globalStore, defaultStore());
        return s.globalStore;
    }
    const ctx = getContext();
    ctx.chatMetadata ??= {};
    ctx.chatMetadata[EXT] ??= defaultStore();
    mergeDefaults(ctx.chatMetadata[EXT], defaultStore());
    return ctx.chatMetadata[EXT];
}

function saveStore() {
    if (settings().globalLibrary) saveSettingsDebounced();
    else saveMetadataDebounced();
}

/** 提取进度 / 快照 / 报错 / 统计：永远按聊天隔离（即使开全局库） */
function meta() {
    const ctx = getContext();
    ctx.chatMetadata ??= {};
    ctx.chatMetadata[META_KEY] ??= defaultMeta();
    mergeDefaults(ctx.chatMetadata[META_KEY], defaultMeta());
    return ctx.chatMetadata[META_KEY];
}

function saveMeta() {
    saveMetadataDebounced();
}

/** 用快照数据整体替换当前库（保持引用） */
function replaceStoreData(data) {
    const store = getStore();
    for (const k of Object.keys(store)) delete store[k];
    Object.assign(store, data);
}

/* --------------------------------------------------------------------------
 * 报错栏
 * ------------------------------------------------------------------------ */

function logError(type, msg, detail = '') {
    const m = meta();
    m.errors.unshift({
        t: new Date().toLocaleString(),
        type: String(type || '错误'),
        msg: String(msg || ''),
        detail: String(detail || '').slice(0, 800),
    });
    if (m.errors.length > MAX_ERRORS) m.errors.length = MAX_ERRORS;
    saveMeta();
    if (drawerOpen && activeTab === 'errors') renderBody();
    console.warn('[记忆库]', type, msg, detail);
}

/* --------------------------------------------------------------------------
 * 提取引擎
 * ------------------------------------------------------------------------ */

let isExtracting = false;
let pendingExtract = false;
let backfillCancel = false;

/** 构造提取提示词 */
function buildExtractionPrompt(messages) {
    const store = getStore();
    const known = {
        人物: store.characters.map(c => ({ 名字: c.name, 已知外貌: c.appearance.map(a => a.text) })),
        物品: store.items.map(i => i.name),
        环境: store.envs.map(e => e.name),
        社会结构: store.societies.map(s => s.name),
        自定义类目: store.customCats.map(c => c.name),
    };
    const transcript = messages
        .map(m => `${m.is_user ? '用户' : (m.name || '角色')}: ${String(m.mes || '').slice(0, 1500)}`)
        .join('\n');

    return `你是一个角色扮演聊天记录的信息提取器。从对话片段中提取"非剧情类"的长期记忆，只输出一个 JSON 对象，不要输出任何解释、不要代码块标记。

【已知档案】（避免重复，外貌条目只新增此前没有的描述）
${JSON.stringify(known)}

【对话片段】
${transcript}

【输出格式】（没有的类目留空数组 / 空字符串，不要编造）
{
  "characters": [{
    "name": "人物名",
    "appearance_add": ["仅人物本身的容貌与身体细节：长相、体型、肢体特征等。不含衣着、首饰、妆容；不含已有的已知外貌"],
    "appearance_modify_suggest": [{"old": "与新信息矛盾的旧描述原文片段", "new": "建议替换为的新描述", "reason": "如：剧情中剪了短发"}],
    "talent_add": ["天赋：性格特点、资质根骨等"],
    "skills_add": [{"name": "技能名（招式/法术/能力）", "desc": "简述"}],
    "relations_add": [{"target": "对象名", "relation": "关系", "note": "补充，可空"}],
    "property_add": [{"name": "财产名", "kind": "物品/生物/货币/其他", "note": "补充，可空"}],
    "status_health": "情绪与健康状态（如：高兴、悲伤、生病、虚弱），整体覆盖旧值；无变化留空字符串",
    "status_look": "外表状态：当前穿着、首饰、妆容，整体覆盖旧值；无变化留空字符串"
  }],
  "items": [{"name": "物品名", "brief": "简略描述", "func": "功能特性", "owner": "归属", "integrity": "完整度：完好/损毁/残缺等。仅填写有信息的字段，其余留空字符串"}],
  "envs": [{"name": "环境/地点名", "overview": "概况（有更新才填）", "layout_add": ["布局变化：新增建筑/家具/破坏/损毁等"]}],
  "societies": [{"name": "势力/宗教/组织/单位/社交圈名", "type": "类型", "desc": "描述（有更新才填）"}],
  "custom": {"自定义类目名": [{"name": "条目名", "content": "内容"}]}
}

要求：
1. 只提取对话中明确出现或强烈暗示的信息，不要推测编造。
2. appearance_modify_suggest 仅在发生不可逆改变（剪发、留疤、断肢、成长等）且与已知外貌矛盾时给出。
3. 人物名以对话中的称呼为准，保持前后一致。
4. custom 只填"已知档案"里列出的自定义类目，且确实有相关信息时。`;
}

/** 调用副 API（OpenAI 兼容） */
async function callSubApi(prompt) {
    const sub = settings().subApi;
    const url = sub.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const body = {
        model: sub.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: clampInt(sub.maxTokens, 256, 8000, 2000),
    };
    if (sub.jsonMode) body.response_format = { type: 'json_object' };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + sub.apiKey,
            },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
    } finally {
        clearTimeout(timer);
    }
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`副API HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('副API返回为空或格式不符');
    return text;
}

/** 调用提取模型：副 API 优先（若启用且配置完整），否则走主对话 API 静默生成 */
async function callExtraction(prompt) {
    const s = settings();
    if (s.useSubApi && s.subApi.baseUrl && s.subApi.model) {
        return await callSubApi(prompt);
    }
    const r = await generateQuietPrompt(prompt, false, true, '记忆提取', clampInt(s.quietLen, 500, 4000, 1600));
    if (!r || !String(r).trim()) throw new Error('主API静默生成返回为空');
    return r;
}

/** 宽松的 JSON 解析：去代码块、截取首尾大括号、去尾逗号 */
function parseJsonLoose(text) {
    let t = String(text || '').trim();
    t = t.replace(/```(?:json)?/gi, '').trim();
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('返回内容中未找到 JSON 对象');
    t = t.slice(a, b + 1);
    try {
        return JSON.parse(t);
    } catch (e) {
        t = t.replace(/,\s*([}\]])/g, '$1');
        return JSON.parse(t); // 仍失败则抛给上层记报错栏
    }
}

/** 提取前快照（供 swipe 撤回） */
function pushSnapshot(startIndex, endIndex) {
    const m = meta();
    m.snapshots.push({
        startIndex,
        endIndex,
        before: JSON.stringify(getStore()),
        t: Date.now(),
    });
    if (m.snapshots.length > MAX_SNAPSHOTS) m.snapshots.splice(0, m.snapshots.length - MAX_SNAPSHOTS);
}

/**
 * 对 [start, end) 楼层跑一次提取。
 * 成功返回 true；失败记报错栏并返回 false（不产生副作用，可重试）。
 */
async function runExtraction(start, end) {
    const ctx = getContext();
    const chat = ctx.chat || [];
    end = Math.min(end, chat.length);
    start = Math.max(0, start);
    if (end - start < 1) return false;

    const m = meta();
    pushSnapshot(start, end);
    const msgs = chat.slice(start, end).filter(x => x && !x.is_system && x.mes);
    if (!msgs.length) {
        m.lastExtractedIndex = end;
        saveMeta();
        return true;
    }

    updateBallBusy(true);
    let raw;
    try {
        raw = await callExtraction(buildExtractionPrompt(msgs));
    } catch (e) {
        m.snapshots.pop(); // 提取没发生，撤掉快照
        m.lastErrorRange = { start, end };
        saveMeta();
        logError('API调用失败', e.message || e, `楼层 ${start}~${end - 1}`);
        updateBallBusy(false);
        return false;
    }

    let data;
    try {
        data = parseJsonLoose(raw);
    } catch (e) {
        m.snapshots.pop();
        m.lastErrorRange = { start, end };
        saveMeta();
        logError('返回格式解析失败', e.message, String(raw).slice(0, 400));
        updateBallBusy(false);
        return false;
    }

    try {
        applyExtraction(data, end);
    } catch (e) {
        m.snapshots.pop();
        m.lastErrorRange = { start, end };
        saveMeta();
        logError('数据合并失败', e.message || e, '');
        updateBallBusy(false);
        return false;
    }

    m.lastExtractedIndex = end;
    m.lastErrorRange = null;
    m.stats.extractions += 1;
    m.stats.lastTime = new Date().toLocaleString();
    saveMeta();
    saveStore();
    refreshInjection();
    updateBallBusy(false);
    if (drawerOpen) renderBody();
    return true;
}

/** 自动提取入口：带队列，自动追赶未提取楼层 */
async function queueExtraction() {
    if (isExtracting) { pendingExtract = true; return; }
    isExtracting = true;
    try {
        const s = settings();
        let guard = 0;
        while (guard++ < 12) {
            const chat = getContext().chat || [];
            const m = meta();
            const start = m.lastExtractedIndex || 0;
            if (chat.length - start < s.floorInterval) break;
            const end = Math.min(start + clampInt(s.batchSize, 1, 30, 6), chat.length);
            const ok = await runExtraction(start, end);
            if (!ok) break; // 失败则停下，等手动重试或下一轮
        }
    } finally {
        isExtracting = false;
        if (pendingExtract) { pendingExtract = false; queueExtraction(); }
    }
}

function maybeAutoExtract() {
    const s = settings();
    if (!s.enabled) return;
    const chat = getContext().chat || [];
    const m = meta();
    if (chat.length - (m.lastExtractedIndex || 0) >= s.floorInterval) queueExtraction();
}

/** 立即提取（手动按钮） */
async function extractNow() {
    const chat = getContext().chat || [];
    const m = meta();
    const start = m.lastExtractedIndex || 0;
    if (chat.length - start < 1) { toast('没有需要提取的新楼层'); return; }
    if (isExtracting) { toast('正在提取中，请稍候'); return; }
    isExtracting = true;
    try {
        const end = Math.min(start + clampInt(settings().batchSize, 1, 30, 6), chat.length);
        const ok = await runExtraction(start, end);
        toast(ok ? `提取完成（第 ${start}~${end - 1} 楼）` : '提取失败，详见报错页', ok ? 'success' : 'error');
    } finally {
        isExtracting = false;
    }
}

/** 历史回填：从已提取位置（或第 0 楼）分批跑完整个聊天 */
async function backfill() {
    const chat = getContext().chat || [];
    const m = meta();
    if (isExtracting) { toast('正在提取中，请稍候'); return; }
    if (!chat.length) { toast('当前聊天为空'); return; }
    if (!confirm(`将从第 ${m.lastExtractedIndex || 0} 楼开始，对共 ${chat.length} 楼聊天记录分批提取建库。继续？`)) return;

    isExtracting = true;
    backfillCancel = false;
    const size = clampInt(settings().batchSize, 1, 30, 6);
    let i = m.lastExtractedIndex || 0;
    try {
        while (i < chat.length && !backfillCancel) {
            updateBackfillProgress(i, chat.length);
            const end = Math.min(i + size, chat.length);
            const ok = await runExtraction(i, end);
            if (!ok) { toast('回填中断：提取失败，详见报错页', 'error'); break; }
            i = end;
        }
    } finally {
        isExtracting = false;
        updateBackfillProgress(-1, 0);
    }
    toast(backfillCancel ? '已取消回填' : '回填完成', backfillCancel ? 'info' : 'success');
}

/** 报错页"重试提取" */
async function retryLast() {
    const m = meta();
    const r = m.lastErrorRange;
    if (!r) { toast('没有可重试的失败记录'); return; }
    if (isExtracting) { toast('正在提取中，请稍候'); return; }
    isExtracting = true;
    try {
        const ok = await runExtraction(r.start, r.end);
        toast(ok ? '重试成功' : '重试仍失败，详见报错页', ok ? 'success' : 'error');
    } finally {
        isExtracting = false;
    }
}

/* --------------------------------------------------------------------------
 * 提取结果合并
 * ------------------------------------------------------------------------ */

function findByName(arr, name) {
    const n = norm(name);
    return arr.find(x => norm(x.name) === n);
}

/** 追加去重（按 text/name 字段），返回是否新增 */
function addUnique(list, text, makeItem) {
    const n = norm(text);
    if (!n) return false;
    if (list.some(x => norm(x.text ?? x.name) === n)) return false;
    list.push(makeItem());
    return true;
}

function applyExtraction(data, endFloor) {
    const store = getStore();
    if (!data || typeof data !== 'object') throw new Error('提取结果不是对象');

    /* ----- 人物 ----- */
    for (const c of [].concat(data.characters || [])) {
        if (!c || !c.name) continue;
        let ch = findByName(store.characters, c.name);
        if (!ch) {
            ch = newCharacter(String(c.name).trim());
            store.characters.push(ch);
        }
        // 外貌：只增不改
        for (const a of [].concat(c.appearance_add || [])) {
            addUnique(ch.appearance, a, () => ({ id: uid(), text: String(a).trim(), floor: endFloor }));
        }
        // 外貌建议修改：进入待确认列表，不直接改
        for (const sg of [].concat(c.appearance_modify_suggest || [])) {
            if (!sg || !sg.new) continue;
            ch.appearanceSuggest.push({
                id: uid(),
                oldText: String(sg.old || '').trim(),
                newText: String(sg.new || '').trim(),
                reason: String(sg.reason || '').trim(),
                ts: Date.now(),
            });
            if (ch.appearanceSuggest.length > MAX_SUGGEST) ch.appearanceSuggest.shift();
        }
        // 天赋（性格/资质）：累积
        for (const t of [].concat(c.talent_add || [])) {
            addUnique(ch.talent, t, () => ({ id: uid(), text: String(t).trim() }));
        }
        // 技能：按名去重，有描述则更新描述
        for (const sk of [].concat(c.skills_add || [])) {
            if (!sk || !sk.name) continue;
            const ex = ch.skills.find(x => norm(x.name) === norm(sk.name));
            if (ex) { if (sk.desc) ex.desc = String(sk.desc).trim(); }
            else ch.skills.push({ id: uid(), name: String(sk.name).trim(), desc: String(sk.desc || '').trim() });
        }
        // 关系网：按 对象+关系 去重
        for (const r of [].concat(c.relations_add || [])) {
            if (!r || !r.target) continue;
            const key = norm(r.target) + '|' + norm(r.relation);
            if (!ch.relations.some(x => norm(x.target) + '|' + norm(x.relation) === key)) {
                ch.relations.push({ id: uid(), target: String(r.target).trim(), relation: String(r.relation || '').trim(), note: String(r.note || '').trim() });
            }
        }
        // 财产：按名去重
        for (const p of [].concat(c.property_add || [])) {
            if (!p || !p.name) continue;
            const ex = ch.property.find(x => norm(x.name) === norm(p.name));
            if (ex) { if (p.note) ex.note = String(p.note).trim(); if (p.kind) ex.kind = String(p.kind).trim(); }
            else ch.property.push({ id: uid(), name: String(p.name).trim(), kind: String(p.kind || '物品').trim(), note: String(p.note || '').trim() });
        }
        // 状态类：整体覆盖（实时刷新）
        if (String(c.status_health || '').trim()) {
            ch.statusHealth = { text: String(c.status_health).trim(), floor: endFloor };
        }
        if (String(c.status_look || '').trim()) {
            ch.statusLook = { text: String(c.status_look).trim(), floor: endFloor };
        }
    }

    /* ----- 物品：按名合并，非空字段覆盖 ----- */
    for (const it of [].concat(data.items || [])) {
        if (!it || !it.name) continue;
        let o = findByName(store.items, it.name);
        if (!o) {
            o = { id: uid(), name: String(it.name).trim(), brief: '', func: '', owner: '', integrity: '完好', rule: null };
            store.items.push(o);
        }
        if (String(it.brief || '').trim()) o.brief = String(it.brief).trim();
        if (String(it.func || '').trim()) o.func = String(it.func).trim();
        if (String(it.owner || '').trim()) o.owner = String(it.owner).trim();
        if (String(it.integrity || '').trim()) o.integrity = String(it.integrity).trim();
    }

    /* ----- 环境：概况覆盖，布局累积 ----- */
    for (const e of [].concat(data.envs || [])) {
        if (!e || !e.name) continue;
        let o = findByName(store.envs, e.name);
        if (!o) {
            o = { id: uid(), name: String(e.name).trim(), overview: '', layout: [], rule: null };
            store.envs.push(o);
        }
        if (String(e.overview || '').trim()) o.overview = String(e.overview).trim();
        for (const l of [].concat(e.layout_add || [])) {
            addUnique(o.layout, l, () => ({ id: uid(), text: String(l).trim(), floor: endFloor }));
        }
    }

    /* ----- 社会结构 ----- */
    for (const s of [].concat(data.societies || [])) {
        if (!s || !s.name) continue;
        let o = findByName(store.societies, s.name);
        if (!o) {
            o = { id: uid(), name: String(s.name).trim(), type: '', desc: '', rule: null };
            store.societies.push(o);
        }
        if (String(s.type || '').trim()) o.type = String(s.type).trim();
        if (String(s.desc || '').trim()) o.desc = String(s.desc).trim();
    }

    /* ----- 自定义类目：条目按名合并，内容追加去重 ----- */
    const custom = data.custom && typeof data.custom === 'object' ? data.custom : {};
    for (const catName of Object.keys(custom)) {
        const cat = store.customCats.find(x => norm(x.name) === norm(catName));
        if (!cat) continue; // 只填充已有类目，AI 不擅自建类目
        for (const en of [].concat(custom[catName] || [])) {
            if (!en || !en.name) continue;
            const ex = cat.entries.find(x => norm(x.name) === norm(en.name));
            const content = String(en.content || '').trim();
            if (!content) continue;
            if (ex) {
                if (!ex.content.includes(content)) ex.content = (ex.content ? ex.content + '；' : '') + content;
            } else {
                cat.entries.push({ id: uid(), name: String(en.name).trim(), rule: null, content });
            }
        }
    }
}

/* --------------------------------------------------------------------------
 * swipe 撤回：被重新生成的楼层，恢复到提取前状态
 * ------------------------------------------------------------------------ */

function onSwipe(messageIndex) {
    const m = meta();
    const snaps = m.snapshots || [];
    const i = snaps.findIndex(s => messageIndex >= s.startIndex && messageIndex < s.endIndex);
    if (i < 0) return; // 该楼层未被提取过，无需处理
    const target = snaps[i];
    try {
        replaceStoreData(JSON.parse(target.before));
        m.lastExtractedIndex = target.startIndex;
        m.snapshots = snaps.slice(0, i);
        saveMeta();
        saveStore();
        refreshInjection();
        if (drawerOpen) renderBody();
        toast('已撤回被重新生成楼层的记忆提取');
    } catch (e) {
        logError('撤回失败', e.message || e, '');
    }
}

/* --------------------------------------------------------------------------
 * 注入引擎
 * ------------------------------------------------------------------------ */

const PROMPT_KEY_PREFIX = 'stmem_';
const ALL_PROMPT_KEYS = ['chars', 'items', 'envs', 'soc'].map(k => PROMPT_KEY_PREFIX + k);

function setPromptSafe(key, text, depth) {
    try {
        const fn = getContext().setExtensionPrompt || setExtensionPrompt;
        fn(key, text, extension_prompt_types.IN_CHAT, clampInt(depth, 0, 99, 4), false, extension_prompt_roles.SYSTEM);
    } catch (e) {
        console.warn('[记忆库] 注入失败', key, e);
    }
}

/** 条目是否通过注入筛选 */
function passRule(rule, names, recentText) {
    if (rule && rule.enabled === false) return false;
    const mode = rule?.mode || 'always';
    if (mode === 'always') return true;
    const kws = (rule?.keywords || []).map(norm).filter(Boolean);
    if (mode === 'keyword') return kws.some(k => recentText.includes(k));
    // recent：条目名或关键词在最近 K 楼出现
    const ns = names.map(norm).filter(Boolean);
    return ns.concat(kws).some(k => k && recentText.includes(k));
}

function getRecentText() {
    const chat = getContext().chat || [];
    const k = clampInt(settings().recentRange, 1, 100, 10);
    return norm(chat.slice(-k).map(m => m?.mes || '').join('\n'));
}

/** 组装并注入全部类目 */
function refreshInjection() {
    const s = settings();
    const store = getStore();
    let totalChars = 0;

    if (!s.injectMaster) {
        for (const k of ALL_PROMPT_KEYS) setPromptSafe(k, '', 4);
        for (const c of store.customCats) setPromptSafe(PROMPT_KEY_PREFIX + 'custom_' + c.id, '', 4);
        meta().stats.injectedChars = 0;
        return;
    }

    const recentText = getRecentText();

    /* ----- 人物 ----- */
    const ruleChars = s.rules.chars;
    if (ruleChars.enabled) {
        const lines = [];
        for (const ch of store.characters) {
            const rule = ch.rule || ruleChars;
            if (!passRule(rule, [ch.name], recentText)) continue;
            const parts = [];
            if (ch.appearance.length) parts.push('外貌: ' + ch.appearance.map(a => a.text).join('；'));
            if (ch.talent.length) parts.push('天赋: ' + ch.talent.map(t => t.text).join('；'));
            if (ch.skills.length) parts.push('技能: ' + ch.skills.map(x => x.name + (x.desc ? `(${x.desc})` : '')).join('、'));
            if (ch.relations.length) parts.push('关系: ' + ch.relations.map(r => `${r.target}(${r.relation}${r.note ? '，' + r.note : ''})`).join('、'));
            if (ch.property.length) parts.push('财产: ' + ch.property.map(p => `${p.name}${p.kind && p.kind !== '物品' ? '[' + p.kind + ']' : ''}`).join('、'));
            if (ch.statusHealth.text) parts.push('状态: ' + ch.statusHealth.text);
            if (ch.statusLook.text) parts.push('外表: ' + ch.statusLook.text);
            for (const f of ch.customFields) {
                if (f.enabled === false || !passRule(f.rule || { enabled: true, mode: 'always' }, [f.name], recentText)) continue;
                if (f.content) parts.push(`${f.name}: ${f.content}`);
            }
            if (parts.length) lines.push(`◆ ${ch.name}｜` + parts.join('｜'));
        }
        const text = lines.length ? '[记忆档案·人物]\n' + lines.join('\n') : '';
        totalChars += text.length;
        setPromptSafe(PROMPT_KEY_PREFIX + 'chars', text, ruleChars.depth);
    } else {
        setPromptSafe(PROMPT_KEY_PREFIX + 'chars', '', 4);
    }

    /* ----- 物品 ----- */
    const ruleItems = s.rules.items;
    if (ruleItems.enabled) {
        const lines = [];
        for (const it of store.items) {
            const rule = it.rule || ruleItems;
            if (!passRule(rule, [it.name], recentText)) continue;
            const parts = [];
            if (it.owner) parts.push('归属: ' + it.owner);
            if (it.integrity && it.integrity !== '完好') parts.push('完整度: ' + it.integrity);
            if (it.brief) parts.push(it.brief);
            if (it.func) parts.push('功能: ' + it.func);
            lines.push(`◆ ${it.name}${parts.length ? '｜' + parts.join('｜') : ''}`);
        }
        const text = lines.length ? '[记忆档案·物品]\n' + lines.join('\n') : '';
        totalChars += text.length;
        setPromptSafe(PROMPT_KEY_PREFIX + 'items', text, ruleItems.depth);
    } else {
        setPromptSafe(PROMPT_KEY_PREFIX + 'items', '', 4);
    }

    /* ----- 环境 ----- */
    const ruleEnvs = s.rules.envs;
    if (ruleEnvs.enabled) {
        const lines = [];
        for (const e of store.envs) {
            const rule = e.rule || ruleEnvs;
            if (!passRule(rule, [e.name], recentText)) continue;
            const parts = [];
            if (e.overview) parts.push(e.overview);
            if (e.layout.length) parts.push('布局: ' + e.layout.map(l => l.text).join('；'));
            lines.push(`◆ ${e.name}${parts.length ? '｜' + parts.join('｜') : ''}`);
        }
        const text = lines.length ? '[记忆档案·环境]\n' + lines.join('\n') : '';
        totalChars += text.length;
        setPromptSafe(PROMPT_KEY_PREFIX + 'envs', text, ruleEnvs.depth);
    } else {
        setPromptSafe(PROMPT_KEY_PREFIX + 'envs', '', 4);
    }

    /* ----- 社会结构 ----- */
    const ruleSoc = s.rules.soc;
    if (ruleSoc.enabled) {
        const lines = [];
        for (const o of store.societies) {
            const rule = o.rule || ruleSoc;
            if (!passRule(rule, [o.name], recentText)) continue;
            lines.push(`◆ ${o.name}${o.type ? `(${o.type})` : ''}${o.desc ? '｜' + o.desc : ''}`);
        }
        const text = lines.length ? '[记忆档案·社会结构]\n' + lines.join('\n') : '';
        totalChars += text.length;
        setPromptSafe(PROMPT_KEY_PREFIX + 'soc', text, ruleSoc.depth);
    } else {
        setPromptSafe(PROMPT_KEY_PREFIX + 'soc', '', 4);
    }

    /* ----- 自定义类目 ----- */
    for (const cat of store.customCats) {
        const key = PROMPT_KEY_PREFIX + 'custom_' + cat.id;
        const rule = cat.rule || defaultRule();
        if (rule.enabled === false) { setPromptSafe(key, '', 4); continue; }
        const lines = [];
        for (const en of cat.entries) {
            const er = en.rule || rule;
            if (!passRule(er, [en.name], recentText)) continue;
            if (en.content) lines.push(`◆ ${en.name}｜${en.content}`);
        }
        const text = lines.length ? `[记忆档案·${cat.name}]\n` + lines.join('\n') : '';
        totalChars += text.length;
        setPromptSafe(key, text, rule.depth ?? 4);
    }

    const m = meta();
    m.stats.injectedChars = totalChars;
    m.stats.injectedAt = new Date().toLocaleString();
}

const refreshInjectionDebounced = debounce(refreshInjection, 400);

/* --------------------------------------------------------------------------
 * 事件接线
 * ------------------------------------------------------------------------ */

function wireEvents() {
    if (!eventSource) return;
    eventSource.on(event_types.MESSAGE_RECEIVED, () => { refreshInjectionDebounced(); maybeAutoExtract(); });
    if (event_types.MESSAGE_SENT) eventSource.on(event_types.MESSAGE_SENT, () => refreshInjectionDebounced());
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, onSwipe);
    if (event_types.CHAT_CHANGED) eventSource.on(event_types.CHAT_CHANGED, () => {
        detailCharId = null;
        ruleEditTarget = null;
        refreshInjection();
        if (drawerOpen) renderBody();
    });
    if (event_types.GENERATION_ENDED) eventSource.on(event_types.GENERATION_ENDED, () => refreshInjectionDebounced());
}

/* --------------------------------------------------------------------------
 * UI：悬浮球 + 半屏抽屉
 * ------------------------------------------------------------------------ */

let drawerOpen = false;
let activeTab = 'chars';
let detailCharId = null;     // 人物详情页（null=列表）
let ruleEditTarget = null;   // 正在编辑的注入规则 {rule, title}

const TABS = [
    ['chars', '人物'], ['items', '物品'], ['envs', '环境'], ['soc', '社会'],
    ['custom', '自定义'], ['settings', '设置'], ['errors', '报错'], ['stats', '统计'],
];

function ensureBall() {
    if (document.getElementById('stmem-ball')) return;
    const ball = document.createElement('div');
    ball.id = 'stmem-ball';
    ball.innerHTML = '🧠<div class="stmem-ball-dot"></div>';
    const pos = settings().ballPos || { right: 14, bottom: 110 };
    ball.style.right = pos.right + 'px';
    ball.style.bottom = pos.bottom + 'px';
    document.body.appendChild(ball);

    /* 拖拽（区分点击与拖动） */
    let dragging = false, moved = false, sx = 0, sy = 0, sr = 0, sb = 0;
    ball.addEventListener('pointerdown', e => {
        dragging = true; moved = false;
        sx = e.clientX; sy = e.clientY;
        sr = parseFloat(ball.style.right); sb = parseFloat(ball.style.bottom);
        ball.setPointerCapture(e.pointerId);
    });
    ball.addEventListener('pointermove', e => {
        if (!dragging) return;
        const dx = sx - e.clientX, dy = sy - e.clientY;
        if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
        if (moved) {
            ball.style.right = Math.max(0, sr + dx) + 'px';
            ball.style.bottom = Math.max(0, sb + dy) + 'px';
        }
    });
    ball.addEventListener('pointerup', () => {
        dragging = false;
        if (moved) {
            const s = settings();
            s.ballPos = { right: parseFloat(ball.style.right), bottom: parseFloat(ball.style.bottom) };
            saveSettings();
        } else {
            toggleDrawer();
        }
    });
}

function updateBallBusy(busy) {
    document.getElementById('stmem-ball')?.classList.toggle('stmem-busy', !!busy);
}

function ensureDrawer() {
    if (document.getElementById('stmem-drawer')) return;
    const backdrop = document.createElement('div');
    backdrop.id = 'stmem-backdrop';
    backdrop.addEventListener('click', closeDrawer);
    document.body.appendChild(backdrop);

    const drawer = document.createElement('div');
    drawer.id = 'stmem-drawer';
    drawer.innerHTML = `
        <div class="stmem-header">
            <div class="stmem-grip"></div>
            <span class="stmem-title">🧠 记忆库</span>
            <button id="stmem-extract-now" class="stmem-btn-primary">立即提取</button>
            <button id="stmem-close">✕</button>
        </div>
        <div class="stmem-tabs">${TABS.map(([k, n]) =>
            `<div class="stmem-tab" data-tab="${k}">${n}</div>`).join('')}</div>
        <div class="stmem-body" id="stmem-body"></div>`;
    document.body.appendChild(drawer);

    drawer.querySelector('#stmem-close').addEventListener('click', closeDrawer);
    drawer.querySelector('#stmem-extract-now').addEventListener('click', extractNow);
    drawer.querySelector('.stmem-tabs').addEventListener('click', e => {
        const t = e.target.closest('.stmem-tab');
        if (!t) return;
        activeTab = t.dataset.tab;
        detailCharId = null;
        ruleEditTarget = null;
        renderBody();
    });

    const body = drawer.querySelector('#stmem-body');
    body.addEventListener('click', onBodyClick);
    body.addEventListener('change', onBodyChange);
}

function toggleDrawer() { drawerOpen ? closeDrawer() : openDrawer(); }

function openDrawer() {
    drawerOpen = true;
    ensureDrawer();
    renderBody();
    document.getElementById('stmem-drawer').classList.add('stmem-open');
    document.getElementById('stmem-backdrop').classList.add('stmem-open');
}

function closeDrawer() {
    drawerOpen = false;
    document.getElementById('stmem-drawer')?.classList.remove('stmem-open');
    document.getElementById('stmem-backdrop')?.classList.remove('stmem-open');
}

function renderBody() {
    ensureDrawer();
    document.querySelectorAll('#stmem-drawer .stmem-tab').forEach(t =>
        t.classList.toggle('stmem-active', t.dataset.tab === activeTab));
    const body = document.getElementById('stmem-body');
    if (!body) return;
    const renderers = {
        chars: renderCharsTab, items: renderItemsTab, envs: renderEnvsTab,
        soc: renderSocTab, custom: renderCustomTab, settings: renderSettingsTab,
        errors: renderErrorsTab, stats: renderStatsTab,
    };
    body.innerHTML = (renderers[activeTab] || renderCharsTab)();
    if (activeTab === 'settings') updateBackfillProgress(-2, 0); // 刷新回填进度条
}

/* --------------------------------------------------------------------------
 * 注入规则编辑器（通用：一级类目 / 条目 / 自定义类目共用）
 * ------------------------------------------------------------------------ */

function openRuleEditor(rule, title) {
    ruleEditTarget = { rule: rule || defaultRule(), title };
    renderBody();
}

function ruleEditorHtml() {
    if (!ruleEditTarget) return '';
    const r = ruleEditTarget.rule;
    r.keywords ??= [];
    return `
    <div class="stmem-rulepanel">
        <div class="stmem-row" style="margin-bottom:8px">
            <b class="stmem-fix">⚙️ 注入规则：${esc(ruleEditTarget.title)}</b>
            <button class="stmem-btn-mini stmem-fix" data-act="rule-close">完成</button>
        </div>
        <div class="stmem-check">
            <input type="checkbox" id="stmem-rule-enabled" ${r.enabled !== false ? 'checked' : ''}>
            <span>启用注入</span>
        </div>
        <div class="stmem-field">
            <label>注入模式</label>
            <select id="stmem-rule-mode">
                <option value="always" ${r.mode === 'always' ? 'selected' : ''}>全量（每次都注入）</option>
                <option value="recent" ${r.mode === 'recent' ? 'selected' : ''}>最近提及（名称/关键词出现在最近K楼）</option>
                <option value="keyword" ${r.mode === 'keyword' ? 'selected' : ''}>关键词触发（仅命中关键词）</option>
            </select>
        </div>
        <div class="stmem-field">
            <label>关键词（逗号分隔）</label>
            <input type="text" id="stmem-rule-keywords" value="${esc((r.keywords || []).join('，'))}" placeholder="如：剑，佩剑，武器">
        </div>
        <div class="stmem-field">
            <label>注入深度（0=最新楼层，默认 4）</label>
            <input type="number" id="stmem-rule-depth" min="0" max="99" value="${clampInt(r.depth, 0, 99, 4)}">
        </div>
    </div>`;
}

function saveRuleEditor() {
    if (!ruleEditTarget) return;
    const r = ruleEditTarget.rule;
    const en = document.getElementById('stmem-rule-enabled');
    const md = document.getElementById('stmem-rule-mode');
    const kw = document.getElementById('stmem-rule-keywords');
    const dp = document.getElementById('stmem-rule-depth');
    if (!en) return;
    r.enabled = en.checked;
    r.mode = md.value;
    r.keywords = kw.value.split(/[,，;；]/).map(x => x.trim()).filter(Boolean);
    r.depth = clampInt(dp.value, 0, 99, 4);
    saveSettings();
    saveStore();
    refreshInjection();
}

/* --------------------------------------------------------------------------
 * 标签页：人物
 * ------------------------------------------------------------------------ */

function chipList(list, act, idField) {
    if (!list.length) return '<div class="stmem-hint">暂无</div>';
    return list.map(x => `
        <span class="stmem-chip">
            <span>${esc(x.text ?? x.name)}${x.desc ? '（' + esc(x.desc) + '）' : ''}</span>
            <i class="stmem-x" data-act="${act}" data-id="${x[idField || 'id']}">✕</i>
        </span>`).join('');
}

function renderCharsTab() {
    const store = getStore();
    if (detailCharId) return renderCharDetail(store.characters.find(c => c.id === detailCharId));

    const rows = store.characters.map(c => `
        <div class="stmem-item">
            <div class="stmem-item-head">
                <span class="stmem-item-name">👤 ${esc(c.name)}</span>
                ${c.appearanceSuggest.length ? `<span class="stmem-badge stmem-b-warn">${c.appearanceSuggest.length} 条建议修改</span>` : ''}
                <button class="stmem-btn-mini" data-act="char-open" data-id="${c.id}">详情</button>
                <button class="stmem-btn-mini stmem-btn-danger" data-act="char-del" data-id="${c.id}">删</button>
            </div>
            <div class="stmem-item-body">
                ${c.statusHealth.text ? `<div class="stmem-kv"><b>状态</b>${esc(c.statusHealth.text)}</div>` : ''}
                ${c.statusLook.text ? `<div class="stmem-kv"><b>外表</b>${esc(c.statusLook.text)}</div>` : ''}
            </div>
        </div>`).join('');

    return `
        ${ruleEditorHtml()}
        <div class="stmem-toolbar">
            <button data-act="char-add">＋ 新增人物</button>
            <button data-act="rule-open" data-cat="chars">⚙️ 类目注入规则</button>
            <span class="stmem-spacer"></span>
            <span class="stmem-badge">${store.characters.length} 人</span>
        </div>
        ${rows || '<div class="stmem-empty">还没有人物档案<br>聊聊天后点「立即提取」，或用设置页的「历史回填」</div>'}`;
}

function renderCharDetail(c) {
    if (!c) { detailCharId = null; return renderCharsTab(); }
    const suggest = c.appearanceSuggest.map(s => `
        <div class="stmem-suggest">
            <div>旧：<span class="stmem-suggest-old">${esc(s.oldText || '（未指明）')}</span></div>
            <div>新：<span class="stmem-suggest-new">${esc(s.newText)}</span></div>
            ${s.reason ? `<div class="stmem-suggest-reason">理由：${esc(s.reason)}</div>` : ''}
            <div class="stmem-row">
                <button class="stmem-btn-mini stmem-btn-primary stmem-fix" data-act="suggest-ok" data-id="${c.id}" data-sid="${s.id}">✓ 接受替换</button>
                <button class="stmem-btn-mini stmem-fix" data-act="suggest-no" data-id="${c.id}" data-sid="${s.id}">忽略</button>
            </div>
        </div>`).join('');

    const customFields = c.customFields.map(f => `
        <div class="stmem-item">
            <div class="stmem-item-head">
                <span class="stmem-item-name">${esc(f.name)}</span>
                <button class="stmem-btn-mini" data-act="rule-open-field" data-id="${c.id}" data-fid="${f.id}">规则</button>
                <button class="stmem-btn-mini stmem-btn-danger" data-act="field-del" data-id="${c.id}" data-fid="${f.id}">删</button>
            </div>
            <div class="stmem-item-body">
                <textarea data-field="char-custom-content" data-id="${c.id}" data-fid="${f.id}">${esc(f.content)}</textarea>
            </div>
        </div>`).join('');

    return `
        ${ruleEditorHtml()}
        <div class="stmem-toolbar">
            <button data-act="char-back">← 返回列表</button>
            <button data-act="rule-open-char" data-id="${c.id}">⚙️ 此人注入规则</button>
        </div>

        <div class="stmem-card">
            <h4>👤 ${esc(c.name)}
                <span class="stmem-mini-actions"><button class="stmem-btn-mini" data-act="char-rename" data-id="${c.id}">改名</button></span>
            </h4>
            <div class="stmem-field">
                <label>情绪与健康状态（每次提取整体覆盖，实时刷新）</label>
                <textarea data-field="char-health" data-id="${c.id}">${esc(c.statusHealth.text)}</textarea>
            </div>
            <div class="stmem-field">
                <label>外表状态（穿着、首饰，实时刷新）</label>
                <textarea data-field="char-look" data-id="${c.id}">${esc(c.statusLook.text)}</textarea>
            </div>
        </div>

        <div class="stmem-card">
            <h4>外貌（只增不改）</h4>
            ${suggest ? '<div class="stmem-hint">⚠️ AI 检测到不可逆变化，建议修改：</div>' + suggest : ''}
            ${chipList(c.appearance, 'app-del')}
            <div class="stmem-add-row">
                <input type="text" id="stmem-add-app" placeholder="手动补充外貌细节…">
                <button data-act="app-add" data-id="${c.id}">＋</button>
            </div>
        </div>

        <div class="stmem-card">
            <h4>天赋（性格 / 资质）</h4>
            ${chipList(c.talent, 'talent-del')}
            <div class="stmem-add-row">
                <input type="text" id="stmem-add-talent" placeholder="如：沉稳冷静；火灵根…">
                <button data-act="talent-add" data-id="${c.id}">＋</button>
            </div>
        </div>

        <div class="stmem-card">
            <h4>技能（招式 / 法术 / 能力）</h4>
            ${c.skills.map(sk => `
                <div class="stmem-kv">
                    <b>${esc(sk.name)}</b>${esc(sk.desc || '')}
                    <i class="stmem-x" data-act="skill-del" data-id="${c.id}" data-sid="${sk.id}" style="float:right;cursor:pointer">✕</i>
                </div>`).join('') || '<div class="stmem-hint">暂无</div>'}
            <div class="stmem-add-row">
                <input type="text" id="stmem-add-skill-name" placeholder="技能名">
                <input type="text" id="stmem-add-skill-desc" placeholder="简述（可空）">
                <button data-act="skill-add" data-id="${c.id}">＋</button>
            </div>
        </div>

        <div class="stmem-card">
            <h4>关系网</h4>
            ${c.relations.map(r => `
                <div class="stmem-kv">
                    <b>${esc(r.target)}</b>${esc(r.relation)}${r.note ? '（' + esc(r.note) + '）' : ''}
                    <i class="stmem-x" data-act="rel-del" data-id="${c.id}" data-sid="${r.id}" style="float:right;cursor:pointer">✕</i>
                </div>`).join('') || '<div class="stmem-hint">暂无</div>'}
            <div class="stmem-add-row">
                <input type="text" id="stmem-add-rel-target" placeholder="对象">
                <input type="text" id="stmem-add-rel-rel" placeholder="关系">
                <button data-act="rel-add" data-id="${c.id}">＋</button>
            </div>
        </div>

        <div class="stmem-card">
            <h4>财产（物品与生物）</h4>
            ${c.property.map(p => `
                <div class="stmem-kv">
                    <b>${esc(p.name)}</b>[${esc(p.kind)}]${p.note ? ' ' + esc(p.note) : ''}
                    <i class="stmem-x" data-act="prop-del" data-id="${c.id}" data-sid="${p.id}" style="float:right;cursor:pointer">✕</i>
                </div>`).join('') || '<div class="stmem-hint">暂无</div>'}
            <div class="stmem-add-row">
                <input type="text" id="stmem-add-prop-name" placeholder="名称">
                <input type="text" id="stmem-add-prop-kind" placeholder="类别(物品/生物)">
                <button data-act="prop-add" data-id="${c.id}">＋</button>
            </div>
        </div>

        <div class="stmem-card">
            <h4>自定义字段</h4>
            ${customFields || '<div class="stmem-hint">暂无</div>'}
            <div class="stmem-add-row">
                <input type="text" id="stmem-add-field-name" placeholder="字段名（如：内伤、身份）">
                <button data-act="field-add" data-id="${c.id}">＋</button>
            </div>
        </div>`;
}

/* --------------------------------------------------------------------------
 * 标签页：物品 / 环境 / 社会结构
 * ------------------------------------------------------------------------ */

function renderItemsTab() {
    const store = getStore();
    const rows = store.items.map(it => `
        <div class="stmem-item">
            <div class="stmem-item-head">
                <span class="stmem-item-name">🗡️ ${esc(it.name)}</span>
                <span class="stmem-badge">${esc(it.integrity || '完好')}</span>
                <button class="stmem-btn-mini" data-act="rule-open-item" data-id="${it.id}">规则</button>
                <button class="stmem-btn-mini stmem-btn-danger" data-act="item-del" data-id="${it.id}">删</button>
            </div>
            <div class="stmem-item-body">
                <div class="stmem-field"><label>简略描述</label><textarea data-field="item-brief" data-id="${it.id}">${esc(it.brief)}</textarea></div>
                <div class="stmem-field"><label>功能特性</label><textarea data-field="item-func" data-id="${it.id}">${esc(it.func)}</textarea></div>
                <div class="stmem-row">
                    <div class="stmem-field"><label>归属</label><input type="text" data-field="item-owner" data-id="${it.id}" value="${esc(it.owner)}"></div>
                    <div class="stmem-field"><label>完整度</label><input type="text" data-field="item-integrity" data-id="${it.id}" value="${esc(it.integrity)}"></div>
                </div>
            </div>
        </div>`).join('');

    return `
        ${ruleEditorHtml()}
        <div class="stmem-toolbar">
            <button data-act="item-add">＋ 新增物品</button>
            <button data-act="rule-open" data-cat="items">⚙️ 类目注入规则</button>
            <span class="stmem-spacer"></span>
            <span class="stmem-badge">${store.items.length} 件</span>
        </div>
        ${rows || '<div class="stmem-empty">暂无物品档案</div>'}`;
}

function renderEnvsTab() {
    const store = getStore();
    const rows = store.envs.map(e => `
        <div class="stmem-item">
            <div class="stmem-item-head">
                <span class="stmem-item-name">🏞️ ${esc(e.name)}</span>
                <button class="stmem-btn-mini" data-act="rule-open-env" data-id="${e.id}">规则</button>
                <button class="stmem-btn-mini stmem-btn-danger" data-act="env-del" data-id="${e.id}">删</button>
            </div>
            <div class="stmem-item-body">
                <div class="stmem-field"><label>概况</label><textarea data-field="env-overview" data-id="${e.id}">${esc(e.overview)}</textarea></div>
                <div class="stmem-field"><label>布局变化（新增建筑/家具/破坏/损毁，累积）</label></div>
                ${chipList(e.layout, 'layout-del')}
                <div class="stmem-add-row">
                    <input type="text" id="stmem-add-layout-${e.id}" placeholder="手动补充布局变化…">
                    <button data-act="layout-add" data-id="${e.id}">＋</button>
                </div>
            </div>
        </div>`).join('');

    return `
        ${ruleEditorHtml()}
        <div class="stmem-toolbar">
            <button data-act="env-add">＋ 新增环境</button>
            <button data-act="rule-open" data-cat="envs">⚙️ 类目注入规则</button>
            <span class="stmem-spacer"></span>
            <span class="stmem-badge">${store.envs.length} 处</span>
        </div>
        ${rows || '<div class="stmem-empty">暂无环境档案</div>'}`;
}

function renderSocTab() {
    const store = getStore();
    const rows = store.societies.map(o => `
        <div class="stmem-item">
            <div class="stmem-item-head">
                <span class="stmem-item-name">🏛️ ${esc(o.name)}</span>
                <span class="stmem-badge">${esc(o.type || '组织')}</span>
                <button class="stmem-btn-mini" data-act="rule-open-soc" data-id="${o.id}">规则</button>
                <button class="stmem-btn-mini stmem-btn-danger" data-act="soc-del" data-id="${o.id}">删</button>
            </div>
            <div class="stmem-item-body">
                <div class="stmem-row">
                    <div class="stmem-field"><label>类型（势力/宗教/组织/单位/社交圈）</label>
                        <input type="text" data-field="soc-type" data-id="${o.id}" value="${esc(o.type)}"></div>
                </div>
                <div class="stmem-field"><label>描述</label><textarea data-field="soc-desc" data-id="${o.id}">${esc(o.desc)}</textarea></div>
            </div>
        </div>`).join('');

    return `
        ${ruleEditorHtml()}
        <div class="stmem-toolbar">
            <button data-act="soc-add">＋ 新增社会结构</button>
            <button data-act="rule-open" data-cat="soc">⚙️ 类目注入规则</button>
            <span class="stmem-spacer"></span>
            <span class="stmem-badge">${store.societies.length} 个</span>
        </div>
        ${rows || '<div class="stmem-empty">暂无社会结构档案</div>'}`;
}

/* --------------------------------------------------------------------------
 * 标签页：自定义类目（条目 = 名称 + 注入规则 + 内容）
 * ------------------------------------------------------------------------ */

function renderCustomTab() {
    const store = getStore();
    const cats = store.customCats.map(cat => `
        <div class="stmem-card">
            <h4>📁 ${esc(cat.name)}
                <span class="stmem-mini-actions">
                    <button class="stmem-btn-mini" data-act="rule-open-cat" data-id="${cat.id}">规则</button>
                    <button class="stmem-btn-mini" data-act="cat-rename" data-id="${cat.id}">改名</button>
                    <button class="stmem-btn-mini stmem-btn-danger" data-act="cat-del" data-id="${cat.id}">删</button>
                </span>
            </h4>
            ${cat.entries.map(en => `
                <div class="stmem-item">
                    <div class="stmem-item-head">
                        <span class="stmem-item-name">${esc(en.name)}</span>
                        <button class="stmem-btn-mini" data-act="rule-open-entry" data-id="${cat.id}" data-eid="${en.id}">规则</button>
                        <button class="stmem-btn-mini stmem-btn-danger" data-act="entry-del" data-id="${cat.id}" data-eid="${en.id}">删</button>
                    </div>
                    <div class="stmem-item-body">
                        <textarea data-field="entry-content" data-id="${cat.id}" data-eid="${en.id}">${esc(en.content)}</textarea>
                    </div>
                </div>`).join('') || '<div class="stmem-hint">暂无条目，AI 提取时也会自动填充</div>'}
            <div class="stmem-add-row">
                <input type="text" id="stmem-add-entry-${cat.id}" placeholder="新增条目名称…">
                <button data-act="entry-add" data-id="${cat.id}">＋</button>
            </div>
        </div>`).join('');

    return `
        ${ruleEditorHtml()}
        <div class="stmem-toolbar">
            <button data-act="cat-add">＋ 新增一级类目</button>
            <span class="stmem-spacer"></span>
            <span class="stmem-badge">${store.customCats.length} 类</span>
        </div>
        <div class="stmem-hint" style="margin-bottom:8px">
            自定义类目会进入 AI 提取范围，聊天中相关信息会自动归纳到对应类目下；每条目都可单独设置注入规则。
        </div>
        ${cats || '<div class="stmem-empty">暂无自定义类目</div>'}`;
}

/* --------------------------------------------------------------------------
 * 标签页：设置
 * ------------------------------------------------------------------------ */

function renderSettingsTab() {
    const s = settings();
    const m = meta();
    const chat = getContext().chat || [];
    const pending = Math.max(0, chat.length - (m.lastExtractedIndex || 0));

    return `
    <div class="stmem-card">
        <h4>提取</h4>
        <div class="stmem-check">
            <input type="checkbox" id="stmem-set-enabled" ${s.enabled ? 'checked' : ''}>
            <span>启用自动提取（每 N 楼一次）</span>
        </div>
        <div class="stmem-row">
            <div class="stmem-field"><label>每 N 楼提取</label>
                <input type="number" id="stmem-set-interval" min="1" max="50" value="${s.floorInterval}"></div>
            <div class="stmem-field"><label>单次合并楼层</label>
                <input type="number" id="stmem-set-batch" min="1" max="30" value="${s.batchSize}"></div>
        </div>
        <div class="stmem-hint">待提取楼层：${pending} / 共 ${chat.length} 楼（swipe 重新生成会自动撤回旧提取，以最终采用为准）</div>
        <div class="stmem-row" style="margin-top:8px">
            <button class="stmem-btn-primary" data-act="extract-now">立即提取</button>
            <button data-act="backfill">从历史聊天回填</button>
        </div>
        <div class="stmem-progress" id="stmem-backfill-bar" style="display:none"><div></div></div>
        <div class="stmem-row">
            <button class="stmem-btn-danger" data-act="backfill-cancel" style="display:none" id="stmem-backfill-cancel">取消回填</button>
        </div>
    </div>

    <div class="stmem-card">
        <h4>副 API（提取专用，省钱不干扰主对话）</h4>
        <div class="stmem-check">
            <input type="checkbox" id="stmem-set-usesub" ${s.useSubApi ? 'checked' : ''}>
            <span>使用副 API 做后台提取（OpenAI 兼容接口）</span>
        </div>
        <div class="stmem-field"><label>Base URL（如 https://api.deepseek.com/v1）</label>
            <input type="url" id="stmem-set-suburl" value="${esc(s.subApi.baseUrl)}" placeholder="https://…/v1"></div>
        <div class="stmem-field"><label>API Key</label>
            <input type="password" id="stmem-set-subkey" value="${esc(s.subApi.apiKey)}"></div>
        <div class="stmem-row">
            <div class="stmem-field"><label>模型</label>
                <input type="text" id="stmem-set-submodel" value="${esc(s.subApi.model)}" placeholder="deepseek-chat"></div>
            <div class="stmem-field"><label>最大返回 tokens</label>
                <input type="number" id="stmem-set-subtokens" min="256" max="8000" value="${s.subApi.maxTokens}"></div>
        </div>
        <div class="stmem-check">
            <input type="checkbox" id="stmem-set-subjson" ${s.subApi.jsonMode ? 'checked' : ''}>
            <span>请求 JSON 模式（response_format，接口支持时再开）</span>
        </div>
        <div class="stmem-hint">不开启副 API 时，提取走主对话的同一个 API（静默生成）。副 API 由浏览器直连，需接口允许跨域。</div>
    </div>

    <div class="stmem-card">
        <h4>存储</h4>
        <div class="stmem-check">
            <input type="checkbox" id="stmem-set-global" ${s.globalLibrary ? 'checked' : ''}>
            <span>全局库（所有聊天共用一份档案；默认按聊天隔离）</span>
        </div>
        <div class="stmem-row">
            <button data-act="export">导出数据 (JSON)</button>
            <button data-act="import">导入数据</button>
            <button class="stmem-btn-danger" data-act="wipe">清空当前库</button>
        </div>
        <input type="file" id="stmem-import-file" accept=".json,application/json" style="display:none">
        <div class="stmem-hint">当前库位置：${s.globalLibrary ? '全局（所有聊天共享）' : '本聊天（metadata 隔离）'}。提取进度与报错始终按聊天隔离。</div>
    </div>

    <div class="stmem-card">
        <h4>注入</h4>
        <div class="stmem-check">
            <input type="checkbox" id="stmem-set-inject" ${s.injectMaster ? 'checked' : ''}>
            <span>注入总开关（把记忆写入提示词）</span>
        </div>
        <div class="stmem-field"><label>「最近提及 / 关键词」参考最近 K 楼</label>
            <input type="number" id="stmem-set-recent" min="1" max="100" value="${s.recentRange}"></div>
        <div class="stmem-hint">各一级类目的注入规则（开关/模式/关键词/深度）在对应标签页顶部的「⚙️ 类目注入规则」里设置；单条条目可再覆盖。</div>
    </div>`;
}

/* --------------------------------------------------------------------------
 * 标签页：报错
 * ------------------------------------------------------------------------ */

function renderErrorsTab() {
    const m = meta();
    const rows = m.errors.map(e => `
        <div class="stmem-err">
            <span class="stmem-err-type">${esc(e.type)}</span>
            <span class="stmem-err-time">${esc(e.t)}</span>
            <div>${esc(e.msg)}</div>
            ${e.detail ? `<pre>${esc(e.detail)}</pre>` : ''}
        </div>`).join('');

    return `
        <div class="stmem-toolbar">
            <button data-act="err-retry" class="stmem-btn-primary">重试提取</button>
            <button data-act="err-copy">复制全部</button>
            <button data-act="err-clear" class="stmem-btn-danger">清空</button>
            <span class="stmem-spacer"></span>
            <span class="stmem-badge">${m.errors.length}/${MAX_ERRORS}</span>
        </div>
        ${rows || '<div class="stmem-empty">没有报错，一切正常 ✅</div>'}`;
}

/* --------------------------------------------------------------------------
 * 标签页：统计（简化版）
 * ------------------------------------------------------------------------ */

function renderStatsTab() {
    const store = getStore();
    const m = meta();
    const chat = getContext().chat || [];
    const cnt = {
        人物: store.characters.length,
        物品: store.items.length,
        环境: store.envs.length,
        社会结构: store.societies.length,
        自定义类目: store.customCats.length,
        自定义条目: store.customCats.reduce((n, c) => n + c.entries.length, 0),
    };
    const cell = (num, label) => `
        <div class="stmem-stat"><div class="stmem-stat-num">${num}</div><div class="stmem-stat-label">${label}</div></div>`;

    return `
        <div class="stmem-stat-grid">
            ${cell(cnt.人物, '人物档案')}
            ${cell(cnt.物品, '物品档案')}
            ${cell(cnt.环境, '环境档案')}
            ${cell(cnt.社会结构, '社会结构')}
            ${cell(cnt.自定义类目, '自定义类目')}
            ${cell(cnt.自定义条目, '自定义条目')}
        </div>
        <div class="stmem-card" style="margin-top:10px">
            <div class="stmem-kv"><b>提取进度</b>${m.lastExtractedIndex || 0} / ${chat.length} 楼</div>
            <div class="stmem-kv"><b>累计提取次数</b>${m.stats.extractions}</div>
            <div class="stmem-kv"><b>上次提取</b>${esc(m.stats.lastTime || '—')}</div>
            <div class="stmem-kv"><b>当前注入量</b>${m.stats.injectedChars} 字符</div>
            <div class="stmem-kv"><b>报错数</b>${m.errors.length}</div>
            <div class="stmem-kv"><b>库位置</b>${settings().globalLibrary ? '全局库' : '本聊天'}</div>
        </div>`;
}

/* --------------------------------------------------------------------------
 * 面板交互：点击 / 修改 委托
 * ------------------------------------------------------------------------ */

function val(id) {
    return document.getElementById(id)?.value?.trim() || '';
}

function findEntryParent(listGetter, entryId) {
    // 在指定列表集合里按条目 id 找宿主（用于 chip 删除）
    for (const owner of listGetter()) {
        for (const key of ['appearance', 'talent', 'layout']) {
            const arr = owner[key];
            if (!Array.isArray(arr)) continue;
            const i = arr.findIndex(x => x.id === entryId);
            if (i >= 0) return { owner, arr, index: i };
        }
    }
    return null;
}

function onBodyClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const id = el.dataset.id;
    const sid = el.dataset.sid;
    const store = getStore();
    const s = settings();
    const char = id ? store.characters.find(c => c.id === id) : null;

    const save = () => { saveStore(); refreshInjection(); };
    const rerender = () => { save(); renderBody(); };

    switch (act) {
        /* ----- 通用 / 规则 ----- */
        case 'rule-close': saveRuleEditor(); ruleEditTarget = null; renderBody(); return;
        case 'rule-open': openRuleEditor(s.rules[el.dataset.cat], { chars: '人物类目', items: '物品类目', envs: '环境类目', soc: '社会结构类目' }[el.dataset.cat] || '类目'); return;
        case 'rule-open-char': if (char) { char.rule ??= { ...defaultRule(), enabled: true }; openRuleEditor(char.rule, `人物·${char.name}`); } return;
        case 'rule-open-field': {
            const f = char?.customFields.find(x => x.id === el.dataset.fid);
            if (f) { f.rule ??= { enabled: true, mode: 'always', keywords: [] }; openRuleEditor(f.rule, `字段·${f.name}`); }
            return;
        }
        case 'rule-open-item': case 'rule-open-env': case 'rule-open-soc': {
            const list = { 'rule-open-item': store.items, 'rule-open-env': store.envs, 'rule-open-soc': store.societies }[act];
            const o = list.find(x => x.id === id);
            if (o) { o.rule ??= { enabled: true, mode: 'always', keywords: [] }; openRuleEditor(o.rule, `条目·${o.name}`); }
            return;
        }
        case 'rule-open-cat': {
            const cat = store.customCats.find(x => x.id === id);
            if (cat) { cat.rule ??= defaultRule(); openRuleEditor(cat.rule, `自定义类目·${cat.name}`); }
            return;
        }
        case 'rule-open-entry': {
            const cat = store.customCats.find(x => x.id === id);
            const en = cat?.entries.find(x => x.id === el.dataset.eid);
            if (en) { en.rule ??= { enabled: true, mode: 'always', keywords: [] }; openRuleEditor(en.rule, `自定义条目·${en.name}`); }
            return;
        }

        /* ----- 提取 / 回填 ----- */
        case 'extract-now': extractNow(); return;
        case 'backfill': backfill(); return;
        case 'backfill-cancel': backfillCancel = true; return;

        /* ----- 人物 ----- */
        case 'char-add': {
            const name = prompt('人物名称：');
            if (!name?.trim()) return;
            const c = newCharacter(name.trim());
            store.characters.push(c);
            detailCharId = c.id;
            rerender(); return;
        }
        case 'char-open': detailCharId = id; renderBody(); return;
        case 'char-back': detailCharId = null; renderBody(); return;
        case 'char-del': {
            if (!char || !confirm(`删除人物「${char.name}」的全部档案？`)) return;
            store.characters.splice(store.characters.indexOf(char), 1);
            if (detailCharId === id) detailCharId = null;
            rerender(); return;
        }
        case 'char-rename': {
            if (!char) return;
            const name = prompt('新名称：', char.name);
            if (name?.trim()) { char.name = name.trim(); rerender(); }
            return;
        }
        case 'app-add': {
            const t = val('stmem-add-app');
            if (char && t) { char.appearance.push({ id: uid(), text: t, floor: -1 }); rerender(); }
            return;
        }
        case 'talent-add': {
            const t = val('stmem-add-talent');
            if (char && t) { char.talent.push({ id: uid(), text: t }); rerender(); }
            return;
        }
        case 'skill-add': {
            const n = val('stmem-add-skill-name');
            if (char && n) { char.skills.push({ id: uid(), name: n, desc: val('stmem-add-skill-desc') }); rerender(); }
            return;
        }
        case 'rel-add': {
            const t = val('stmem-add-rel-target');
            if (char && t) { char.relations.push({ id: uid(), target: t, relation: val('stmem-add-rel-rel'), note: '' }); rerender(); }
            return;
        }
        case 'prop-add': {
            const n = val('stmem-add-prop-name');
            if (char && n) { char.property.push({ id: uid(), name: n, kind: val('stmem-add-prop-kind') || '物品', note: '' }); rerender(); }
            return;
        }
        case 'field-add': {
            const n = val('stmem-add-field-name');
            if (char && n) { char.customFields.push({ id: uid(), name: n, rule: null, content: '' }); rerender(); }
            return;
        }
        case 'app-del': case 'talent-del': case 'layout-del': {
            const found = findEntryParent(() => store.characters.concat(store.envs), id);
            if (found) { found.arr.splice(found.index, 1); rerender(); }
            return;
        }
        case 'skill-del': case 'rel-del': case 'prop-del': {
            if (!char) return;
            const key = { 'skill-del': 'skills', 'rel-del': 'relations', 'prop-del': 'property' }[act];
            const i = char[key].findIndex(x => x.id === sid);
            if (i >= 0) { char[key].splice(i, 1); rerender(); }
            return;
        }
        case 'field-del': {
            if (!char) return;
            const i = char.customFields.findIndex(x => x.id === el.dataset.fid);
            if (i >= 0) { char.customFields.splice(i, 1); rerender(); }
            return;
        }
        case 'suggest-ok': case 'suggest-no': {
            if (!char) return;
            const i = char.appearanceSuggest.findIndex(x => x.id === sid);
            if (i < 0) return;
            const sg = char.appearanceSuggest[i];
            if (act === 'suggest-ok') {
                // 找到与旧描述匹配的外貌条目进行替换；找不到则追加为新条目
                const hit = char.appearance.find(a => sg.oldText && (a.text.includes(sg.oldText) || sg.oldText.includes(a.text)));
                if (hit) hit.text = sg.newText;
                else char.appearance.push({ id: uid(), text: sg.newText, floor: -1 });
                toast('已替换外貌描述', 'success');
            }
            char.appearanceSuggest.splice(i, 1);
            rerender(); return;
        }

        /* ----- 物品 / 环境 / 社会 ----- */
        case 'item-add': {
            const n = prompt('物品名称：');
            if (n?.trim()) { store.items.push({ id: uid(), name: n.trim(), brief: '', func: '', owner: '', integrity: '完好', rule: null }); rerender(); }
            return;
        }
        case 'item-del': {
            const i = store.items.findIndex(x => x.id === id);
            if (i >= 0 && confirm(`删除物品「${store.items[i].name}」？`)) { store.items.splice(i, 1); rerender(); }
            return;
        }
        case 'env-add': {
            const n = prompt('环境/地点名称：');
            if (n?.trim()) { store.envs.push({ id: uid(), name: n.trim(), overview: '', layout: [], rule: null }); rerender(); }
            return;
        }
        case 'env-del': {
            const i = store.envs.findIndex(x => x.id === id);
            if (i >= 0 && confirm(`删除环境「${store.envs[i].name}」？`)) { store.envs.splice(i, 1); rerender(); }
            return;
        }
        case 'layout-add': {
            const env = store.envs.find(x => x.id === id);
            const t = val('stmem-add-layout-' + id);
            if (env && t) { env.layout.push({ id: uid(), text: t, floor: -1 }); rerender(); }
            return;
        }
        case 'soc-add': {
            const n = prompt('名称（势力/宗教/组织/单位/社交圈）：');
            if (n?.trim()) { store.societies.push({ id: uid(), name: n.trim(), type: '', desc: '', rule: null }); rerender(); }
            return;
        }
        case 'soc-del': {
            const i = store.societies.findIndex(x => x.id === id);
            if (i >= 0 && confirm(`删除「${store.societies[i].name}」？`)) { store.societies.splice(i, 1); rerender(); }
            return;
        }

        /* ----- 自定义类目 ----- */
        case 'cat-add': {
            const n = prompt('一级类目名称：');
            if (n?.trim()) { store.customCats.push({ id: uid(), name: n.trim(), rule: defaultRule(), entries: [] }); rerender(); }
            return;
        }
        case 'cat-del': {
            const i = store.customCats.findIndex(x => x.id === id);
            if (i >= 0 && confirm(`删除类目「${store.customCats[i].name}」及其全部条目？`)) {
                setPromptSafe(PROMPT_KEY_PREFIX + 'custom_' + id, '', 4);
                store.customCats.splice(i, 1);
                rerender();
            }
            return;
        }
        case 'cat-rename': {
            const cat = store.customCats.find(x => x.id === id);
            if (!cat) return;
            const n = prompt('新类目名：', cat.name);
            if (n?.trim()) { cat.name = n.trim(); rerender(); }
            return;
        }
        case 'entry-add': {
            const cat = store.customCats.find(x => x.id === id);
            const n = val('stmem-add-entry-' + id);
            if (cat && n) { cat.entries.push({ id: uid(), name: n, rule: null, content: '' }); rerender(); }
            return;
        }
        case 'entry-del': {
            const cat = store.customCats.find(x => x.id === id);
            const i = cat?.entries.findIndex(x => x.id === el.dataset.eid) ?? -1;
            if (cat && i >= 0) { cat.entries.splice(i, 1); rerender(); }
            return;
        }

        /* ----- 数据 ----- */
        case 'export': exportData(); return;
        case 'import': document.getElementById('stmem-import-file')?.click(); return;
        case 'wipe': {
            if (!confirm('清空当前记忆库的全部档案？（提取进度保留，不会自动重建）')) return;
            if (!confirm('再次确认：此操作不可恢复，建议先导出备份。继续清空？')) return;
            replaceStoreData(defaultStore());
            meta().snapshots = [];
            saveMeta();
            rerender();
            toast('已清空当前库');
            return;
        }

        /* ----- 报错 ----- */
        case 'err-retry': retryLast(); return;
        case 'err-copy': {
            const text = meta().errors.map(x => `[${x.t}] ${x.type}: ${x.msg}\n${x.detail}`).join('\n\n') || '（无报错）';
            navigator.clipboard?.writeText(text).then(() => toast('已复制', 'success'), () => toast('复制失败', 'error'));
            return;
        }
        case 'err-clear': meta().errors = []; saveMeta(); renderBody(); return;
    }
}

function onBodyChange(e) {
    const t = e.target;
    const store = getStore();
    const s = settings();
    const save = () => { saveStore(); refreshInjection(); };

    /* 规则编辑器 */
    if (t.id?.startsWith('stmem-rule-')) { saveRuleEditor(); return; }

    /* 导入文件 */
    if (t.id === 'stmem-import-file') { importData(t.files?.[0]); t.value = ''; return; }

    /* 设置项 */
    if (t.id?.startsWith('stmem-set-')) {
        switch (t.id) {
            case 'stmem-set-enabled': s.enabled = t.checked; break;
            case 'stmem-set-interval': s.floorInterval = clampInt(t.value, 1, 50, 6); break;
            case 'stmem-set-batch': s.batchSize = clampInt(t.value, 1, 30, 6); break;
            case 'stmem-set-usesub': s.useSubApi = t.checked; break;
            case 'stmem-set-suburl': s.subApi.baseUrl = t.value.trim(); break;
            case 'stmem-set-subkey': s.subApi.apiKey = t.value.trim(); break;
            case 'stmem-set-submodel': s.subApi.model = t.value.trim(); break;
            case 'stmem-set-subtokens': s.subApi.maxTokens = clampInt(t.value, 256, 8000, 2000); break;
            case 'stmem-set-subjson': s.subApi.jsonMode = t.checked; break;
            case 'stmem-set-global':
                s.globalLibrary = t.checked;
                toast(t.checked ? '已切换到全局库' : '已切换到本聊天独立库');
                break;
            case 'stmem-set-inject': s.injectMaster = t.checked; break;
            case 'stmem-set-recent': s.recentRange = clampInt(t.value, 1, 100, 10); break;
        }
        saveSettings();
        refreshInjection();
        if (['stmem-set-global'].includes(t.id)) renderBody();
        return;
    }

    /* 条目字段编辑 */
    const field = t.dataset?.field;
    if (!field) return;
    const id = t.dataset.id;
    const value = t.value;

    if (field.startsWith('char-')) {
        const c = store.characters.find(x => x.id === id);
        if (!c) return;
        if (field === 'char-health') c.statusHealth = { text: value, floor: c.statusHealth.floor };
        else if (field === 'char-look') c.statusLook = { text: value, floor: c.statusLook.floor };
        else if (field === 'char-custom-content') {
            const f = c.customFields.find(x => x.id === t.dataset.fid);
            if (f) f.content = value;
        }
        save(); return;
    }
    if (field.startsWith('item-')) {
        const o = store.items.find(x => x.id === id);
        if (!o) return;
        if (field === 'item-brief') o.brief = value;
        else if (field === 'item-func') o.func = value;
        else if (field === 'item-owner') o.owner = value;
        else if (field === 'item-integrity') o.integrity = value;
        save(); return;
    }
    if (field === 'env-overview') {
        const o = store.envs.find(x => x.id === id);
        if (o) { o.overview = value; save(); }
        return;
    }
    if (field.startsWith('soc-')) {
        const o = store.societies.find(x => x.id === id);
        if (!o) return;
        if (field === 'soc-type') o.type = value;
        else if (field === 'soc-desc') o.desc = value;
        save(); return;
    }
    if (field === 'entry-content') {
        const cat = store.customCats.find(x => x.id === id);
        const en = cat?.entries.find(x => x.id === t.dataset.eid);
        if (en) { en.content = value; save(); }
        return;
    }
}

/* --------------------------------------------------------------------------
 * 回填进度 / 导入导出
 * ------------------------------------------------------------------------ */

function updateBackfillProgress(done, total) {
    const bar = document.getElementById('stmem-backfill-bar');
    const cancelBtn = document.getElementById('stmem-backfill-cancel');
    if (!bar) return;
    if (done === -2) return; // 仅刷新
    if (done < 0) { // 结束
        bar.style.display = 'none';
        if (cancelBtn) cancelBtn.style.display = 'none';
        return;
    }
    bar.style.display = 'block';
    if (cancelBtn) cancelBtn.style.display = 'inline-block';
    const pct = total ? Math.round(done / total * 100) : 0;
    bar.firstElementChild.style.width = pct + '%';
    bar.title = `${done}/${total}`;
}

function exportData() {
    const payload = {
        plugin: EXT,
        version: VERSION,
        exportedAt: new Date().toISOString(),
        scope: settings().globalLibrary ? 'global' : 'chat',
        store: getStore(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `记忆库备份-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('已导出', 'success');
}

function importData(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        try {
            const data = JSON.parse(reader.result);
            const store = data.store || data; // 兼容纯 store 导出
            if (!store || typeof store !== 'object' || !Array.isArray(store.characters)) {
                throw new Error('文件不是有效的记忆库备份');
            }
            if (!confirm('导入将覆盖当前库（可先导出备份）。继续？')) return;
            replaceStoreData(mergeDefaults(store, defaultStore()));
            saveStore();
            refreshInjection();
            renderBody();
            toast('导入完成', 'success');
        } catch (e) {
            logError('导入失败', e.message || e, file.name);
            toast('导入失败：' + (e.message || e), 'error');
        }
    };
    reader.readAsText(file);
}

/* --------------------------------------------------------------------------
 * 扩展面板入口 + 初始化
 * ------------------------------------------------------------------------ */

function addExtensionSettingsRow() {
    const container = document.getElementById('extensions_settings');
    if (!container || document.getElementById('stmem-ext-row')) return;
    const row = document.createElement('div');
    row.id = 'stmem-ext-row';
    row.className = 'extension_container';
    row.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🧠 人物记忆库</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="stmem-hint" style="margin:6px 0">人物 / 物品 / 环境 / 社会结构记忆，自动提取、自定义注入。悬浮球在聊天界面右下角（可拖动）。</div>
                <button class="menu_button" id="stmem-open-panel">打开记忆面板</button>
            </div>
        </div>`;
    container.appendChild(row);
    row.querySelector('#stmem-open-panel').addEventListener('click', openDrawer);
}

jQuery(async () => {
    settings();          // 初始化设置默认值
    ensureBall();
    ensureDrawer();
    wireEvents();
    addExtensionSettingsRow();
    refreshInjection();
    console.log(`[记忆库] v${VERSION} 已加载`);
});
