/* ============================================================
 * 记忆助手 v1.0.0（酒馆原生拓展版 · memory-assistant）
 * 人物 · 物品 · 环境 · 社会结构 特征记忆
 * 后台 AI 提取（主API静默生成 / 副API直连）｜ 提示词注入 ｜ 手机端抽屉面板
 * 原生拓展直接运行在主页面：无 iframe 隔离、无实例抢占、事件/注入走酒馆官方通道
 * ============================================================ */
(async () => {
'use strict';
const TAG = '[记忆助手]';

/* ==================== 0. 平台接入（SillyTavern 原生） ==================== */
const P = window, PD = document;
const EXT_KEY = 'memory_assistant';
const VAR_CHAT_KEY = '记忆助手变量';
const EXT_VERSION = '1.0.0';

const ST = (() => {
  try { if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') return window.SillyTavern; } catch (e) {}
  return null;
})();
const ctx = () => { try { return ST ? ST.getContext() : null; } catch (e) { return null; } };
if (!ST) console.error(TAG, '未检测到 SillyTavern 全局对象（酒馆版本过旧），请升级酒馆');

function extStore() {
  try {
    const c = ctx(); if (!c) return {};
    const s = c.extensionSettings;
    if (!s[EXT_KEY] || typeof s[EXT_KEY] !== 'object' || Array.isArray(s[EXT_KEY])) s[EXT_KEY] = {};
    return s[EXT_KEY];
  } catch (e) { return {}; }
}
function saveExt() { try { const c = ctx(); if (c && c.saveSettingsDebounced) c.saveSettingsDebounced(); } catch (e) {} }
function saveChatMeta() { try { const c = ctx(); if (c && c.saveMetadataDebounced) c.saveMetadataDebounced(); } catch (e) {} }
function 角色映射(r) {
  const m = { system: 0, user: 1, assistant: 2 };
  const v = m[String(r || 'system').toLowerCase()];
  return typeof v === 'number' ? v : 0;
}

const api = {
  eventOn: (evt, fn) => { try { const c = ctx(); if (!c || !c.eventSource) return false; c.eventSource.on(evt, fn); return true; } catch (e) { return false; } },
  getVariables: ({ type }) => {
    try {
      if (type === 'chat') {
        const c = ctx(); const md = c && c.chatMetadata;
        const v = md ? md[VAR_CHAT_KEY] : null;
        return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
      }
      const s = extStore();
      const k = type === 'global' ? '全局变量' : '脚本变量';
      const v = s[k];
      return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    } catch (e) { return {}; }
  },
  insertOrAssignVariables: (vars, { type }) => {
    const cur = api.getVariables({ type });
    return api.replaceVariables(Object.assign({}, cur, vars), { type });
  },
  replaceVariables: (vars, { type }) => {
    try {
      if (type === 'chat') {
        const c = ctx(); if (!c) return Promise.resolve();
        c.chatMetadata[VAR_CHAT_KEY] = vars;
        saveChatMeta();
      } else {
        const s = extStore();
        s[type === 'global' ? '全局变量' : '脚本变量'] = vars;
        saveExt();
      }
    } catch (e) {}
    return Promise.resolve();
  },
  getChatMessages: (range) => {
    try {
      const c = ctx(); const chat = (c && c.chat) || [];
      let from = 0, to = chat.length - 1;
      const m = String(range).match(/^(-?\d+)(?:-(-?\d+))?$/);
      if (m) {
        if (m[2] === undefined) {
          const n = parseInt(m[1], 10);
          if (n < 0) from = Math.max(0, chat.length + n);
          else { from = n; to = n; }
        } else { from = Math.max(0, parseInt(m[1], 10)); to = Math.min(chat.length - 1, parseInt(m[2], 10)); }
      }
      const out = [];
      for (let i = from; i <= to; i++) {
        const it = chat[i];
        if (!it) continue;
        out.push({
          message: String(it.mes == null ? '' : it.mes),
          message_id: i,
          name: it.name || '',
          role: it.is_user ? 'user' : 'assistant',
          is_hidden: !!it.is_system,
        });
      }
      return out;
    } catch (e) { return []; }
  },
  getLastMessageId: () => { try { const c = ctx(); return ((c && c.chat) || []).length - 1; } catch (e) { return -1; } },
  generateRaw: async (opt) => {
    const userPrompt = String((opt && opt.user_input) || '');
    let sysPrompt = '';
    try { const op = opt && opt.ordered_prompts; sysPrompt = (op && op[0] && typeof op[0].content === 'string') ? op[0].content : ''; } catch (e) {}
    const sub = opt && opt.custom_api;
    if (sub && sub.apiurl) {
      /* 副API：浏览器直连 OpenAI 兼容端点。注意：需服务商允许浏览器跨域（CORS），否则换主API静默生成 */
      const url = String(sub.apiurl).replace(/\/+$/, '') + '/chat/completions';
      const headers = { 'Content-Type': 'application/json' };
      if (sub.key) headers['Authorization'] = 'Bearer ' + sub.key;
      const resp = await fetch(url, {
        method: 'POST', headers,
        body: JSON.stringify({
          model: sub.model || '', temperature: 0.2, stream: false,
          messages: (sysPrompt ? [{ role: 'system', content: sysPrompt }] : []).concat([{ role: 'user', content: userPrompt }]),
        }),
      });
      if (!resp.ok) { const t = await resp.text().catch(() => ''); throw new Error('副API HTTP ' + resp.status + (t ? '：' + t.slice(0, 160) : '')); }
      const data = await resp.json();
      const msg = data && data.choices && data.choices[0] && data.choices[0].message;
      return (msg && typeof msg.content === 'string') ? msg.content : '';
    }
    /* 主API：静默生成——不进聊天记录、不占用聊天上下文、不打扰当前生成 */
    const c = ctx();
    if (!c || !c.generateQuietPrompt) throw new Error('当前酒馆版本不支持静默生成（generateQuietPrompt）');
    const full = sysPrompt ? (sysPrompt + '\n\n' + userPrompt) : userPrompt;
    const r = await c.generateQuietPrompt({ quietPrompt: full, skipWIAN: true });
    return typeof r === 'string' ? r : String(r == null ? '' : r);
  },
  injectPrompts: (prompts) => {
    const c = ctx(); if (!c || !c.setExtensionPrompt) return;
    for (const p of prompts) {
      try { c.setExtensionPrompt(String(p.id), String(p.content || ''), 1, Math.max(0, parseInt(p.depth, 10) || 0), true, 角色映射(p.role)); } catch (e) {}
    }
  },
  uninjectPrompts: (ids) => {
    const c = ctx(); if (!c || !c.setExtensionPrompt) return;
    for (const id of ids) { try { c.setExtensionPrompt(String(id), '', -1, 0); } catch (e) {} }
  },
  getProxyPresetNames: () => [],
};
const TEVT = (() => {
  let et = {};
  try { const c = ctx(); et = (c && (c.eventTypes || c.event_types)) || {}; } catch (e) {}
  return {
    CHAT_CHANGED: et.CHAT_CHANGED || 'chat_id_changed',
    MESSAGE_RECEIVED: et.MESSAGE_RECEIVED || 'message_received',
    MESSAGE_SWIPED: et.MESSAGE_SWIPED || 'message_swiped',
    GENERATION_AFTER_COMMANDS: et.GENERATION_AFTER_COMMANDS || 'GENERATION_AFTER_COMMANDS',
  };
})();
const toast = (msg, type) => {
  try { if (window.toastr && window.toastr[type || 'info']) { window.toastr[type || 'info'](msg, '记忆助手'); return; } } catch (e) {}
  uiToast(msg, type);
};

/* ==================== 1. 工具函数 ==================== */
const clone = (o) => JSON.parse(JSON.stringify(o));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms) => { let t = null; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const nowStr = () => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getMonth() + 1}-${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const norm = (s) => String(s == null ? '' : s).replace(/[\s，。；;、,.!！？?]/g, '');
/** 列表去重追加：完全相同、被包含、或包含旧项的视为重复 */
function addUnique(arr, items, cap) {
  if (!Array.isArray(items)) return;
  for (let raw of items) {
    const it = String(raw == null ? '' : raw).trim();
    if (!it) continue;
    const n = norm(it);
    if (!n) continue;
    const dup = arr.some(old => { const no = norm(old); return no === n || no.includes(n) || n.includes(no); });
    if (!dup) arr.push(it);
  }
  const limit = cap || 40;
  while (arr.length > limit) arr.shift();
}

/* ==================== 2. 常量与默认配置 ==================== */
const VAR_DATA = '记忆助手_数据';
const VAR_SET = '记忆助手_设置';
const VAR_ERR = '记忆助手_报错';
const VAR_UI = '记忆助手_界面';
const INJ_PREFIX = '记忆助手_';
const ERR_CAP = 20;
const SNAP_CAP = 5;
const 内置类目 = ['人物', '物品', '环境', '社会结构'];

const DEFAULT_SYS_PROMPT = `你是“记忆整理助手”。阅读【新增剧情】，参照【现有记忆】，提取人物、物品、环境、社会结构的特征变化，只输出 JSON。

【输出格式】（所有字段可选，无变化就省略或留空）
{
 "人物":[{"名":"","外貌新增":[],"状态":{"情绪健康":"","外表":""},"天赋新增":[],"关系新增":[],"技能新增":[],"财产新增":[],"建议修改":[{"旧":"","新":"","理由":""}]}],
 "物品":[{"名":"","描述新增":[],"功能新增":[],"归属":"","完整度":""}],
 "环境":[{"名":"","概况新增":[],"布局新增":[]}],
 "社会结构":[{"名":"","类型":"","描述新增":[]}]
}

【规则】
1. 只输出 JSON，不要任何解释、不要使用代码块标记。
2. 名称使用剧情中的称呼并保持前后一致；【现有记忆】中已有的条目必须沿用原名。
3. “外貌新增”只记录长相与身体细节（不含衣着、首饰、伤疤），只写【现有记忆】中没有的新细节，不重复、不改写旧描述。
4. 若新剧情与已有外貌矛盾（如剪短发、留疤、毁容），不要直接修改，写入“建议修改”（旧=原描述，新=建议描述，理由=出处）。
5. “状态·情绪健康”填当前情绪与健康（如高兴、悲伤、生病、虚弱）；“状态·外表”填当前穿着、首饰等实时外观；只填最新情况，不确定留空。
6. “天赋新增”填性格与资质（如性格冷峻、冰系亲和）。
7. “关系新增”格式：对象(关系)，如 凯尔(敌对)。
8. “财产新增”填其拥有的物品与生物。
9. 物品“归属”填当前持有者；“完整度”填 完好/破损/残缺 等；仅在明确变化时填写，否则留空。
10. “概况新增”是地点整体情况；“布局新增”是新增、毁坏的建筑或家具等变化。
11. “社会结构”的“类型”填 势力/宗教/组织/单位/社交圈 等。
12. 每条内容为 20 字以内短语；只提取有信息量的事实，忽略寒暄与过程描写。`;

const DEFAULT_SETTINGS = () => ({
  启用自动提取: true,
  提取间隔楼数: 2,
  每次提取楼数: 4,
  关键词扫描楼数: 10,
  注入总开关: true,
  注入最大字符: 1800,
  默认注入深度: 2,
  默认注入角色: 'system',
  swipe自动重提取: true,
  全局库: false,
  回填每批楼数: 8,
  单条消息截断: 1500,
  记忆参考字符: 3500,
  面板高度: 62,
  副API: { 启用: false, 模式: 'openai', 地址: '', 密钥: '', 模型: '', 代理预设: '' },
  提取系统提示词: DEFAULT_SYS_PROMPT,
});
const DEFAULT_RULE = () => ({ 启用: true, 方式: '总是', 深度: 0, 角色: '', 关键词: [] });
const 新人物 = () => ({ 规则: null, 外貌: [], 状态: { 情绪健康: '', 外表: '' }, 天赋: [], 关系网: [], 技能: [], 财产: [], 建议修改: [] });
const 新物品 = () => ({ 规则: null, 描述: [], 功能特性: [], 归属: '', 完整度: '' });
const 新环境 = () => ({ 规则: null, 概况: [], 布局: [] });
const 新社会 = () => ({ 规则: null, 类型: '', 描述: [] });
const 新自定义条目 = () => ({ 规则: null, 内容: [] });
const 新条目工厂 = { '人物': 新人物, '物品': 新物品, '环境': 新环境, '社会结构': 新社会, '__自定义': 新自定义条目 };
const DEFAULT_DATA = () => ({
  版本: 1,
  已提取到: -1,
  提取记录: [],
  类目: {
    '人物': { 规则: DEFAULT_RULE(), 条目: {} },
    '物品': { 规则: DEFAULT_RULE(), 条目: {} },
    '环境': { 规则: DEFAULT_RULE(), 条目: {} },
    '社会结构': { 规则: DEFAULT_RULE(), 条目: {} },
  },
  自定义: {},
  统计: { 上次提取时间: '', 上次提取范围: '', 上次耗时: 0, 累计提取次数: 0 },
});

/* ==================== 3. 存储层 ==================== */
let SET = DEFAULT_SETTINGS();
let DATA = DEFAULT_DATA();
let ERRS = [];
let UIST = { 球位置: null, 打开标签: '人物' };

function 读变量表(type) {
  try { const v = api.getVariables ? api.getVariables({ type }) : {}; return (v && typeof v === 'object') ? v : {}; }
  catch (e) { pushError('存储失败', '读取变量失败(' + type + ')', String(e)); return {}; }
}
function 写变量(type, obj) {
  try { if (api.insertOrAssignVariables) api.insertOrAssignVariables(obj, { type }); else if (api.replaceVariables) { const v = { ...读变量表(type), ...obj }; api.replaceVariables(v, { type }); } }
  catch (e) { pushError('存储失败', '写入变量失败(' + type + ')', String(e)); }
}
function 数据作用域() { return SET.全局库 ? 'global' : 'chat'; }

function loadSettings() {
  const raw = 读变量表('script')[VAR_SET];
  SET = { ...DEFAULT_SETTINGS(), ...(raw && typeof raw === 'object' ? raw : {}) };
  SET.副API = { ...DEFAULT_SETTINGS().副API, ...(SET.副API || {}) };
  if (typeof SET.提取系统提示词 !== 'string' || !SET.提取系统提示词.trim()) SET.提取系统提示词 = DEFAULT_SYS_PROMPT;
}
function saveSettings() { 写变量('script', { [VAR_SET]: SET }); }

function 规整条目(类目名, e) {
  const base = 新条目工厂[类目名] ? 新条目工厂[类目名]() : 新自定义条目();
  const out = { ...base, ...(e && typeof e === 'object' ? e : {}) };
  if (类目名 === '人物') out.状态 = { 情绪健康: '', 外表: '', ...(out.状态 || {}) };
  for (const k of Object.keys(out)) if (Array.isArray(base[k])) out[k] = Array.isArray(out[k]) ? out[k] : [];
  return out;
}
function 规整数据(d) {
  const def = DEFAULT_DATA();
  if (!d || typeof d !== 'object') return def;
  d.版本 = 1;
  if (typeof d.已提取到 !== 'number') d.已提取到 = -1;
  if (!Array.isArray(d.提取记录)) d.提取记录 = [];
  if (!d.类目 || typeof d.类目 !== 'object') d.类目 = def.类目;
  for (const c of 内置类目) {
    if (!d.类目[c] || typeof d.类目[c] !== 'object') d.类目[c] = { 规则: DEFAULT_RULE(), 条目: {} };
    d.类目[c].规则 = { ...DEFAULT_RULE(), ...(d.类目[c].规则 || {}) };
    if (!d.类目[c].条目 || typeof d.类目[c].条目 !== 'object') d.类目[c].条目 = {};
    for (const k of Object.keys(d.类目[c].条目)) d.类目[c].条目[k] = 规整条目(c, d.类目[c].条目[k]);
    const ks = Object.keys(d.类目[c].条目);
    if (ks.length > 200) { const keep = {}; ks.slice(0, 200).forEach(k => { keep[k] = d.类目[c].条目[k]; }); d.类目[c].条目 = keep; }
  }
  if (!d.自定义 || typeof d.自定义 !== 'object') d.自定义 = {};
  for (const c of Object.keys(d.自定义)) {
    const cat = d.自定义[c];
    if (!cat || typeof cat !== 'object' || !cat.条目) { delete d.自定义[c]; continue; }
    cat.规则 = { ...DEFAULT_RULE(), ...(cat.规则 || {}) };
    for (const k of Object.keys(cat.条目)) cat.条目[k] = 规整条目('__自定义', cat.条目[k]);
    const ks2 = Object.keys(cat.条目);
    if (ks2.length > 200) { const keep2 = {}; ks2.slice(0, 200).forEach(k => { keep2[k] = cat.条目[k]; }); cat.条目 = keep2; }
  }
  d.统计 = { ...def.统计, ...(d.统计 || {}) };
  return d;
}
function loadData() {
  DATA = 规整数据(读变量表(数据作用域())[VAR_DATA]);
  injDirty = true;
}
function saveData() {
  写变量(数据作用域(), { [VAR_DATA]: DATA });
  injDirty = true;
  try { 刷新注入防抖(); } catch (e) {}   /* 数据一变就刷新注入，不等下次生成 */
}

/* ==================== 4. 报错栏 ==================== */
let __errLock = false;
function pushError(type, message, detail) {
  if (__errLock) { try { console.warn(TAG, type, message); } catch (e) {} return; }
  __errLock = true;
  try {
    ERRS.unshift({ 时间: nowStr(), 类型: type, 信息: String(message || ''), 详情: String(detail || '').slice(0, 1500) });
    while (ERRS.length > ERR_CAP) ERRS.pop();
    写变量('script', { [VAR_ERR]: ERRS });
    console.warn(TAG, type, message, detail || '');
    refreshErrBadge();
    if (state.activeTab === '报错' && state.open) { try { renderTab(); } catch (e) {} }
  } catch (e) { try { console.error(TAG, e); } catch (e2) {} }
  finally { __errLock = false; }
}
function loadErrs() { const raw = 读变量表('script')[VAR_ERR]; ERRS = Array.isArray(raw) ? raw.slice(0, ERR_CAP) : []; }


/* ==================== 5. AI 提取 ==================== */
const state = {
  open: false, activeTab: '人物', 提取中: false, 待提取: false,
  回填中: false, 回填中止: false, 待重提取: false, 上次负载: null,
};
let injDirty = true;

function 最后楼层() { try { return api.getLastMessageId ? api.getLastMessageId() : -1; } catch (e) { return -1; } }
function 取消息文本(from, to) {
  if (!api.getChatMessages || to < from) return [];
  try {
    const list = api.getChatMessages(`${from}-${to}`) || [];
    return list.filter(m => m && !m.is_hidden && typeof m.message === 'string' && m.message.trim())
      .map(m => ({ id: m.message_id, 名: m.name || (m.role === 'user' ? '用户' : '角色'), 角色: m.role, 文: m.message.slice(0, SET.单条消息截断) }));
  } catch (e) { pushError('提取失败', '读取聊天消息失败', String(e)); return []; }
}
function 记忆快照(去规则) {
  const out = {};
  for (const c of 内置类目) {
    out[c] = {};
    for (const [k, e] of Object.entries(DATA.类目[c].条目)) {
      const { 规则, ...rest } = e; out[c][k] = rest;
    }
  }
  return out;
}
function 记忆参考文本() {
  let s = '';
  try { s = JSON.stringify(记忆快照(true)); } catch (e) { s = ''; }
  if (s.length > SET.记忆参考字符) s = s.slice(0, SET.记忆参考字符) + '……(过长已截断)';
  return s;
}
function 构造负载(from, to) {
  const msgs = 取消息文本(from, to);
  if (!msgs.length) return null;
  const 剧情 = msgs.map(m => `[#${m.id} ${m.名}] ${m.文}`).join('\n');
  const user = `【现有记忆】\n${记忆参考文本() || '(空)'}\n\n【新增剧情】(楼层 ${from}~${to})\n${剧情}\n\n请输出 JSON。`;
  return { user, from, to };
}
async function 调用AI(userPrompt) {
  const cfg = {
    user_input: userPrompt,
    ordered_prompts: [{ role: 'system', content: SET.提取系统提示词 }],
  };
  const sub = SET.副API || {};
  if (sub.启用) {
    if (!sub.地址) throw new Error('副API已启用但未填写地址（或关闭副API，改用主API静默生成）');
    cfg.custom_api = { apiurl: sub.地址, key: sub.密钥 || '', model: sub.模型 || '' };
  }
  return await api.generateRaw(cfg);
}
function 解析JSON(text) {
  let s = String(text || '').trim();
  s = s.replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('返回内容中未找到 JSON');
  s = s.slice(a, b + 1);
  try { return JSON.parse(s); }
  catch (e) {
    try { return JSON.parse(s.replace(/,\s*([}\]])/g, '$1')); }
    catch (e2) { throw new Error('JSON 解析失败: ' + e2.message); }
  }
}

/* ---------- 合并规则：累积制 + 状态覆盖制 + 建议修改 ---------- */
const 已提示上限 = new Set();
function 上限提示一次(类目名) {
  if (已提示上限.has(类目名)) return;
  已提示上限.add(类目名);
  pushError('其他', '「' + 类目名 + '」条目已达 200 条上限，新条目被跳过', '可在面板中搜索并清理无用条目');
}
function 合并提取(j, rangeStr) {
  let 变更 = 0;
  const 确保条目 = (类目名, 名) => {
    const cat = DATA.类目[类目名]; if (!cat) return null;
    if (!cat.条目[名]) {
      if (Object.keys(cat.条目).length >= 200) { 上限提示一次(类目名); return null; }
      cat.条目[名] = 新条目工厂[类目名]();
    } else cat.条目[名] = 规整条目(类目名, cat.条目[名]);
    return cat.条目[名];
  };
  const 取名 = o => String(o && (o.名 || o.名称) || '').trim();

  for (const p of (Array.isArray(j.人物) ? j.人物 : [])) {
    const 名 = 取名(p); if (!名) continue;
    const e = 确保条目('人物', 名); if (!e) continue; const before = JSON.stringify(e);
    addUnique(e.外貌, p.外貌新增);
    if (p.状态 && typeof p.状态 === 'object') {
      if (typeof p.状态.情绪健康 === 'string' && p.状态.情绪健康.trim()) e.状态.情绪健康 = p.状态.情绪健康.trim();
      if (typeof p.状态.外表 === 'string' && p.状态.外表.trim()) e.状态.外表 = p.状态.外表.trim();
    }
    addUnique(e.天赋, p.天赋新增); addUnique(e.关系网, p.关系新增);
    addUnique(e.技能, p.技能新增); addUnique(e.财产, p.财产新增);
    for (const s of (Array.isArray(p.建议修改) ? p.建议修改 : [])) {
      if (!s || !s.新) continue;
      const 提案 = { 旧: String(s.旧 || ''), 新: String(s.新 || ''), 理由: String(s.理由 || ''), 时间: nowStr() };
      if (!e.建议修改.some(x => x.旧 === 提案.旧 && x.新 === 提案.新)) { e.建议修改.push(提案); }
    }
    while (e.建议修改.length > 10) e.建议修改.shift();
    if (JSON.stringify(e) !== before) 变更++;
  }
  for (const it of (Array.isArray(j.物品) ? j.物品 : [])) {
    const 名 = 取名(it); if (!名) continue;
    const e = 确保条目('物品', 名); if (!e) continue; const before = JSON.stringify(e);
    addUnique(e.描述, it.描述新增); addUnique(e.功能特性, it.功能新增);
    if (typeof it.归属 === 'string' && it.归属.trim()) e.归属 = it.归属.trim();
    if (typeof it.完整度 === 'string' && it.完整度.trim()) e.完整度 = it.完整度.trim();
    if (JSON.stringify(e) !== before) 变更++;
  }
  for (const it of (Array.isArray(j.环境) ? j.环境 : [])) {
    const 名 = 取名(it); if (!名) continue;
    const e = 确保条目('环境', 名); if (!e) continue; const before = JSON.stringify(e);
    addUnique(e.概况, it.概况新增); addUnique(e.布局, it.布局新增);
    if (JSON.stringify(e) !== before) 变更++;
  }
  for (const it of (Array.isArray(j.社会结构) ? j.社会结构 : [])) {
    const 名 = 取名(it); if (!名) continue;
    const e = 确保条目('社会结构', 名); if (!e) continue; const before = JSON.stringify(e);
    if (typeof it.类型 === 'string' && it.类型.trim()) e.类型 = it.类型.trim();
    addUnique(e.描述, it.描述新增);
    if (JSON.stringify(e) !== before) 变更++;
  }
  return 变更;
}

/* ---------- 快照（供 swipe 撤回旧提取） ---------- */
function 拍快照(从, 到) {
  DATA.提取记录.push({ 从, 到, 时间: nowStr(), 快照: clone({ 类目: DATA.类目, 自定义: DATA.自定义 }) });
  while (DATA.提取记录.length > SNAP_CAP) DATA.提取记录.shift();
}
function 回滚到(消息id) {
  const idx = DATA.提取记录.findIndex(r => r.到 >= 消息id);
  if (idx < 0) {
    if (消息id <= DATA.已提取到) { DATA.已提取到 = 消息id - 1; DATA.提取记录 = []; return 'partial'; }
    return false;
  }
  const rec = DATA.提取记录[idx];
  const nd = 规整数据({ 类目: rec.快照.类目, 自定义: rec.快照.自定义 });
  DATA.类目 = nd.类目;
  DATA.自定义 = nd.自定义;
  DATA.已提取到 = rec.从 - 1;
  DATA.提取记录 = DATA.提取记录.slice(0, idx);
  return true;
}

/* ---------- 提取主流程 ---------- */
async function 执行提取(手动) {
  if (state.提取中) { state.待提取 = true; return; }
  const last = 最后楼层();
  if (last < 0) { if (手动) toast('当前没有聊天消息', 'warning'); return; }
  let from = DATA.已提取到 + 1;
  if (from > last) { if (手动) toast('没有新的楼层需要提取', 'info'); return; }
  let to = Math.min(last, from + Math.max(1, SET.每次提取楼数) - 1);
  const 负载 = 构造负载(from, to);
  if (!负载) { DATA.已提取到 = to; saveData(); return; }
  state.提取中 = true; state.上次负载 = 负载;
  refreshBall();
  const t0 = Date.now();
  try {
    const raw = await 调用AI(负载.user);
    let j;
    try { j = 解析JSON(raw); }
    catch (pe) {
      pushError('解析失败', pe.message, String(raw).slice(0, 800));
      if (手动) toast('提取结果解析失败，可在报错栏重试', 'error');
      return;
    }
    拍快照(from, to);
    const 变更 = 合并提取(j, `${from}~${to}`);
    DATA.已提取到 = to;
    DATA.统计.上次提取时间 = nowStr();
    DATA.统计.上次提取范围 = `${from}~${to}`;
    DATA.统计.上次耗时 = Math.round((Date.now() - t0) / 100) / 10;
    DATA.统计.累计提取次数++;
    saveData();
    if (手动) toast(`提取完成：楼层 ${from}~${to}，${变更} 个条目有更新`, 'success');
    if (state.open) renderTab();
  } catch (e) {
    pushError(SET.副API && SET.副API.启用 ? 'API报错(副)' : 'API报错', String(e && e.message || e), String(e && e.stack || '').slice(0, 600));
    if (手动) toast('提取失败：' + (e && e.message || e), 'error');
  } finally {
    state.提取中 = false;
    refreshBall();
    if (state.待提取) { state.待提取 = false; setTimeout(() => 执行提取(false), 300); }
  }
}

/** 自动触发：收到新楼层后按间隔提取（自动续批，最多连跑 5 批防失控） */
async function 自动提取检查() {
  if (!SET.启用自动提取 || state.提取中 || state.回填中) return;
  const last = 最后楼层();
  if (last < 0) return;
  const 间隔 = Math.max(1, SET.提取间隔楼数);
  if (last - DATA.已提取到 < 间隔) return;
  for (let i = 0; i < 5; i++) {
    await 执行提取(false);
    if (state.回填中 || 最后楼层() - DATA.已提取到 < 间隔) break;
  }
}

/* ---------- swipe：撤回旧提取，以最终采用的那条为准 ---------- */
const 处理swipe = debounce(async (消息id) => {
  try {
    if (typeof 消息id !== 'number' || 消息id < 0) 消息id = 最后楼层();
    if (消息id > DATA.已提取到) return;
    const r = 回滚到(消息id);
    if (r === false) return;
    saveData();
    if (state.open) renderTab();
    if (!SET.swipe自动重提取) { toast('已撤回被划掉的提取，可手动重新提取', 'info'); return; }
    toast(r === 'partial' ? '快照不足，已回退提取进度（内容可能重复，可手动清理）' : '已撤回旧提取，按新回复重新提取', 'info');
    await new Promise(res => setTimeout(res, 900));
    执行提取(false);
  } catch (e) { pushError('提取失败', 'swipe 回滚失败', String(e)); }
}, 400);

/* ==================== 6. 历史回填 ==================== */
async function 历史回填(清空) {
  if (state.回填中) return;
  const last = 最后楼层();
  if (last < 0) { toast('当前没有聊天消息', 'warning'); return; }
  if (清空) {
    DATA = DEFAULT_DATA(); saveData();
  }
  state.回填中 = true; state.回填中止 = false;
  refreshBall(); renderTab();
  let 批 = 0, 失败 = 0;
  try {
    while (DATA.已提取到 < last) {
      if (state.回填中止) break;
      const from = DATA.已提取到 + 1;
      const to = Math.min(last, from + Math.max(2, SET.回填每批楼数) - 1);
      const 负载 = 构造负载(from, to);
      if (!负载) { DATA.已提取到 = to; continue; }
      批++;
      uiProgress(`回填中… 已处理到第 ${to}/${last} 楼（第 ${批} 批）`);
      try {
        const raw = await 调用AI(负载.user);
        const j = 解析JSON(raw);
        拍快照(from, to);
        合并提取(j, `${from}~${to}`);
        DATA.已提取到 = to;
        DATA.统计.累计提取次数++;
        saveData();
      } catch (e) {
        失败++;
        pushError('解析失败', `回填第 ${from}~${to} 楼失败: ${e && e.message || e}`, '');
        DATA.已提取到 = to; saveData();
        if (失败 >= 3) { pushError('提取失败', '回填连续失败 3 次，已中止', ''); break; }
      }
      await new Promise(r => setTimeout(r, 400));
    }
  } finally {
    state.回填中 = false;
    uiProgress('');
    DATA.统计.上次提取时间 = nowStr();
    DATA.统计.上次提取范围 = '回填';
    saveData();
    refreshBall(); if (state.open) renderTab();
    toast(state.回填中止 ? '回填已中止' : `回填完成：共 ${批} 批${失败 ? '，失败 ' + 失败 + ' 批' : ''}`, 失败 ? 'warning' : 'success');
  }
}


/* ==================== 7. 提示词注入 ==================== */
let 当前注入ids = [];
let 上次注入文本 = '';
let 注入截断提示 = '';

function 有效规则(类目规则, 条目) {
  const r = { ...DEFAULT_RULE(), ...(类目规则 || {}) };
  const er = (条目 && 条目.规则) || null;
  if (er) {
    if (er.方式 && er.方式 !== '跟随类目') r.方式 = er.方式;
    if (typeof er.启用 === 'boolean') r.启用 = er.启用;
    if (typeof er.深度 === 'number' && er.深度 > 0) r.深度 = er.深度;
    if (er.角色) r.角色 = er.角色;
    if (Array.isArray(er.关键词) && er.关键词.length) r.关键词 = er.关键词;
  }
  return r;
}
function 近期文本() {
  try {
    const n = Math.max(1, SET.关键词扫描楼数);
    const list = api.getChatMessages ? (api.getChatMessages(`-${n}`) || []) : [];
    return list.map(m => (m && m.message) || '').join('\n');
  } catch (e) { return ''; }
}
function 匹配关键词(名, 规则, 文本) {
  const keys = [名, ...((规则 && 规则.关键词) || [])].map(s => String(s || '').trim()).filter(Boolean);
  return keys.some(k => 文本.includes(k));
}

const 列表行 = (label, arr) => (arr && arr.length) ? `${label}:${arr.join(';')}` : '';
function 格式化人物(名, e) {
  const parts = [
    列表行('外貌', e.外貌),
    e.状态 && e.状态.情绪健康 ? `状态:${e.状态.情绪健康}` : '',
    e.状态 && e.状态.外表 ? `外表:${e.状态.外表}` : '',
    列表行('天赋', e.天赋), 列表行('关系', e.关系网), 列表行('技能', e.技能), 列表行('财产', e.财产),
  ].filter(Boolean);
  return `【人物·${名}】${parts.join('｜')}`;
}
function 格式化物品(名, e) {
  const parts = [列表行('描述', e.描述), 列表行('功能', e.功能特性),
    e.归属 ? `归属:${e.归属}` : '', e.完整度 ? `完整度:${e.完整度}` : ''].filter(Boolean);
  return `【物品·${名}】${parts.join('｜')}`;
}
function 格式化环境(名, e) {
  const parts = [列表行('概况', e.概况), 列表行('布局', e.布局)].filter(Boolean);
  return `【环境·${名}】${parts.join('｜')}`;
}
function 格式化社会(名, e) {
  const parts = [e.类型 ? `类型:${e.类型}` : '', 列表行('描述', e.描述)].filter(Boolean);
  return `【势力·${名}】${parts.join('｜')}`;
}
function 格式化自定义(类目名, 名, e) {
  return `【${类目名}·${名}】${(e.内容 || []).join(';')}`;
}
const 格式化器 = { '人物': 格式化人物, '物品': 格式化物品, '环境': 格式化环境, '社会结构': 格式化社会 };

/** 生成注入块：[{id, depth, role, content, prio}] */
function 构造注入块() {
  const blocks = [];
  const 文本 = 近期文本();
  const 处理类目 = (类目名, cat, prio, 自定义类目) => {
    const 类目规则 = { ...DEFAULT_RULE(), ...(cat.规则 || {}) };
    if (!类目规则.启用 || 类目规则.方式 === '关闭') return;
    const lines = [];
    for (const [名, e] of Object.entries(cat.条目 || {})) {
      const r = 有效规则(类目规则, e);
      if (!r.启用 || r.方式 === '关闭') continue;
      if (r.方式 === '关键词' && !匹配关键词(名, r, 文本)) continue;
      const line = 自定义类目 ? 格式化自定义(类目名, 名, e) : 格式化器[类目名](名, e);
      if (line && !line.endsWith('】')) lines.push(line);
      else if (line && line.indexOf('】') === line.length - 1) continue;
      else if (line) lines.push(line);
    }
    if (!lines.length) return;
    blocks.push({
      id: INJ_PREFIX + (自定义类目 ? '自定义·' + 类目名 : 类目名),
      depth: 类目规则.深度 > 0 ? 类目规则.深度 : Math.max(0, SET.默认注入深度),
      role: 类目规则.角色 || SET.默认注入角色 || 'system',
      content: `[${类目名}]\n` + lines.join('\n'),
      prio,
    });
  };
  处理类目('人物', DATA.类目['人物'], 50);
  处理类目('物品', DATA.类目['物品'], 40);
  处理类目('环境', DATA.类目['环境'], 30);
  处理类目('社会结构', DATA.类目['社会结构'], 20);
  for (const [名, cat] of Object.entries(DATA.自定义 || {})) 处理类目(名, cat, 10, true);
  return blocks;
}

function 刷新注入() {
  if (!injDirty) return;
  injDirty = false;
  try { if (当前注入ids.length && api.uninjectPrompts) api.uninjectPrompts(当前注入ids.slice()); } catch (e) {}
  当前注入ids = []; 上次注入文本 = ''; 注入截断提示 = '';
  if (!SET.注入总开关 || !api.injectPrompts) { refreshStatsOnly(); return; }
  try {
    let blocks = 构造注入块();
    const 预算 = Math.max(200, SET.注入最大字符);
    let total = 0; const kept = [];
    for (const b of blocks.sort((a, b2) => b2.prio - a.prio)) {
      if (total + b.content.length <= 预算) { kept.push(b); total += b.content.length; }
      else 注入截断提示 += (注入截断提示 ? '、' : '') + b.id.replace(INJ_PREFIX, '');
    }
    kept.sort((a, b) => b.prio - a.prio);
    const prompts = kept.map(b => ({ id: b.id, position: 'in_chat', depth: b.depth, role: b.role, content: b.content }));
    if (prompts.length) {
      api.injectPrompts(prompts);
      当前注入ids = prompts.map(p => p.id);
      上次注入文本 = prompts.map(p => p.content).join('\n\n');
    }
    if (注入截断提示) 注入截断提示 = '超出注入字符预算，已省略：' + 注入截断提示;
  } catch (e) { pushError('注入失败', String(e && e.message || e), ''); }
  refreshStatsOnly();
}
const 刷新注入防抖 = debounce(刷新注入, 500);

/* ==================== 8. 事件接线 ==================== */
function 解绑全部注入() {
  try { if (当前注入ids.length && api.uninjectPrompts) api.uninjectPrompts(当前注入ids.slice()); } catch (e) {}
  当前注入ids = []; 上次注入文本 = '';
}
function 绑定事件() {
  if (!api.eventOn) { pushError('其他', '未找到 eventOn，自动功能不可用', ''); return; }
  try {
    api.eventOn(TEVT.MESSAGE_RECEIVED, () => { setTimeout(自动提取检查, 600); });
    api.eventOn(TEVT.MESSAGE_SWIPED, (mid) => 处理swipe(typeof mid === 'number' ? mid : 最后楼层()));
    api.eventOn(TEVT.GENERATION_AFTER_COMMANDS, () => { if (injDirty) 刷新注入(); });
    api.eventOn(TEVT.CHAT_CHANGED, () => {
      解绑全部注入();
      state.待提取 = false; state.待重提取 = false;
      loadData();
      injDirty = true; 刷新注入防抖();
      if (state.open) renderTab();
      refreshBall();
    });
  } catch (e) { pushError('其他', '事件绑定失败', String(e)); }
}


/* ==================== 9. 界面：样式 ==================== */
const CSS = `
.zjh-root, .zjh-root * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
.zjh-root { font-size: 14px; color: #e8e6f0; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
#zjh-ball { position: fixed; right: 14px; bottom: 118px; width: 46px; height: 46px; border-radius: 50%;
  background: #6d5bd0; background: linear-gradient(135deg, #6d5bd0, #4a3f9e); color: #fff; display: flex; align-items: center; justify-content: center;
  font-size: 17px; font-weight: 700; box-shadow: 0 4px 14px rgba(0,0,0,.45); z-index: 340; cursor: pointer;
  user-select: none; touch-action: none; border: 2px solid rgba(255,255,255,.25); }
#zjh-ball .zjh-dot { position: absolute; top: -2px; right: -2px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
  background: #e5484d; color: #fff; font-size: 10px; line-height: 16px; text-align: center; display: none; }
#zjh-ball.zjh-busy::after { content: ""; position: absolute; inset: -5px; border-radius: 50%; border: 2px solid #8f7bf0;
  border-top-color: transparent; animation: zjh-spin 1s linear infinite; }
@keyframes zjh-spin { to { transform: rotate(360deg); } }
#zjh-mask { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 310; opacity: 0; pointer-events: none; transition: opacity .2s; }
#zjh-mask.zjh-show { opacity: 1; pointer-events: auto; }
#zjh-panel { position: fixed; left: 0; right: 0; bottom: 0; height: 62vh; z-index: 330; display: flex; flex-direction: column;
  background: rgba(24,22,34,.97); border-radius: 16px 16px 0 0; border-top: 1px solid rgba(255,255,255,.12);
  box-shadow: 0 -6px 30px rgba(0,0,0,.5); transform: translateY(105%); transition: transform .22s ease; overflow: hidden; }
#zjh-panel.zjh-show { transform: translateY(0); }
#zjh-panel.zjh-float { left: 4vw; right: auto; bottom: auto; width: 92vw; max-width: 460px; height: 62vh;
  border-radius: 14px; border: 1px solid rgba(255,255,255,.14); transition: none; }
#zjh-panel.zjh-float:not(.zjh-show) { display: none; }
#zjh-panel.zjh-gone { display: none !important; }
.zjh-header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: rgba(255,255,255,.04);
  border-bottom: 1px solid rgba(255,255,255,.08); cursor: grab; touch-action: none; user-select: none; flex: 0 0 auto; }
.zjh-header .zjh-grip { width: 34px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.3); margin-right: 2px; flex: 0 0 auto; }
.zjh-header .zjh-title { font-weight: 700; font-size: 15px; flex: 1 1 auto; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.zjh-header .zjh-scope { font-size: 11px; color: #a99ee0; background: rgba(109,91,208,.25); padding: 2px 8px; border-radius: 8px; flex: 0 0 auto; }
.zjh-header .zjh-btn { padding: 9px 16px; font-size: 13px; }
.zjh-tabs { display: flex; gap: 2px; overflow-x: auto; padding: 6px 8px 0; flex: 0 0 auto; scrollbar-width: none; }
.zjh-tabs::-webkit-scrollbar { display: none; }
.zjh-tab { flex: 0 0 auto; padding: 7px 12px; border-radius: 10px 10px 0 0; font-size: 13px; color: #b9b4cc;
  background: transparent; border: none; cursor: pointer; position: relative; white-space: nowrap; }
.zjh-tab.zjh-on { background: rgba(109,91,208,.28); color: #fff; font-weight: 600; }
.zjh-tab .zjh-badge { position: absolute; top: 1px; right: 2px; min-width: 14px; height: 14px; padding: 0 3px; border-radius: 7px;
  background: #e5484d; color: #fff; font-size: 9px; line-height: 14px; text-align: center; }
.zjh-body { flex: 1 1 auto; overflow-y: auto; padding: 10px 12px calc(14px + env(safe-area-inset-bottom)); -webkit-overflow-scrolling: touch; }
.zjh-toolbar { display: flex; gap: 8px; margin-bottom: 10px; align-items: center; flex-wrap: wrap; }
.zjh-toolbar input[type=text], .zjh-toolbar input[type=search] { flex: 1 1 120px; min-width: 0; }
.zjh-card { background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.09); border-radius: 12px;
  padding: 10px 12px; margin-bottom: 8px; }
.zjh-card .zjh-card-head { display: flex; align-items: center; gap: 8px; }
.zjh-card .zjh-name { font-weight: 600; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zjh-card .zjh-sub { font-size: 12px; color: #a8a3bd; margin-top: 4px; line-height: 1.6; word-break: break-all; }
.zjh-card .zjh-sub b { color: #cfc9e8; font-weight: 600; }
.zjh-mini { font-size: 11px; padding: 2px 8px; border-radius: 8px; background: rgba(109,91,208,.3); color: #d9d3f5; flex: 0 0 auto; }
.zjh-mini.zjh-warn { background: rgba(229,72,77,.3); color: #ffb3b6; }
button.zjh-btn { background: rgba(109,91,208,.85); color: #fff; border: none; border-radius: 10px; padding: 8px 14px;
  font-size: 13px; cursor: pointer; }
button.zjh-btn:active { filter: brightness(1.15); }
button.zjh-btn.zjh-ghost { background: rgba(255,255,255,.09); color: #d5d1e6; }
button.zjh-btn.zjh-danger { background: rgba(229,72,77,.75); }
button.zjh-btn.zjh-sm { padding: 5px 10px; font-size: 12px; border-radius: 8px; }
.zjh-root input[type=text], .zjh-root input[type=search], .zjh-root input[type=number], .zjh-root input[type=password], .zjh-root select, .zjh-root textarea {
  background: rgba(0,0,0,.3); border: 1px solid rgba(255,255,255,.14); border-radius: 9px; color: #eae8f5;
  padding: 8px 10px; font-size: 13px; outline: none; width: auto; }
.zjh-root textarea { width: 100%; min-height: 74px; resize: vertical; line-height: 1.5; }
.zjh-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.zjh-row > label { flex: 1 1 auto; font-size: 13px; color: #cfcbdd; }
.zjh-row .zjh-hint { flex-basis: 100%; font-size: 11px; color: #8f8aa8; margin-top: -6px; }
.zjh-row input[type=number] { width: 76px; }
.zjh-switch { position: relative; width: 42px; height: 24px; flex: 0 0 auto; }
.zjh-switch input { display: none; }
.zjh-switch i { position: absolute; inset: 0; border-radius: 12px; background: rgba(255,255,255,.16); transition: background .15s; }
.zjh-switch i::after { content: ""; position: absolute; left: 3px; top: 3px; width: 18px; height: 18px; border-radius: 50%;
  background: #fff; transition: left .15s; }
.zjh-switch input:checked + i { background: #6d5bd0; }
.zjh-switch input:checked + i::after { left: 21px; }
.zjh-sec { font-size: 12px; color: #9d97b8; margin: 14px 0 6px; letter-spacing: 1px; }
.zjh-err-item { border-left: 3px solid #e5484d; }
.zjh-err-item .zjh-err-type { color: #ff9d9f; font-weight: 600; font-size: 12px; }
.zjh-err-item pre { white-space: pre-wrap; word-break: break-all; font-size: 11px; color: #9c96b5; margin: 6px 0 0;
  max-height: 120px; overflow-y: auto; background: rgba(0,0,0,.25); padding: 6px; border-radius: 6px; }
.zjh-kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 13px; }
.zjh-kv > div:nth-child(odd) { color: #9d97b8; }
.zjh-proposal { background: rgba(229,181,72,.12); border: 1px solid rgba(229,181,72,.35); border-radius: 10px;
  padding: 8px 10px; margin-top: 8px; font-size: 12px; }
.zjh-proposal .zjh-p-new { color: #ffd98a; }
.zjh-empty { text-align: center; color: #7e7996; padding: 30px 0 40px; font-size: 13px; }
#zjh-modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 345; display: none; align-items: flex-end; }
#zjh-modal-mask.zjh-show { display: flex; }
#zjh-modal { width: 100%; max-height: 82vh; background: #211e30; border-radius: 16px 16px 0 0; display: flex; flex-direction: column;
  border-top: 1px solid rgba(255,255,255,.12); }
#zjh-modal .zjh-m-head { padding: 12px 14px; font-weight: 700; border-bottom: 1px solid rgba(255,255,255,.09);
  display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
#zjh-modal .zjh-m-head span { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#zjh-modal .zjh-m-body { padding: 12px 14px; overflow-y: auto; flex: 1 1 auto; }
#zjh-modal .zjh-m-foot { padding: 10px 14px calc(12px + env(safe-area-inset-bottom)); display: flex; gap: 8px; justify-content: flex-end;
  border-top: 1px solid rgba(255,255,255,.09); flex: 0 0 auto; }
#zjh-toast { position: fixed; left: 50%; bottom: 18vh; transform: translateX(-50%); z-index: 360; background: rgba(20,18,30,.95);
  border: 1px solid rgba(255,255,255,.15); color: #eee; padding: 9px 16px; border-radius: 20px; font-size: 13px;
  max-width: 86vw; text-align: center; opacity: 0; pointer-events: none; transition: opacity .2s; }
#zjh-progress { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(64vh); z-index: 350;
  background: rgba(109,91,208,.92); color: #fff; font-size: 12px; padding: 6px 14px; border-radius: 14px; display: none; max-width: 90vw; }
.zjh-tag { display: inline-block; background: rgba(255,255,255,.08); border-radius: 6px; padding: 1px 7px; margin: 2px 3px 2px 0; font-size: 12px; }
@media (min-width: 700px) { #zjh-panel:not(.zjh-float) { left: 50%; right: auto; transform: translate(-50%, 105%); width: 620px; }
  #zjh-panel.zjh-show:not(.zjh-float) { transform: translate(-50%, 0); } }
`;

/* ==================== 10. 界面：骨架 ==================== */
let $ball = null, $panel = null, $mask = null, $body = null, $tabsEl = null, $modalMask = null;
const TABS = ['人物', '物品', '环境', '社会结构', '自定义', '设置', '报错', '统计'];

function 建界面() {
  try {
    const old = PD.querySelectorAll('.zjh-root, #zjh-style, #zjh-st-entry'); old.forEach(e => e.remove());
    const style = PD.createElement('style'); style.id = 'zjh-style'; style.textContent = CSS; PD.head.appendChild(style);

    $ball = PD.createElement('div'); $ball.id = 'zjh-ball'; $ball.className = 'zjh-root';
    $ball.innerHTML = `记<span class="zjh-dot"></span>`;
    PD.body.appendChild($ball);
    挂酒馆入口();
    盯梢入口();

    $mask = PD.createElement('div'); $mask.id = 'zjh-mask'; $mask.className = 'zjh-root'; PD.body.appendChild($mask);

    $panel = PD.createElement('div'); $panel.id = 'zjh-panel'; $panel.className = 'zjh-root zjh-gone';
    $panel.innerHTML = `
      <div class="zjh-header" id="zjh-header">
        <div class="zjh-grip"></div><div class="zjh-title">记忆助手</div>
        <div class="zjh-scope" id="zjh-scope"></div>
        <button class="zjh-btn zjh-ghost zjh-sm" data-act="shrink">缩小</button>
        <button class="zjh-btn zjh-ghost zjh-sm" data-act="close">关闭</button>
      </div>
      <div class="zjh-tabs" id="zjh-tabs"></div>
      <div class="zjh-body" id="zjh-body"></div>`;
    PD.body.appendChild($panel);
    $body = $panel.querySelector('#zjh-body');
    $tabsEl = $panel.querySelector('#zjh-tabs');

    $modalMask = PD.createElement('div'); $modalMask.id = 'zjh-modal-mask'; $modalMask.className = 'zjh-root';
    $modalMask.innerHTML = `<div id="zjh-modal"><div class="zjh-m-head"><span id="zjh-m-title"></span>
      <button class="zjh-btn zjh-ghost zjh-sm" data-act="modal-close">✕</button></div>
      <div class="zjh-m-body" id="zjh-m-body"></div>
      <div class="zjh-m-foot" id="zjh-m-foot"></div></div>`;
    PD.body.appendChild($modalMask);

    const t = PD.createElement('div'); t.id = 'zjh-toast'; t.className = 'zjh-root'; PD.body.appendChild(t);
    const pr = PD.createElement('div'); pr.id = 'zjh-progress'; pr.className = 'zjh-root'; PD.body.appendChild(pr);

    绑定球拖拽();
    绑定面板拖拽();
    const closeBtn = $panel.querySelector('[data-act="close"]');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => 关面板());
      closeBtn.addEventListener('pointerup', () => 关面板());
    }
    应用面板高度();
    $mask.addEventListener('click', () => 关面板());
    $mask.addEventListener('pointerup', () => { if (Date.now() - __dragEndT > 350) 关面板(); });
    const 切换标签 = (ev) => {
      const b = ev.target && ev.target.closest ? ev.target.closest('[data-tab]') : null; if (!b) return;
      if (state.activeTab === b.dataset.tab) return;
      state.activeTab = b.dataset.tab; UIST.打开标签 = state.activeTab; saveUI(); renderTab();
    };
    $tabsEl.addEventListener('click', 切换标签);
    $tabsEl.addEventListener('pointerup', 切换标签);
    const 记下按下 = (ev) => { __downEl = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null; };
    $panel.addEventListener('pointerdown', 记下按下, true);
    $modalMask.addEventListener('pointerdown', 记下按下, true);
    $panel.addEventListener('click', 委托点击入口);
    $panel.addEventListener('pointerup', 委托点击入口);
    $panel.addEventListener('change', 委托变更);
    $modalMask.addEventListener('click', (ev) => { if (ev.target === $modalMask) 关弹窗(); });
    $modalMask.addEventListener('click', 委托点击入口);
    $modalMask.addEventListener('pointerup', 委托点击入口);
    $modalMask.addEventListener('change', 委托变更);
    renderTabs(); refreshBall();
    悬浮球自检();
  } catch (e) { pushError('其他', '界面初始化失败', String(e)); }
}

let toastTimer = null;
function uiToast(msg, type) {
  const t = PD.getElementById('zjh-toast'); if (!t) return;
  t.textContent = String(msg); t.style.opacity = '1';
  t.style.borderColor = type === 'error' ? 'rgba(229,72,77,.6)' : type === 'success' ? 'rgba(76,175,80,.55)' : 'rgba(255,255,255,.15)';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 2400);
}
function uiProgress(msg) {
  const pr = PD.getElementById('zjh-progress'); if (!pr) return;
  pr.style.display = msg ? 'block' : 'none'; pr.textContent = msg || '';
}
function saveUI() { 写变量('script', { [VAR_UI]: UIST }); }
function loadUI() { const raw = 读变量表('script')[VAR_UI]; if (raw && typeof raw === 'object') UIST = { ...UIST, ...raw }; }

let __entryT = 0, __entryObserver = null;
function 挂酒馆入口() {
  try {
    if (PD.getElementById('zjh-st-entry')) return;
    const host = PD.getElementById('rightSendForm') || PD.getElementById('send_form') || PD.getElementById('top-bar');
    if (!host) return;
    const b = PD.createElement('div');
    b.id = 'zjh-st-entry';
    b.textContent = '🧔‍♂️';
    b.title = '记忆助手';
    b.style.cssText = 'cursor:pointer;font-size:18px;padding:8px 9px;align-self:center;user-select:none;position:relative;z-index:5;-webkit-tap-highlight-color:transparent;';
    /* 通道锁定：第一个到达的事件类型成为唯一触发通道，其余类型永久忽略。
       根治「老旧 WebView 延迟合成 click → 同一手势被当成两次点按 → 面板开了又秒关」 */
    let __entryChan = '';
    const toggle = (ev) => {
      /* 紫闪 = 事件到达了图标（去重前）；绿闪 = 真正执行了开关 */
      b.style.background = 'rgba(109,91,208,.55)'; b.style.borderRadius = '8px';
      setTimeout(() => { try { b.style.background = ''; } catch (e) {} }, 120);
      const tp = ev && ev.type ? ev.type : '';
      if (!__entryChan) __entryChan = tp;
      else if (tp !== __entryChan) return;                  /* 同一手势的尾随事件，永久忽略 */
      const n = Date.now();
      if (n - __entryT < 250) return;                       /* 同通道防抖 */
      __entryT = n;
      setTimeout(() => {
        try { b.style.background = 'rgba(76,175,80,.65)'; } catch (e) {}
        setTimeout(() => { try { b.style.background = ''; } catch (e) {} }, 260);
      }, 130);
      开关面板('图标');
    };
    b.addEventListener('pointerdown', toggle);
    b.addEventListener('pointerup', toggle);
    b.addEventListener('click', toggle);
    b.addEventListener('touchend', toggle);
    host.appendChild(b);
  } catch (e) { /* 宿主结构不同时静默跳过，悬浮球仍是入口 */ }
}
/* 哨兵：酒馆重绘输入栏把入口抹掉时自动补挂 */
function 盯梢入口() {
  try {
    if (__entryObserver || !P.MutationObserver) return;
    let t = null;
    __entryObserver = new P.MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => { try { if (!PD.getElementById('zjh-st-entry')) 挂酒馆入口(); } catch (e) {} }, 800);
    });
    __entryObserver.observe(PD.body, { childList: true, subtree: true });
  } catch (e) {}
}
function 悬浮球自检() {
  setTimeout(() => {
    try {
      if (!$ball || $ball.style.display === 'none') return;
      const r = $ball.getBoundingClientRect();
      const 可见 = r.width > 10 && r.bottom > 0 && r.top < P.innerHeight && r.right > 0 && r.left < P.innerWidth;
      if (!可见) { $ball.style.display = 'none'; console.warn(TAG, '悬浮球不可见，已隐藏；请使用输入栏旁的 🧔‍♂️ 入口'); }
    } catch (e) {}
  }, 1500);
}
function refreshBall() {
  if (!$ball) return;
  $ball.classList.toggle('zjh-busy', !!(state.提取中 || state.回填中));
  const sc = $panel && $panel.querySelector('#zjh-scope');
  if (sc) sc.textContent = (SET.全局库 ? '全局库' : '本聊天') + (state.提取中 ? ' · 提取中' : '');
  refreshErrBadge();
}
function refreshErrBadge() {
  try {
    const dot = $ball && $ball.querySelector('.zjh-dot');
    if (dot) { dot.style.display = ERRS.length ? 'block' : 'none'; dot.textContent = ERRS.length; }
    if ($tabsEl) {
      const b = $tabsEl.querySelector('[data-tab="报错"] .zjh-badge');
      if (b) { b.style.display = ERRS.length ? 'block' : 'none'; b.textContent = ERRS.length; }
    }
  } catch (e) {}
}
function refreshStatsOnly() { if (state.open && state.activeTab === '统计') renderTab(); }
function 应用面板高度() {
  let h = Math.min(92, Math.max(30, SET.面板高度 || 62));
  if (state.缩小) h = 38;
  if ($panel) $panel.style.height = h + 'vh';
  const pr = PD.getElementById('zjh-progress');
  if (pr) pr.style.bottom = 'calc(' + (h + 2) + 'vh)';
  const sb = $panel && $panel.querySelector('[data-act="shrink"]');
  if (sb) sb.textContent = state.缩小 ? '还原' : '缩小';
}

function renderTabs() {
  if (!$tabsEl) return;
  $tabsEl.innerHTML = TABS.map(t => `<button class="zjh-tab" data-tab="${t}">${t}${t === '报错' ? '<span class="zjh-badge" style="display:none"></span>' : ''}</button>`).join('');
  refreshErrBadge();
}

/* ---------- 诊断黑匣子：面板打不开时把真相直接贴在屏幕上 ---------- */
function 诊断覆盖层(lines) {
  try {
    let d = PD.getElementById('zjh-dbg');
    if (!d) {
      d = PD.createElement('div'); d.id = 'zjh-dbg';
      d.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483647;background:rgba(8,10,14,.97);color:#9fe88a;font:12px/1.6 monospace;padding:10px 12px;border-radius:10px;max-height:46vh;overflow:auto;white-space:pre-wrap;word-break:break-all;border:1px solid rgba(159,232,138,.4);';
      d.addEventListener('click', () => { try { d.remove(); } catch (e) {} });
      PD.body.appendChild(d);
    }
    d.textContent = '[记忆助手诊断] 点我关闭\n' + lines.join('\n');
    clearTimeout(d.__t); d.__t = setTimeout(() => { try { d.remove(); } catch (e) {} }, 12000);
  } catch (e) {}
}
function 硬写样式(el, props) {
  try { for (const k in props) el.style.setProperty(k, props[k], 'important'); } catch (e) {}
}
function 面板体检() {
  /* 返回 null = 面板正常可见；否则返回诊断文本 */
  const L = [];
  try {
    const p = $panel;
    L.push('open=' + state.open + ' 面板存在=' + !!p + ' 在文档里=' + (p && p.isConnected));
    if (!p || !p.isConnected) return L;
    const c = P.getComputedStyle(p), r = p.getBoundingClientRect();
    L.push('display=' + c.display + ' vis=' + c.visibility + ' opacity=' + c.opacity + ' pos=' + c.position);
    L.push('zIndex=' + c.zIndex + ' transform=' + c.transform);
    L.push('bottom=' + c.bottom + ' left=' + c.left + ' height=' + c.height);
    L.push('rect=' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' 屏高=' + P.innerHeight);
    let 盖住 = '?';
    try { const hit = PD.elementFromPoint(Math.round(P.innerWidth / 2), Math.max(5, P.innerHeight - 30)); 盖住 = hit ? (hit.tagName + '#' + (hit.id || '-') + '.' + String(hit.className || '').split(' ')[0]) : 'null'; } catch (e) {}
    L.push('面板位置实际命中=' + 盖住);
    const ok = c.display !== 'none' && r.height > 30 && r.bottom > 0 && r.top < P.innerHeight;
    return ok ? null : L;
  } catch (e) { L.push('体检异常:' + e); return L; }
}
function 面板急救() {
  /* 核弹级：全部内联 !important 强写，z-index 拉满，绕开一切 CSS 战争 */
  if (!$panel || !$panel.isConnected) { try { 建界面(); } catch (e) {} try { if ($panel) $panel.addEventListener('input', 委托输入); } catch (e) {} }
  if (!$panel) return;
  $panel.classList.remove('zjh-gone'); $panel.classList.add('zjh-show');
  硬写样式($panel, {
    'display': 'flex', 'position': 'fixed', 'left': '0', 'right': '0',
    'bottom': '0', 'top': 'auto', 'transform': 'none', 'visibility': 'visible',
    'opacity': '1', 'z-index': '2147483000', 'height': '62vh',
    'background': 'rgba(24,22,34,.97)', 'flex-direction': 'column', 'overflow': 'hidden'
  });
  if ($mask) 硬写样式($mask, { 'opacity': '1', 'pointer-events': 'auto' });
}

function 开面板() {
  /* 自愈：面板被外部（酒馆重绘/残留清理）抹掉时先重建 */
  if (!$panel || !$panel.isConnected || !PD.getElementById('zjh-panel')) {
    try { 建界面(); } catch (e) {}
    try { if ($panel) $panel.addEventListener('input', 委托输入); } catch (e) {}
  }
  state.open = true;
  state.activeTab = TABS.includes(UIST.打开标签) ? UIST.打开标签 : '人物';
  if ($panel) {
    $panel.classList.remove('zjh-gone');
    $panel.classList.add('zjh-show');
    /* 核弹级内联强写：!important 内联 + 最高 z-index，任何 CSS 战争都压不住 */
    const 浮动 = $panel.classList.contains('zjh-float');
    硬写样式($panel, 浮动 ? {
      'display': 'flex', 'visibility': 'visible', 'opacity': '1', 'transform': 'none', 'z-index': '2147483000'
    } : {
      'display': 'flex', 'position': 'fixed', 'left': '0', 'right': '0', 'bottom': '0', 'top': 'auto',
      'transform': 'none', 'visibility': 'visible', 'opacity': '1', 'z-index': '2147483000',
      'background': 'rgba(24,22,34,.97)', 'flex-direction': 'column', 'overflow': 'hidden'
    });
    应用面板高度();
  }
  if ($mask) { $mask.classList.add('zjh-show'); $mask.style.opacity = '1'; $mask.style.pointerEvents = 'auto'; }
  renderTab(); refreshBall();
  /* 打开后自检：面板没真的出现就急救 */
  setTimeout(() => {
    try { if (state.open && 面板体检()) 面板急救(); } catch (e) {}
  }, 300);
}

/* 统一开关：每次打开后自动体检；面板没真的出现就急救，并把诊断贴出来 */
function 开关面板(来源) {
  try { state.open ? 关面板() : 开面板(); } catch (e) { pushError('其他', '开关面板失败(' + (来源 || '') + ')', String(e)); }
  setTimeout(() => {
    try {
      if (!state.open) return;                 /* 这次是关闭，不体检 */
      const bad = 面板体检();
      if (!bad) return;                        /* 一切正常，不打扰 */
      const L = ['【第1步：常规开启后体检】'].concat(bad);
      try { 面板急救(); } catch (e) { L.push('急救异常:' + e); }
      setTimeout(() => {
        try {
          const bad2 = 面板体检();
          if (bad2) { L.push('【第2步：急救后仍不可见】'); L.push.apply(L, bad2); }
          else L.push('【第2步：急救后面板已可见】');
          诊断覆盖层(L);
        } catch (e) {}
      }, 250);
    } catch (e) {}
  }, 450);
}

function 关面板() {
  state.open = false;
  if ($panel) { $panel.classList.remove('zjh-show'); $panel.classList.add('zjh-gone'); $panel.style.setProperty('display', 'none', 'important'); }
  if ($mask) { $mask.classList.remove('zjh-show'); $mask.style.opacity = '0'; $mask.style.pointerEvents = 'none'; }
}

/* ---------- 通用拖拽：监听挂在父窗口，不依赖 pointer capture，兼容各类 WebView ---------- */
function 拖拽绑定(handle, opt) {
  const th = opt.阈值 == null ? 8 : opt.阈值;
  let active = false, started = false, sx = 0, sy = 0;
  const move = (e) => {
    if (!active) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!started) {
      if (Math.abs(dx) + Math.abs(dy) < th) return;
      started = true;
      if (opt.onFirstMove) opt.onFirstMove(e);
    }
    if (opt.onMove) opt.onMove(e, dx, dy);
  };
  const up = (e) => {
    if (!active) return;
    active = false;
    P.removeEventListener('pointermove', move, true);
    P.removeEventListener('pointerup', up, true);
    P.removeEventListener('pointercancel', up, true);
    if (opt.onEnd) opt.onEnd(e, started);
    started = false;
  };
  handle.addEventListener('pointerdown', (e) => {
    if (opt.canStart && !opt.canStart(e)) return;
    active = true; started = false; sx = e.clientX; sy = e.clientY;
    P.addEventListener('pointermove', move, true);
    P.addEventListener('pointerup', up, true);
    P.addEventListener('pointercancel', up, true);
    if (opt.onDown) opt.onDown(e);
  });
}

/* ---------- 悬浮球：短按开关面板，长按隐藏界面，拖动移位 ---------- */
function 绑定球拖拽() {
  let ox = 0, oy = 0, downAt = 0;
  $ball.addEventListener('contextmenu', (e) => e.preventDefault());
  拖拽绑定($ball, {
    阈值: 9,
    onDown: (e) => {
      downAt = Date.now();
      const r = $ball.getBoundingClientRect(); ox = r.left; oy = r.top;
      e.preventDefault();
    },
    onMove: (e, dx, dy) => {
      const L = Math.min(Math.max(0, ox + dx), P.innerWidth - 46);
      const T = Math.min(Math.max(0, oy + dy), P.innerHeight - 46);
      $ball.style.left = L + 'px'; $ball.style.top = T + 'px';
      $ball.style.right = 'auto'; $ball.style.bottom = 'auto';
    },
    onEnd: (e, started) => {
      if (started) { UIST.球位置 = { left: $ball.style.left, top: $ball.style.top }; saveUI(); return; }
      if (Date.now() - downAt > 900) {
        if (P.confirm && P.confirm('临时隐藏记忆助手界面？\n（用于界面挡住其他插件时自救；刷新页面后恢复）')) {
          关面板();
          $ball.style.display = 'none';
          uiToast('记忆助手界面已隐藏，刷新页面恢复');
        }
        return;
      }
      开关面板('悬浮球');
    },
  });
  if (UIST.球位置 && UIST.球位置.left) {
    $ball.style.left = UIST.球位置.left; $ball.style.top = UIST.球位置.top;
    $ball.style.right = 'auto'; $ball.style.bottom = 'auto';
  }
}
/* ---------- 面板主体自由拖拽（头部为把手，双击归位底部） ---------- */
function 绑定面板拖拽() {
  const head = $panel.querySelector('#zjh-header');
  let ox = 0, oy = 0;
  拖拽绑定(head, {
    阈值: 7,
    canStart: (e) => !e.target.closest('button'),
    onDown: () => { const r = $panel.getBoundingClientRect(); ox = r.left; oy = r.top; },
    onFirstMove: () => { $panel.classList.add('zjh-float'); },
    onMove: (e, dx, dy) => {
      const w = $panel.offsetWidth;
      $panel.style.left = Math.min(Math.max(0, ox + dx), P.innerWidth - w * 0.4) + 'px';
      $panel.style.top = Math.min(Math.max(0, oy + dy), P.innerHeight - 60) + 'px';
    },
    onEnd: (e, started) => { if (started) { try { __dragEndT = Date.now(); } catch (err) {} } },
  });
  head.addEventListener('dblclick', () => {
    $panel.classList.remove('zjh-float');
    $panel.style.left = ''; $panel.style.top = '';
  });
}
/* ==================== 11. 界面：标签页渲染 ==================== */
function 条目摘要(类目名, e) {
  const seg = [];
  if (类目名 === '人物') {
    if (e.外貌.length) seg.push(`<b>外貌</b> ${esc(e.外貌.join('；'))}`);
    if (e.状态.情绪健康) seg.push(`<b>状态</b> ${esc(e.状态.情绪健康)}`);
    if (e.状态.外表) seg.push(`<b>外表</b> ${esc(e.状态.外表)}`);
    if (e.天赋.length) seg.push(`<b>天赋</b> ${esc(e.天赋.join('；'))}`);
    if (e.关系网.length) seg.push(`<b>关系</b> ${esc(e.关系网.join('；'))}`);
    if (e.技能.length) seg.push(`<b>技能</b> ${esc(e.技能.join('；'))}`);
    if (e.财产.length) seg.push(`<b>财产</b> ${esc(e.财产.join('；'))}`);
  } else if (类目名 === '物品') {
    if (e.描述.length) seg.push(`<b>描述</b> ${esc(e.描述.join('；'))}`);
    if (e.功能特性.length) seg.push(`<b>功能</b> ${esc(e.功能特性.join('；'))}`);
    if (e.归属) seg.push(`<b>归属</b> ${esc(e.归属)}`);
    if (e.完整度) seg.push(`<b>完整度</b> ${esc(e.完整度)}`);
  } else if (类目名 === '环境') {
    if (e.概况.length) seg.push(`<b>概况</b> ${esc(e.概况.join('；'))}`);
    if (e.布局.length) seg.push(`<b>布局</b> ${esc(e.布局.join('；'))}`);
  } else if (类目名 === '社会结构') {
    if (e.类型) seg.push(`<b>类型</b> ${esc(e.类型)}`);
    if (e.描述.length) seg.push(`<b>描述</b> ${esc(e.描述.join('；'))}`);
  } else {
    if (e.内容 && e.内容.length) seg.push(esc(e.内容.join('；')));
  }
  return seg.join('<br>');
}
function 渲染类目页(类目名, isCustom) {
  const cat = isCustom ? DATA.自定义[类目名] : DATA.类目[类目名];
  if (!cat) { $body.innerHTML = `<div class="zjh-empty">类目不存在</div>`; return; }
  const q = (state['搜索_' + 类目名] || '').trim();
  let names = Object.keys(cat.条目);
  if (q) names = names.filter(n => n.includes(q) || JSON.stringify(cat.条目[n]).includes(q));
  names.sort((a, b) => a.localeCompare(b, 'zh'));
  const ruleDesc = cat.规则.启用 ? (cat.规则.方式 === '关闭' ? '注入关闭' : cat.规则.方式 === '关键词' ? '按关键词注入' : '全量注入') : '已停用';
  let html = `
    <div class="zjh-toolbar">
      <input type="search" placeholder="搜索…" data-search="${esc(类目名)}" value="${esc(q)}">
      <button class="zjh-btn zjh-ghost zjh-sm" data-act="cat-rule" data-cat="${esc(类目名)}" data-custom="${isCustom ? 1 : 0}">规则·${esc(ruleDesc)}</button>
      <button class="zjh-btn zjh-sm" data-act="add-entry" data-cat="${esc(类目名)}" data-custom="${isCustom ? 1 : 0}">＋新增</button>
    </div>`;
  if (!names.length) html += `<div class="zjh-empty">暂无条目${q ? '（无匹配）' : '，点右上角「＋新增」或等待自动提取'}</div>`;
  if (names.length > 50) html += `<div class="zjh-card" style="border-color:rgba(229,181,72,.4)"><span style="font-size:12px;color:#ffd98a">共 ${names.length} 条，仅显示前 50 条——请用上方搜索框定位</span></div>`;
  for (const n of names.slice(0, 50)) {
    const e = cat.条目[n];
    const prop = 类目名 === '人物' && e.建议修改 && e.建议修改.length ? `<span class="zjh-mini zjh-warn">建议修改×${e.建议修改.length}</span>` : '';
    const kw = e.规则 && e.规则.方式 && e.规则.方式 !== '跟随类目' ? `<span class="zjh-mini">${esc(e.规则.方式)}</span>` : '';
    html += `<div class="zjh-card">
      <div class="zjh-card-head"><div class="zjh-name">${esc(n)}</div>${prop}${kw}
        <button class="zjh-btn zjh-ghost zjh-sm" data-act="edit-entry" data-cat="${esc(类目名)}" data-name="${esc(n)}" data-custom="${isCustom ? 1 : 0}">编辑</button></div>
      <div class="zjh-sub">${条目摘要(类目名, e) || '<span style="color:#777">（空）</span>'}</div>
    </div>`;
  }
  $body.innerHTML = html;
}
function 渲染自定义页() {
  const cats = Object.keys(DATA.自定义);
  let html = `<div class="zjh-toolbar">
      <span style="font-size:12px;color:#9d97b8">自定义一级类目（条目含 名称/注入规则/内容）</span>
      <button class="zjh-btn zjh-sm" data-act="add-cat">＋新增类目</button></div>`;
  if (!cats.length) html += `<div class="zjh-empty">还没有自定义类目<br>可用来记录 任务、传闻、时间线 等任意信息</div>`;
  for (const c of cats) {
    const cat = DATA.自定义[c];
    const n = Object.keys(cat.条目).length;
    const ruleDesc = cat.规则.启用 ? cat.规则.方式 : '停用';
    html += `<div class="zjh-card"><div class="zjh-card-head"><div class="zjh-name">${esc(c)}</div>
      <span class="zjh-mini">${n} 条</span><span class="zjh-mini">${esc(ruleDesc)}</span>
      <button class="zjh-btn zjh-ghost zjh-sm" data-act="open-cat" data-cat="${esc(c)}">管理</button>
      <button class="zjh-btn zjh-ghost zjh-sm" data-act="edit-cat" data-cat="${esc(c)}">设置</button></div></div>`;
  }
  if (state.自定义打开 && DATA.自定义[state.自定义打开]) {
    html += `<div class="zjh-sec">「${esc(state.自定义打开)}」的条目
      <button class="zjh-btn zjh-ghost zjh-sm" style="float:right" data-act="open-cat" data-cat="">收起</button></div>`;
    const cat = DATA.自定义[state.自定义打开];
    html += `<div class="zjh-toolbar"><button class="zjh-btn zjh-sm" data-act="add-entry" data-cat="${esc(state.自定义打开)}" data-custom="1">＋新增条目</button></div>`;
    const ents = Object.entries(cat.条目);
    if (ents.length > 50) html += `<div class="zjh-card"><span style="font-size:12px;color:#ffd98a">共 ${ents.length} 条，仅显示前 50 条</span></div>`;
    for (const [n, e] of ents.slice(0, 50)) {
      html += `<div class="zjh-card"><div class="zjh-card-head"><div class="zjh-name">${esc(n)}</div>
        <button class="zjh-btn zjh-ghost zjh-sm" data-act="edit-entry" data-cat="${esc(state.自定义打开)}" data-name="${esc(n)}" data-custom="1">编辑</button></div>
        <div class="zjh-sub">${esc((e.内容 || []).join('；')) || '<span style="color:#777">（空）</span>'}</div></div>`;
    }
  }
  $body.innerHTML = html;
}

function 设置行(标签, 控件, 提示) {
  return `<div class="zjh-row"><label>${标签}</label>${控件}</div>` + (提示 ? `<div class="zjh-row"><div class="zjh-hint">${提示}</div></div>` : '');
}
function 开关(path, on) { return `<label class="zjh-switch"><input type="checkbox" data-set="${path}" ${on ? 'checked' : ''}><i></i></label>`; }
function 数值(path, v, min, max) { return `<input type="number" data-set="${path}" value="${v}" min="${min || 0}" max="${max || 999}">`; }

function 渲染设置页() {
  const s = SET, sub = s.副API;

  $body.innerHTML = `
  <div class="zjh-sec">提取</div>
  ${设置行('自动提取（每 N 楼）', 开关('启用自动提取', s.启用自动提取))}
  ${设置行('提取间隔楼数 N', 数值('提取间隔楼数', s.提取间隔楼数, 1, 50))}
  ${设置行('每次提取楼数', 数值('每次提取楼数', s.每次提取楼数, 1, 20), '一次提取最多发送的楼层数，过多会自动分批')}
  ${设置行('swipe 后自动重提取', 开关('swipe自动重提取', s.swipe自动重提取), '重新生成时撤回旧提取，以最终采用的回复为准')}

  <div class="zjh-sec">副 API（专门做提取，省钱不干扰主对话）</div>
  ${设置行('启用副 API', 开关('副API.启用', sub.启用))}
  <div class="zjh-hint">副API为浏览器直连 OpenAI 兼容端点；若服务商不允许跨域（CORS）会报错，此时请关闭副API改用主API静默生成。</div>
  ${设置行('API 地址', `<input type="text" data-set="副API.地址" value="${esc(sub.地址)}" placeholder="https://…" style="width:180px">`)}
  ${设置行('密钥', `<input type="password" data-set="副API.密钥" value="${esc(sub.密钥)}" style="width:180px">`)}
  ${设置行('模型', `<input type="text" data-set="副API.模型" value="${esc(sub.模型)}" placeholder="如 gpt-4o-mini" style="width:150px">`)}

  <div class="zjh-row"><button class="zjh-btn zjh-ghost zjh-sm" data-act="test-subapi">测试副 API 连通</button></div>

  <div class="zjh-sec">注入</div>
  ${设置行('注入总开关', 开关('注入总开关', s.注入总开关))}
  ${设置行('注入最大字符', 数值('注入最大字符', s.注入最大字符, 200, 20000), '超出预算时按优先级省略（自定义＜社会＜环境＜物品＜人物）')}
  ${设置行('默认注入深度', 数值('默认注入深度', s.默认注入深度, 0, 20))}
  ${设置行('默认注入角色', `<select data-set="默认注入角色"><option ${s.默认注入角色 === 'system' ? 'selected' : ''} value="system">system</option><option ${s.默认注入角色 === 'user' ? 'selected' : ''} value="user">user</option><option ${s.默认注入角色 === 'assistant' ? 'selected' : ''} value="assistant">assistant</option></select>`)}
  ${设置行('关键词扫描楼数', 数值('关键词扫描楼数', s.关键词扫描楼数, 1, 100), '「关键词」方式下，在最近 N 楼内出现条目名/关键词才注入')}

  <div class="zjh-sec">界面</div>
  ${设置行('面板高度', `<select data-set="面板高度">${[45, 55, 62, 70, 80, 90].map(v => `<option value="${v}" ${s.面板高度 === v ? 'selected' : ''}>${v}% 屏高</option>`).join('')}</select>`, '觉得面板太长就调小')}

  <div class="zjh-sec">存储</div>
  ${设置行('全局库（跨聊天共享）', 开关('全局库', s.全局库), '默认每个聊天独立记忆；开启后所有聊天共用一份记忆（两边数据互不相通）')}

  <div class="zjh-sec">提取提示词（高级）</div>
  <textarea data-set-area="提取系统提示词" style="min-height:160px">${esc(s.提取系统提示词)}</textarea>
  <div class="zjh-row" style="margin-top:8px">
    <button class="zjh-btn zjh-ghost zjh-sm" data-act="save-prompt">保存提示词</button>
    <button class="zjh-btn zjh-ghost zjh-sm" data-act="reset-prompt">恢复默认</button>
  </div>

  <div class="zjh-sec">其他</div>
  <div class="zjh-row"><button class="zjh-btn zjh-ghost zjh-sm" data-act="reset-ball">重置悬浮球位置</button></div>
  <div class="zjh-sec">迁移</div>
  <div class="zjh-row"><button class="zjh-btn zjh-ghost zjh-sm" data-act="migrate-jsr">从酒馆助手脚本迁移数据</button></div>
  <div class="zjh-hint">若你装过「记忆助手」酒馆助手脚本，点此把它的记忆/设置搬过来（需酒馆助手仍在运行）。</div>
  <div class="zjh-sec">危险区</div>
  <div class="zjh-row"><button class="zjh-btn zjh-danger zjh-sm" data-act="wipe-data">清空当前库全部记忆</button></div>`;
}

function 渲染报错页() {
  let html = `<div class="zjh-toolbar">
    <button class="zjh-btn zjh-sm" data-act="retry-extract">重试提取</button>
    <button class="zjh-btn zjh-ghost zjh-sm" data-act="copy-errors">一键复制</button>
    <button class="zjh-btn zjh-danger zjh-sm" data-act="clear-errors">清空</button>
    <span style="font-size:11px;color:#8f8aa8">保留最近 ${ERR_CAP} 条</span></div>`;
  if (!ERRS.length) html += `<div class="zjh-empty">暂无报错</div>`;
  for (const e of ERRS) {
    html += `<div class="zjh-card zjh-err-item">
      <div><span class="zjh-err-type">${esc(e.类型)}</span> <span style="font-size:11px;color:#8f8aa8">${esc(e.时间)}</span></div>
      <div style="margin-top:4px">${esc(e.信息)}</div>
      ${e.详情 ? `<pre>${esc(e.详情)}</pre>` : ''}</div>`;
  }
  $body.innerHTML = html;
}

function 渲染统计页() {
  const last = 最后楼层();
  const 待提取 = Math.max(0, last - DATA.已提取到);
  const kv = [];
  const 计数 = (cat) => { const es = Object.values(cat.条目); return `${es.length} 条`; };
  kv.push(['当前记忆库', SET.全局库 ? '全局库' : '本聊天']);
  kv.push(['人物', 计数(DATA.类目['人物']) + `（建议修改 ${Object.values(DATA.类目['人物'].条目).reduce((a, e) => a + (e.建议修改 ? e.建议修改.length : 0), 0)}）`]);
  kv.push(['物品', 计数(DATA.类目['物品'])]);
  kv.push(['环境', 计数(DATA.类目['环境'])]);
  kv.push(['社会结构', 计数(DATA.类目['社会结构'])]);
  kv.push(['自定义类目', Object.keys(DATA.自定义).length + ' 个']);
  kv.push(['提取进度', `已提取到第 ${DATA.已提取到} 楼 / 共 ${last} 楼（待提取 ${待提取} 楼）`]);
  kv.push(['距下次自动提取', SET.启用自动提取 ? Math.max(0, SET.提取间隔楼数 - 待提取) + ' 楼' : '自动提取已关闭']);
  kv.push(['上次提取', DATA.统计.上次提取时间 ? `${DATA.统计.上次提取时间}（${DATA.统计.上次提取范围}，${DATA.统计.上次耗时}s）` : '—']);
  kv.push(['累计提取', DATA.统计.累计提取次数 + ' 次']);
  kv.push(['注入状态', SET.注入总开关 ? `${当前注入ids.length} 个注入块 / ${上次注入文本.length} 字` : '注入已关闭']);
  let html = `<div class="zjh-card"><div class="zjh-kv">${kv.map(([k, v]) => `<div>${k}</div><div>${esc(v)}</div>`).join('')}</div></div>`;
  if (注入截断提示) html += `<div class="zjh-card"><span style="color:#ffb3b6;font-size:12px">${esc(注入截断提示)}</span></div>`;
  html += `<div class="zjh-toolbar">
      <button class="zjh-btn zjh-sm" data-act="extract-now" ${state.提取中 ? 'disabled' : ''}>立即提取</button>
      ${state.回填中 ? `<button class="zjh-btn zjh-danger zjh-sm" data-act="backfill-stop">中止回填</button>` : `<button class="zjh-btn zjh-ghost zjh-sm" data-act="backfill">从历史聊天回填</button>`}
      <button class="zjh-btn zjh-ghost zjh-sm" data-act="copy-inject">复制注入预览</button>
    </div>
    <div class="zjh-toolbar">
      <button class="zjh-btn zjh-ghost zjh-sm" data-act="export-data">导出记忆(复制)</button>
      <button class="zjh-btn zjh-ghost zjh-sm" data-act="import-data">导入记忆</button>
    </div>
    <div class="zjh-sec">注入预览（简化格式）</div>
    <textarea readonly style="min-height:150px;font-size:12px">${esc(上次注入文本 || '（当前没有注入内容：发送一条消息或点「立即提取」后生效）')}</textarea>`;
  $body.innerHTML = html;
}

function renderTab() {
  if (!$body) return;
  try {
    $tabsEl.querySelectorAll('.zjh-tab').forEach(b => b.classList.toggle('zjh-on', b.dataset.tab === state.activeTab));
    if (内置类目.includes(state.activeTab)) 渲染类目页(state.activeTab, false);
    else if (state.activeTab === '自定义') 渲染自定义页();
    else if (state.activeTab === '设置') 渲染设置页();
    else if (state.activeTab === '报错') 渲染报错页();
    else 渲染统计页();
    refreshBall();
  } catch (e) { pushError('其他', '界面渲染失败', String(e)); }
}
const renderTab防抖 = debounce(renderTab, 350);


/* ==================== 12. 界面：弹窗 ==================== */
function openModal(title, bodyHTML, footHTML) {
  const m = PD.getElementById('zjh-modal'); if (!m) return;
  PD.getElementById('zjh-m-title').textContent = title;
  PD.getElementById('zjh-m-body').innerHTML = bodyHTML;
  PD.getElementById('zjh-m-foot').innerHTML = footHTML || '';
  $modalMask.classList.add('zjh-show');
}
function 关弹窗() { if ($modalMask) $modalMask.classList.remove('zjh-show'); state.modal = null; }

const 规则表单 = (r, 含跟随) => `
  <div class="zjh-sec">注入规则</div>
  ${设置行('启用注入', `<label class="zjh-switch"><input type="checkbox" id="zjh-f-rule-on" ${r.启用 !== false ? 'checked' : ''}><i></i></label>`)}
  ${设置行('注入方式', `<select id="zjh-f-rule-mode">
      ${含跟随 ? `<option value="跟随类目" ${!r.方式 || r.方式 === '跟随类目' ? 'selected' : ''}>跟随类目</option>` : ''}
      <option value="总是" ${r.方式 === '总是' ? 'selected' : ''}>总是（全量）</option>
      <option value="关键词" ${r.方式 === '关键词' ? 'selected' : ''}>关键词/最近提及</option>
      <option value="关闭" ${r.方式 === '关闭' ? 'selected' : ''}>不注入</option></select>`)}
  ${设置行('注入深度(0=默认)', `<input type="number" id="zjh-f-rule-depth" value="${r.深度 || 0}" min="0" max="20">`)}
  ${设置行('注入角色', `<select id="zjh-f-rule-role"><option value="" ${!r.角色 ? 'selected' : ''}>默认</option>
      <option value="system" ${r.角色 === 'system' ? 'selected' : ''}>system</option>
      <option value="user" ${r.角色 === 'user' ? 'selected' : ''}>user</option>
      <option value="assistant" ${r.角色 === 'assistant' ? 'selected' : ''}>assistant</option></select>`)}
  ${设置行('关键词(逗号分隔)', `<input type="text" id="zjh-f-rule-keys" value="${esc((r.关键词 || []).join(','))}" placeholder="留空则用条目名" style="width:170px">`)}
`;
function 读规则表单(含跟随) {
  const gv = id => { const el = PD.getElementById(id); return el ? el.value : ''; };
  return {
    启用: !!(PD.getElementById('zjh-f-rule-on') || {}).checked,
    方式: gv('zjh-f-rule-mode') || (含跟随 ? '跟随类目' : '总是'),
    深度: Math.max(0, parseInt(gv('zjh-f-rule-depth')) || 0),
    角色: gv('zjh-f-rule-role') || '',
    关键词: gv('zjh-f-rule-keys').split(/[,，]/).map(s => s.trim()).filter(Boolean),
  };
}
const 取类目 = (cat, custom) => custom ? DATA.自定义[cat] : DATA.类目[cat];
const 文本域 = (id, label, arr, hint) => `
  <div class="zjh-sec">${label}${hint ? `<span style="font-weight:400">（${hint}）</span>` : ''}</div>
  <textarea id="${id}">${esc((arr || []).join('\n'))}</textarea>`;
const 单行 = (id, label, v, hint) => `
  <div class="zjh-row"><label>${label}${hint ? `<span style="color:#8f8aa8">（${hint}）</span>` : ''}</label>
  <input type="text" id="${id}" value="${esc(v || '')}" style="flex:1 1 160px"></div>`;
const 读行 = (id) => { const el = PD.getElementById(id); return el ? el.value.trim() : ''; };
const 读列表 = (id) => 读行(id).split('\n').map(s => s.trim()).filter(Boolean);

function openEntryModal(cat, name, custom) {
  const c = 取类目(cat, custom); if (!c) return;
  const isNew = !name;
  const e = isNew ? 规整条目(custom ? '__自定义' : cat, null) : 规整条目(custom ? '__自定义' : cat, c.条目[name]);
  state.modal = { kind: 'entry', cat, name: name || '', custom: !!custom };
  let body = `<div class="zjh-row"><label>名称</label><input type="text" id="zjh-f-name" value="${esc(name || '')}" style="flex:1 1 160px"></div>`;
  if (cat === '人物' && !custom) {
    body += 文本域('zjh-f-外貌', '外貌', e.外貌, '只记录长相与身体细节，每行一条；只新增不修改')
      + 单行('zjh-f-情绪', '状态·情绪健康', e.状态.情绪健康, '每次提取整体覆盖')
      + 单行('zjh-f-外表', '状态·外表', e.状态.外表, '穿着/首饰，实时更新')
      + 文本域('zjh-f-天赋', '天赋', e.天赋, '性格、资质，每行一条')
      + 文本域('zjh-f-关系', '关系网', e.关系网, '格式：对象(关系)')
      + 文本域('zjh-f-技能', '技能', e.技能, '招式/法术等')
      + 文本域('zjh-f-财产', '财产', e.财产, '拥有的物品与生物');
    if (e.建议修改 && e.建议修改.length) {
      body += `<div class="zjh-sec">建议修改（外貌与剧情冲突时由 AI 提出）</div>`;
      e.建议修改.forEach((p, i) => {
        body += `<div class="zjh-proposal">旧：${esc(p.旧) || '（无，作为新增）'}<br>新：<span class="zjh-p-new">${esc(p.新)}</span>
          <br><span style="color:#9d97b8">${esc(p.理由)} ${esc(p.时间)}</span>
          <div style="margin-top:6px;display:flex;gap:6px">
            <button class="zjh-btn zjh-sm" data-act="adopt-proposal" data-cat="${esc(cat)}" data-name="${esc(name || '')}" data-idx="${i}">采用替换</button>
            <button class="zjh-btn zjh-ghost zjh-sm" data-act="drop-proposal" data-cat="${esc(cat)}" data-name="${esc(name || '')}" data-idx="${i}">忽略</button>
          </div></div>`;
      });
    }
  } else if (cat === '物品' && !custom) {
    body += 文本域('zjh-f-描述', '简略描述', e.描述) + 文本域('zjh-f-功能', '功能特性', e.功能特性)
      + 单行('zjh-f-归属', '归属', e.归属, '当前持有者') + 单行('zjh-f-完整度', '完整度', e.完整度, '完好/破损/残缺…');
  } else if (cat === '环境' && !custom) {
    body += 文本域('zjh-f-概况', '概况', e.概况) + 文本域('zjh-f-布局', '布局', e.布局, '新增/损毁的建筑、家具等');
  } else if (cat === '社会结构' && !custom) {
    body += 单行('zjh-f-类型', '类型', e.类型, '势力/宗教/组织/单位/社交圈') + 文本域('zjh-f-描述', '描述', e.描述);
  } else {
    body += 文本域('zjh-f-内容', '内容', e.内容, '每行一条');
  }
  body += 规则表单(e.规则 || { 方式: '跟随类目', 深度: 0, 角色: '', 关键词: [], 启用: true }, true);
  const foot = `${!isNew ? `<button class="zjh-btn zjh-danger zjh-sm" data-act="entry-del">删除</button>` : ''}
    <button class="zjh-btn zjh-ghost zjh-sm" data-act="modal-close">取消</button>
    <button class="zjh-btn zjh-sm" data-act="entry-save">保存</button>`;
  openModal((isNew ? '新增 · ' : '编辑 · ') + cat + (name ? ' · ' + name : ''), body, foot);
}
function 保存条目() {
  const m = state.modal; if (!m || m.kind !== 'entry') return;
  const c = 取类目(m.cat, m.custom); if (!c) return;
  const 新名 = 读行('zjh-f-name');
  if (!新名) { uiToast('名称不能为空', 'error'); return; }
  if (新名 !== m.name && c.条目[新名]) { uiToast('已存在同名条目', 'error'); return; }
  const e = 规整条目(m.custom ? '__自定义' : m.cat, m.name ? c.条目[m.name] : null);
  if (m.cat === '人物' && !m.custom) {
    e.外貌 = 读列表('zjh-f-外貌');
    e.状态 = { 情绪健康: 读行('zjh-f-情绪'), 外表: 读行('zjh-f-外表') };
    e.天赋 = 读列表('zjh-f-天赋'); e.关系网 = 读列表('zjh-f-关系');
    e.技能 = 读列表('zjh-f-技能'); e.财产 = 读列表('zjh-f-财产');
  } else if (m.cat === '物品' && !m.custom) {
    e.描述 = 读列表('zjh-f-描述'); e.功能特性 = 读列表('zjh-f-功能');
    e.归属 = 读行('zjh-f-归属'); e.完整度 = 读行('zjh-f-完整度');
  } else if (m.cat === '环境' && !m.custom) {
    e.概况 = 读列表('zjh-f-概况'); e.布局 = 读列表('zjh-f-布局');
  } else if (m.cat === '社会结构' && !m.custom) {
    e.类型 = 读行('zjh-f-类型'); e.描述 = 读列表('zjh-f-描述');
  } else {
    e.内容 = 读列表('zjh-f-内容');
  }
  e.规则 = 读规则表单(true);
  if (m.name && m.name !== 新名) delete c.条目[m.name];
  c.条目[新名] = e;
  saveData(); 刷新注入防抖(); 关弹窗(); renderTab(); uiToast('已保存', 'success');
}
function 删除条目() {
  const m = state.modal; if (!m || m.kind !== 'entry' || !m.name) return;
  const c = 取类目(m.cat, m.custom); if (!c) return;
  if (!P.confirm(`确定删除「${m.name}」？`)) return;
  delete c.条目[m.name];
  saveData(); 刷新注入防抖(); 关弹窗(); renderTab(); uiToast('已删除', 'success');
}

function openCatRuleModal(cat, custom) {
  const c = 取类目(cat, custom); if (!c) return;
  state.modal = { kind: 'catrule', cat, custom: !!custom };
  openModal('类目注入规则 · ' + cat,
    `<div style="font-size:12px;color:#9d97b8;margin-bottom:8px">对该类目下所有条目生效；条目可在编辑里单独覆盖。</div>` + 规则表单(c.规则, false),
    `<button class="zjh-btn zjh-ghost zjh-sm" data-act="modal-close">取消</button><button class="zjh-btn zjh-sm" data-act="catrule-save">保存</button>`);
}
function openCatModal(name) {
  const isNew = !name;
  state.modal = { kind: 'cat', name: name || '' };
  const cat = isNew ? { 规则: DEFAULT_RULE() } : DATA.自定义[name];
  openModal(isNew ? '新增自定义类目' : '类目设置 · ' + name,
    `<div class="zjh-row"><label>类目名</label><input type="text" id="zjh-f-catname" value="${esc(name || '')}" style="flex:1 1 160px"></div>` + 规则表单(cat.规则, false),
    `${!isNew ? `<button class="zjh-btn zjh-danger zjh-sm" data-act="cat-del">删除类目</button>` : ''}
     <button class="zjh-btn zjh-ghost zjh-sm" data-act="modal-close">取消</button><button class="zjh-btn zjh-sm" data-act="cat-save">保存</button>`);
}
function 保存类目() {
  const m = state.modal; if (!m) return;
  if (m.kind === 'catrule') {
    const c = 取类目(m.cat, m.custom); if (!c) return;
    c.规则 = 读规则表单(false);
  } else if (m.kind === 'cat') {
    const 新名 = 读行('zjh-f-catname');
    if (!新名) { uiToast('类目名不能为空', 'error'); return; }
    if (内置类目.includes(新名)) { uiToast('不能与内置类目重名', 'error'); return; }
    if (新名 !== m.name && DATA.自定义[新名]) { uiToast('已存在同名类目', 'error'); return; }
    if (m.name) { DATA.自定义[新名] = DATA.自定义[m.name]; if (新名 !== m.name) delete DATA.自定义[m.name]; }
    else DATA.自定义[新名] = { 规则: DEFAULT_RULE(), 条目: {} };
    DATA.自定义[新名].规则 = 读规则表单(false);
  }
  saveData(); 刷新注入防抖(); 关弹窗(); renderTab(); uiToast('已保存', 'success');
}
function 删除类目() {
  const m = state.modal; if (!m || m.kind !== 'cat' || !m.name) return;
  if (!P.confirm(`确定删除自定义类目「${m.name}」及其全部条目？`)) return;
  delete DATA.自定义[m.name];
  if (state.自定义打开 === m.name) state.自定义打开 = '';
  saveData(); 刷新注入防抖(); 关弹窗(); renderTab();
}
function openImportModal() {
  state.modal = { kind: 'import' };
  openModal('导入记忆（会覆盖当前库）',
    `<textarea id="zjh-f-import" placeholder="粘贴导出的 JSON…" style="min-height:200px"></textarea>`,
    `<button class="zjh-btn zjh-ghost zjh-sm" data-act="modal-close">取消</button><button class="zjh-btn zjh-sm" data-act="import-save">导入</button>`);
}
async function 复制文本(s) {
  try { await P.navigator.clipboard.writeText(s); uiToast('已复制', 'success'); return; } catch (e) {}
  try {
    const ta = PD.createElement('textarea'); ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0';
    PD.body.appendChild(ta); ta.select(); PD.execCommand('copy'); ta.remove(); uiToast('已复制', 'success');
  } catch (e) { uiToast('复制失败', 'error'); }
}
function 提案处理(cat, name, idx, adopt) {
  const c = DATA.类目[cat]; if (!c || !c.条目[name]) return;
  const e = c.条目[name]; const p = e.建议修改 && e.建议修改[idx]; if (!p) return;
  if (adopt) {
    const i = e.外貌.findIndex(x => norm(x) === norm(p.旧) || norm(x).includes(norm(p.旧)));
    if (i >= 0) e.外貌[i] = p.新; else if (p.新) e.外貌.push(p.新);
  }
  e.建议修改.splice(idx, 1);
  saveData(); 刷新注入防抖();
  openEntryModal(cat, name, false); renderTab();
  uiToast(adopt ? '已采用替换' : '已忽略', 'success');
}

/* ==================== 13. 事件委托 ==================== */
function setPath(obj, path, v) {
  const ks = String(path).split('.'); let o = obj;
  for (let i = 0; i < ks.length - 1; i++) { if (typeof o[ks[i]] !== 'object' || !o[ks[i]]) o[ks[i]] = {}; o = o[ks[i]]; }
  o[ks[ks.length - 1]] = v;
}
function 委托变更(ev) {
  const el = ev.target.closest && ev.target.closest('[data-set]'); if (!el) return;
  try {
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'number') v = parseFloat(el.value) || 0;
    else v = el.value;
    setPath(SET, el.dataset.set, v);
    saveSettings();
    const k = el.dataset.set;
    if (k === '面板高度') 应用面板高度();
    if (k === '全局库') { loadData(); 刷新注入防抖(); refreshBall(); if (state.open) renderTab(); uiToast(SET.全局库 ? '已切换到全局库' : '已切换到本聊天库', 'info'); }
    if (/^注入|默认注入|关键词扫描/.test(k)) { injDirty = true; 刷新注入防抖(); refreshStatsOnly(); }
  } catch (e) { pushError('其他', '设置保存失败', String(e)); }
}
function 委托输入(ev) {
  const el = ev.target.closest && ev.target.closest('[data-search]'); if (!el) return;
  state['搜索_' + el.dataset.search] = el.value;
  renderTab防抖();
}
let __lastActT = 0, __lastActEl = null, __dragEndT = 0, __downEl = null;
function 委托点击入口(ev) {
  const el = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
  if (!el) return;
  if (ev.type === 'pointerup') {
    if (Date.now() - __dragEndT < 350) return;   /* 刚拖完面板，忽略 */
    if (el !== __downEl) return;                  /* 按下和抬手必须在同一按钮上 */
  }
  const now = Date.now();
  if (el === __lastActEl && now - __lastActT < 600) return;  /* 去重：老旧 WebView 的 click 可能延迟数百毫秒才到 */
  __lastActT = now; __lastActEl = el;
  委托点击(ev);
}
async function 委托点击(ev) {
  const t = ev.target.closest && ev.target.closest('[data-act]'); if (!t) return;
  const act = t.dataset.act, cat = t.dataset.cat, name = t.dataset.name, custom = t.dataset.custom === '1';
  try {
    switch (act) {
      case 'close': 关面板(); break;
      case 'shrink': state.缩小 = !state.缩小; 应用面板高度(); break;
      case 'modal-close': 关弹窗(); break;
      case 'add-entry': openEntryModal(cat, null, custom); break;
      case 'edit-entry': openEntryModal(cat, name, custom); break;
      case 'entry-save': 保存条目(); break;
      case 'entry-del': 删除条目(); break;
      case 'cat-rule': openCatRuleModal(cat, custom); break;
      case 'catrule-save': 保存类目(); break;
      case 'add-cat': openCatModal(null); break;
      case 'edit-cat': openCatModal(cat); break;
      case 'cat-save': 保存类目(); break;
      case 'cat-del': 删除类目(); break;
      case 'open-cat': state.自定义打开 = cat || ''; renderTab(); break;
      case 'adopt-proposal': 提案处理(cat, name, parseInt(t.dataset.idx) || 0, true); break;
      case 'drop-proposal': 提案处理(cat, name, parseInt(t.dataset.idx) || 0, false); break;
      case 'extract-now': if (!state.提取中) 执行提取(true); break;
      case 'retry-extract': if (!state.提取中) { uiToast('正在重试提取…'); 执行提取(true); } break;
      case 'backfill': {
        if (state.回填中) break;
        if (!P.confirm('从历史聊天回填：把当前聊天全部楼层跑一遍提取，建立/补全初始档案。\n[确定] 继续  [取消] 放弃')) break;
        const clear = DATA.已提取到 >= 0 && P.confirm('是否先清空现有记忆重新建档？\n[确定] 清空重建  [取消] 保留现有并从断点继续');
        历史回填(clear);
        break;
      }
      case 'backfill-stop': state.回填中止 = true; uiToast('将在当前批结束后中止'); break;
      case 'copy-errors': 复制文本(JSON.stringify(ERRS, null, 2)); break;
      case 'clear-errors': ERRS = []; 写变量('script', { [VAR_ERR]: ERRS }); refreshErrBadge(); renderTab(); break;
      case 'copy-inject': 复制文本(上次注入文本 || '(空)'); break;
      case 'export-data': 复制文本(JSON.stringify(DATA, null, 2)); break;
      case 'import-data': openImportModal(); break;
      case 'import-save': {
        try {
          const j = JSON.parse(读行('zjh-f-import'));
          DATA = 规整数据(j); saveData(); 刷新注入防抖(); 关弹窗(); renderTab(); uiToast('导入成功', 'success');
        } catch (e) { uiToast('JSON 解析失败：' + e.message, 'error'); }
        break;
      }
      case 'save-prompt': {
        const ta = PD.querySelector('[data-set-area="提取系统提示词"]');
        if (ta) { SET.提取系统提示词 = ta.value; saveSettings(); uiToast('提示词已保存', 'success'); }
        break;
      }
      case 'reset-prompt':
        if (P.confirm('恢复默认提取提示词？')) { SET.提取系统提示词 = DEFAULT_SYS_PROMPT; saveSettings(); renderTab(); }
        break;
      case 'test-subapi': {
        uiToast('测试副 API 中…');
        try { const r = await 调用AI('只回复两个字：正常'); uiToast('副 API 连通：' + String(r).slice(0, 30), 'success'); }
        catch (e) { pushError('API报错(副)', String(e && e.message || e), ''); uiToast('副 API 失败：' + (e && e.message || e), 'error'); }
        break;
      }
      case 'reset-ball':
        UIST.球位置 = null; saveUI();
        if ($ball) { $ball.style.left = ''; $ball.style.top = ''; $ball.style.right = '14px'; $ball.style.bottom = '118px'; $ball.style.display = ''; }
        uiToast('悬浮球已回到默认位置', 'success');
        break;
      case 'migrate-jsr': {
        try {
          const TH = window.TavernHelper;
          if (!TH || typeof TH.getVariables !== 'function') { uiToast('未检测到酒馆助手的变量接口（酒馆助手未运行？）', 'error'); break; }
          const 搬 = (type) => { try { return TH.getVariables({ type }) || {}; } catch (e) { return {}; } };
          const chatV = 搬('chat'), scriptV = 搬('script'), globalV = 搬('global');
          let 搬到 = 0;
          const jobs = [];
          if (chatV['记忆助手_数据']) jobs.push(api.replaceVariables({ '记忆助手_数据': chatV['记忆助手_数据'] }, { type: 'chat' }).then(() => 搬到++));
          if (globalV['记忆助手_数据']) jobs.push(api.replaceVariables({ '记忆助手_数据': globalV['记忆助手_数据'] }, { type: 'global' }).then(() => 搬到++));
          const sv = {};
          if (scriptV['记忆助手_设置']) sv['记忆助手_设置'] = scriptV['记忆助手_设置'];
          if (scriptV['记忆助手_界面']) sv['记忆助手_界面'] = scriptV['记忆助手_界面'];
          if (Object.keys(sv).length) jobs.push(api.replaceVariables(sv, { type: 'script' }).then(() => 搬到++));
          Promise.all(jobs).then(() => {
            loadSettings(); loadUI(); loadData();
            injDirty = true; 刷新注入防抖(); if (state.open) renderTab();
            uiToast(搬到 ? ('迁移完成，共搬来 ' + 搬到 + ' 类数据') : '酒馆助手里没有可迁移的数据', 搬到 ? 'success' : 'info');
          }).catch((e) => uiToast('迁移失败：' + e, 'error'));
        } catch (e) { uiToast('迁移失败：' + e, 'error'); }
        break;
      }
      case 'wipe-data':
        if (P.confirm('清空当前库（' + (SET.全局库 ? '全局库' : '本聊天') + '）的全部记忆？此操作不可恢复！')
          && P.confirm('再次确认：真的要清空吗？')) {
          DATA = DEFAULT_DATA(); saveData(); 刷新注入防抖(); renderTab(); uiToast('已清空', 'success');
        }
        break;
    }
  } catch (e) { pushError('其他', '操作失败: ' + act, String(e)); }
}


/* ==================== 14. 初始化 ==================== */
async function init() {
  loadSettings();
  loadUI();
  loadErrs();
  loadData();
  建界面();
  if ($panel) $panel.addEventListener('input', 委托输入);
  绑定事件();
  /* 清理可能残留的旧注入（热重载场景） */
  try {
    if (api.uninjectPrompts) {
      const ids = 内置类目.map(c => INJ_PREFIX + c).concat(Object.keys(DATA.自定义 || {}).map(c => INJ_PREFIX + '自定义·' + c));
      api.uninjectPrompts(ids);
    }
  } catch (e) {}
  injDirty = true;
  setTimeout(() => { try { 刷新注入(); } catch (e) {} }, 800);
  /* 原生拓展无需卸载清理（禁用/删除拓展会整页刷新）。
     保留心跳：酒馆重绘输入栏把图标抹掉就补挂；面板开着却被抹掉就重建重开 */
  setInterval(() => {
    try {
      if (!PD.getElementById('zjh-st-entry') && !PD.hidden) 挂酒馆入口();
      if (state.open && (!$panel || !$panel.isConnected)) {
        建界面();
        try { if ($panel) $panel.addEventListener('input', 委托输入); } catch (e) {}
        开面板();
      }
    } catch (e) {}
  }, 3000);
  console.info(TAG, '拓展版 v' + EXT_VERSION + ' 加载完成（记忆库：' + (SET.全局库 ? '全局库' : '本聊天') + '）');
  /* 开机自检卡：证明新代码真的在跑（诊断期临时开启） */
  setTimeout(() => {
    try {
      const host = PD.getElementById('rightSendForm') || PD.getElementById('send_form') || PD.getElementById('top-bar');
      诊断覆盖层([
        '记忆助手拓展 v' + EXT_VERSION + ' 已启动（看到此卡=拓展已加载）',
        '运行方式=酒馆原生拓展（主页面直跑，无iframe）',
        '图标宿主=' + (host ? host.id : '未找到') + '，图标已挂载=' + !!PD.getElementById('zjh-st-entry'),
        '面板已创建=' + !!$panel + '，悬浮球=' + !!PD.getElementById('zjh-ball'),
        '点我关闭此卡；然后点输入栏的🧔‍♂️：紫闪=事件到达，绿闪=执行开关'
      ]);
    } catch (e) {}
  }, 1200);
}
try {
  await init();
} catch (e) {
  console.error(TAG, '初始化失败', e);
  try { pushError('其他', '初始化失败', String(e && e.stack || e)); } catch (e2) {}
}
})();
