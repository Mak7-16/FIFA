require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

/** Хто писав боту — для /list і розсилки /write (скидається при перезапуску). */
/** @type {Map<number, { username: string | null; first_name: string }>} */
const knownUsersById = new Map();

function parseAdminEnv() {
  const tokens = String(process.env.ADMIN_ID || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const numericIds = [];
  const usernames = [];
  for (const t of tokens) {
    if (/^\d+$/.test(t)) {
      numericIds.push(parseInt(t, 10));
      continue;
    }
    const u = t.replace(/^@/, '').toLowerCase();
    if (u) usernames.push(u);
  }
  return { numericIds, usernames };
}

const { numericIds: ADMIN_NUMERIC_IDS, usernames: ADMIN_USERNAMES } = parseAdminEnv();

function adminConfigured() {
  return ADMIN_NUMERIC_IDS.length > 0 || ADMIN_USERNAMES.length > 0;
}

function rememberUser(from) {
  if (!from?.id) return;
  knownUsersById.set(from.id, {
    username: from.username || null,
    first_name: from.first_name || '',
  });
}

function formatPlayerLabel(userId) {
  const u = knownUsersById.get(userId);
  if (u?.username) return `@${u.username}`;
  if (u?.first_name) return u.first_name;
  return `id:${userId}`;
}

/** Для parse_mode: Markdown (старий) — `_` у @nick_name та в тексті помилок ламає розбір у Telegram. */
function escapeMarkdownV1(text) {
  return String(text).replace(/([_*`[\]])/g, '\\$1');
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Підпис гравця для HTML-повідомлень PvP (клікабельний @username). */
function formatPlayerLabelHtml(userId) {
  const u = knownUsersById.get(userId);
  if (u?.username) {
    const x = escapeHtml(u.username);
    return `<a href="https://t.me/${x}">@${x}</a>`;
  }
  if (u?.first_name) return escapeHtml(u.first_name);
  return `<code>${userId}</code>`;
}

function getPvpSessionByUser(userId) {
  const sid = pvpUserToSession.get(userId);
  if (!sid) return null;
  return pvpSessions.get(sid) || null;
}

function destroyPvpSession(session) {
  pvpSessions.delete(session.sessionId);
  for (const pid of session.playerIds) {
    pvpUserToSession.delete(pid);
  }
}

function findPvpSessionByPair(idA, idB) {
  for (const s of pvpSessions.values()) {
    const [x, y] = s.playerIds;
    if ((x === idA && y === idB) || (x === idB && y === idA)) return s;
  }
  return null;
}

function normalizePhoneDigits(input) {
  let d = String(input || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10 && d[0] === '0') d = '38' + d;
  if (d.length === 9) d = '380' + d;
  if (d.startsWith('380') && d.length > 12) d = d.slice(0, 12);
  return d;
}

function rememberPhoneForUser(userId, phoneRaw) {
  const norm = normalizePhoneDigits(phoneRaw);
  if (norm.length < 10) return;
  phoneToUserId.set(norm, userId);
  if (norm.startsWith('380') && norm.length >= 12) {
    phoneToUserId.set(norm.slice(-9), userId);
  }
}

function lookupPhoneUserId(norm) {
  const n = normalizePhoneDigits(norm);
  if (!n) return null;
  if (phoneToUserId.has(n)) return phoneToUserId.get(n);
  const tail = n.startsWith('380') ? n.slice(3) : n;
  if (tail && phoneToUserId.has(tail)) return phoneToUserId.get(tail);
  return null;
}

function lookupUserIdByUsername(usernameLower) {
  for (const [id, info] of knownUsersById.entries()) {
    if (info.username && info.username.toLowerCase() === usernameLower) return id;
  }
  return null;
}

/** Один токен: id, @username / username, або номер телефону (після /pvp_contact). */
function resolvePvpTargetToken(token) {
  const t = String(token || '').trim().replace(/\s/g, '');
  if (!t) return { err: 'порожній операнд' };

  if (t.startsWith('@')) {
    const un = t.slice(1).toLowerCase();
    if (!/^[a-z0-9_]{5,32}$/.test(un)) return { err: 'некоректний @username' };
    const id = lookupUserIdByUsername(un);
    if (id != null) return { id };
    return { err: 'не знайдено такого @username — нехай напише боту /start' };
  }
  if (/^[a-z0-9_]{5,32}$/i.test(t) && !/^\d+$/.test(t)) {
    const id = lookupUserIdByUsername(t.toLowerCase());
    if (id != null) return { id };
  }

  if (/^\d+$/.test(t)) {
    const asId = parseInt(t, 10);
    if (String(asId) === t && asId > 0 && knownUsersById.has(asId)) return { id: asId };
    const norm = normalizePhoneDigits(t);
    if (norm.length >= 10) {
      const uid = lookupPhoneUserId(norm);
      if (uid) return { id: uid };
    }
    return {
      err: 'не знайдено: або такого id ще не було в боті, або номер не привʼязаний (/pvp_contact)',
    };
  }
  const norm = normalizePhoneDigits(t);
  if (norm.length >= 10) {
    const uid = lookupPhoneUserId(norm);
    if (uid) return { id: uid };
    return { err: 'номер не привʼязаний — нехай гравець надішле контакт боту (/pvp_contact)' };
  }
  return { err: 'некоректний запис (очікується id або номер)' };
}

/** Повертає { ids: [a,b] } або { ids: null, error: string }. */
function resolvePvpPairFromText(text) {
  const raw = String(text || '')
    .replace(/^\/pvp(@[A-Za-z0-9_]+)?\s*/i, '')
    .trim();
  if (!raw) return { ids: null, error: null };
  let left;
  let right;
  if (/\s+vs\s+/i.test(raw)) {
    const sp = raw.split(/\s+vs\s+/i);
    left = sp[0]?.trim();
    right = sp[1]?.trim();
  } else {
    const sp = raw.split(/\s+/).filter(Boolean);
    if (sp.length < 2) return { ids: null, error: 'Потрібно два операнди (id або номер), можна через vs.' };
    left = sp[0];
    right = sp[1];
  }
  if (!left || !right) return { ids: null, error: 'Після vs має бути другий гравець.' };
  const ra = resolvePvpTargetToken(left);
  const rb = resolvePvpTargetToken(right);
  if (ra.err) return { ids: null, error: `Гравець 1 (${left}): ${ra.err}` };
  if (rb.err) return { ids: null, error: `Гравець 2 (${right}): ${rb.err}` };
  if (ra.id === rb.id) return { ids: null, error: 'Потрібні два різних гравці.' };
  return { ids: [ra.id, rb.id] };
}

function pvpMoveKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('⚽ Пас', 'pvp:pass'),
      Markup.button.callback('🎯 Навіс', 'pvp:cross'),
      Markup.button.callback('🔥 Удар', 'pvp:shoot'),
    ],
    [
      Markup.button.callback('🛡 Відбір', 'pvp:tackle'),
      Markup.button.callback('🧱 Блок', 'pvp:block'),
      Markup.button.callback('📌 Пресинг', 'pvp:mark'),
    ],
  ]);
}

function formatPvPScore(session) {
  return `${session.scores[0]} : ${session.scores[1]}`;
}

/** Адмін: числовий id у ADMIN_ID або @username (наприклад Max_Misiura чи @Max_Misiura). */
function isAdminUser(from) {
  if (!from?.id || !adminConfigured()) return false;
  if (ADMIN_NUMERIC_IDS.includes(from.id)) return true;
  if (from.username && ADMIN_USERNAMES.includes(from.username.toLowerCase())) return true;
  return false;
}

function isAdminUserId(userId) {
  if (!adminConfigured()) return false;
  if (ADMIN_NUMERIC_IDS.includes(userId)) return true;
  const u = knownUsersById.get(userId);
  if (u?.username && ADMIN_USERNAMES.includes(u.username.toLowerCase())) return true;
  return false;
}

bot.use((ctx, next) => {
  if (ctx.from) rememberUser(ctx.from);
  return next();
});

bot.on('contact', async (ctx) => {
  const c = ctx.message?.contact;
  if (!c?.phone_number || !ctx.from) return;
  if (c.user_id != null && c.user_id !== ctx.from.id) {
    await ctx.reply('Надішли **свій** номер кнопкою «Поділитися контактом».', {
      parse_mode: 'Markdown',
      ...bottomMenuReplyKeyboard(),
    });
    return;
  }
  rememberPhoneForUser(ctx.from.id, c.phone_number);
  const norm = normalizePhoneDigits(c.phone_number);
  await ctx.reply(
    `✅ Номер **${norm}** збережено **у бота** — тебе можна викликати в **PvP за телефоном** (іншому гравцю номер не надсилай).\nКоманди PvP **не в меню** — лише текстом: \`/pvp …\``,
    { parse_mode: 'Markdown', ...bottomMenuReplyKeyboard() }
  );
});

/** Повтор запиту при 429 (retry_after у секундах). Ігнор «message is not modified». */
async function telegramSendOrRetry(fn) {
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const desc = String(e?.response?.description || '');
      if (desc.includes('message is not modified')) return null;
      const code = e?.response?.error_code;
      const waitSec = e?.response?.parameters?.retry_after ?? e?.parameters?.retry_after;
      if (code === 429 && typeof waitSec === 'number') {
        await new Promise((r) => setTimeout(r, (waitSec + 1) * 1000));
        continue;
      }
      throw e;
    }
  }
  throw new Error('Telegram API: занадто багато спроб після 429');
}

function replyMarkupFromExtra(extra) {
  return extra?.reply_markup;
}

async function postSoloMatchLiveBoard(ctx, state, extra) {
  const telegram = ctx.telegram;
  const chatId = ctx.chat.id;
  /** Текст (до 4096), без GIF — інакше Telegram часто дає 429 на sendAnimation. */
  const text = String(extra.caption || '').slice(0, 4096);
  const parse_mode = extra.parse_mode;
  const reply_markup = replyMarkupFromExtra(extra);

  const mid = state.liveAnimMessageId;
  if (mid) {
    try {
      await telegramSendOrRetry(() =>
        telegram.callApi('editMessageText', {
          chat_id: chatId,
          message_id: mid,
          text,
          ...(parse_mode ? { parse_mode } : {}),
          ...(reply_markup ? { reply_markup } : {}),
        })
      );
      return;
    } catch (e) {
      const d = String(e?.response?.description || '');
      if (d.includes('message is not modified')) return;
      console.warn('editMessageText (матч)', d);
      state.liveAnimMessageId = null;
    }
  }

  const sent = await telegramSendOrRetry(() =>
    telegram.sendMessage(chatId, text, {
      ...(parse_mode ? { parse_mode } : {}),
      ...(reply_markup ? { reply_markup } : {}),
    })
  );
  if (sent?.message_id) state.liveAnimMessageId = sent.message_id;
}

function pvpInlineKbOrEmpty(keyboardExtra) {
  const rows = keyboardExtra?.reply_markup?.inline_keyboard;
  if (rows && rows.length) return keyboardExtra.reply_markup;
  return { inline_keyboard: [] };
}

async function postPvpMatchLiveBoard(telegram, session, playerId, captionHtml, keyboardExtra) {
  const reply_markup = pvpInlineKbOrEmpty(keyboardExtra);
  const text = captionHtml.slice(0, 4096);
  const mid = session.liveAnimMsgByPlayer.get(playerId);
  if (mid) {
    try {
      await telegramSendOrRetry(() =>
        telegram.callApi('editMessageText', {
          chat_id: playerId,
          message_id: mid,
          text,
          parse_mode: 'HTML',
          reply_markup,
        })
      );
      return;
    } catch (e) {
      const d = String(e?.response?.description || '');
      if (d.includes('message is not modified')) return;
      console.warn('editMessageText (PvP)', d);
      session.liveAnimMsgByPlayer.delete(playerId);
    }
  }
  const sent = await telegramSendOrRetry(() =>
    telegram.sendMessage(playerId, text, {
      parse_mode: 'HTML',
      reply_markup,
    })
  );
  if (sent?.message_id) session.liveAnimMsgByPlayer.set(playerId, sent.message_id);
}

/**
 * Табло матчу: `liveAnimMessageId` — id текстового повідомлення в чаті (оновлення через editMessageText).
 * @type {Map<number, { you: number; them: number; turn: number; maxTurns: number; possession: 'you' | 'them'; liveAnimMessageId: number | null; tournament?: object | null; league?: object | null; playerSeason?: object | null }>}
 */
const fifaMatchByUser = new Map();

/** PvP: два гравці по черзі в одному матчі. */
/** @type {Map<string, { sessionId: string; playerIds: [number, number]; scores: [number, number]; currentIdx: 0 | 1; moveNum: number; maxTurns: number; possession: 'you' | 'them'; liveAnimMsgByPlayer: Map<number, number> }>} */
const pvpSessions = new Map();
/** userId → sessionId */
const pvpUserToSession = new Map();

/** Нормалізовані цифри номера → user id (після «поділитися контактом»). */
const phoneToUserId = new Map();

/** Адмін /transfer — кнопка «Обмін» у нижньому меню для всіх. */
let transferExchangeEnabled = false;

/** Ініціатор → id гравця, якого віддає (очікується /trade_partner). */
const tradeOfferDraft = new Map();

/** id пропозиції → { fromId, toId, fromPlayerId }. */
const tradeProposals = new Map();
let tradeProposalSeq = 1;

function clearTradeExchangeState() {
  tradeOfferDraft.clear();
  tradeProposals.clear();
}

/** Монети, сувеніри та склад гравців — у памʼяті, після перезапуску бота скидається. */
/** @type {Map<number, { coins: number; inventory: Record<string, number>; squad: Record<string, number> }>} */
const userWallet = new Map();

/** Серія пенальті: 5+5 у регламенті, потім булліти по парі ударів до вирішення. */
/** @type {Map<number, { you: number; them: number; moves: number; fromMatchDraw: boolean; tournamentMeta?: object | null }>} */
const penaltyByUser = new Map();

/** Активний турнір (етапи після перемоги в матчі). */
/** @type {Map<number, { defId: string; stageIndex: number }>} */
const tournamentProgressByUser = new Map();

/** Чемпіонат (ліга): 10 команд, 9 турів — ти проти 9 ботів; інші пари симулюються. */
/** @type {Map<number, { rows: object[]; round: number; finished: boolean }>} */
const leagueByUser = new Map();

const LEAGUE_OPPONENTS = [
  { key: 'g1', name: 'ФК «Район»', strength: 0.012 },
  { key: 'g2', name: '«Оболонь-2»', strength: 0.028 },
  { key: 'g3', name: '«Колос» (молодь)', strength: 0.04 },
  { key: 'g4', name: '«Верес»', strength: 0.052 },
  { key: 'g5', name: '«Десна»', strength: 0.064 },
  { key: 'g6', name: '«Зоря»', strength: 0.076 },
  { key: 'g7', name: '«Ворскла»', strength: 0.088 },
  { key: 'g8', name: '«Шахтар» (молодь)', strength: 0.1 },
  { key: 'g9', name: '«Динамо» (молодь)', strength: 0.115 },
];

/** Збірні для симуляції чемпіонату світу в кар'єрі гравця. */
const CAREER_WORLD_OPPONENTS = [
  { key: 'w1', name: 'збірна Бразилії' },
  { key: 'w2', name: 'збірна Аргентини' },
  { key: 'w3', name: 'збірна Франції' },
  { key: 'w4', name: 'збірна Німеччини' },
  { key: 'w5', name: 'збірна Іспанії' },
  { key: 'w6', name: 'збірна Англії' },
  { key: 'w7', name: 'збірна Португалії' },
  { key: 'w8', name: 'збірна Нідерландів' },
  { key: 'w9', name: 'збірна Італії' },
  { key: 'w10', name: 'збірна Хорватії' },
  { key: 'w11', name: 'збірна Бельгії' },
  { key: 'w12', name: 'збірна України' },
  { key: 'w13', name: 'збірна Польщі' },
  { key: 'w14', name: 'збірна Колумбії' },
  { key: 'w15', name: 'збірна Японії' },
];

/** Разові завдання кар'єри гравця — перевірка після підсумку сезону; нагорода при натисканні «Наступний сезон». */
const CAREER_QUEST_DEFS = [
  { id: 'cq_wc_win', label: 'Виграй Чемпіонат світу хоча б раз', rewardCoins: 200 },
  { id: 'cq_league_3', label: 'Стань чемпіоном ліги 3 рази', rewardCoins: 170 },
  { id: 'cq_triple_once', label: 'За один сезон: чемпіон ліги + кубок + єврокубок', rewardCoins: 240 },
  { id: 'cq_golden_3', label: 'Отримай 3 Золоті м’ячі за кар’єру', rewardCoins: 300 },
  { id: 'cq_euro_2', label: 'Виграй єврокубок 2 рази', rewardCoins: 150 },
  { id: 'cq_ovr93', label: 'Досягни 93+ OVR', rewardCoins: 140 },
];

const LEAGUE_POS_BONUS = [200, 130, 90, 65, 50, 40, 32, 25, 18, 12];

/** Режим кар'єри: club — ліга; player — кар'єра ікони; coach — офіс тренера; agent — агент (таланти). */
/** @type {Map<number, 'club' | 'player' | 'coach' | 'agent'>} */
const careerModeByUser = new Map();

/** Режим тренера: тактика й стан команди дають бонус у товариських матчах і кубку. */
/** @type {Map<number, { tactic: 'attack' | 'balance' | 'defense'; morale: number; fatigue: number; drillKind: 'tactical' | 'technical' | 'pressing' | 'passes' | 'finishing' | 'setpieces' | null; drillMatchesLeft: number; subsFresh: boolean }>} */
const coachStateByUser = new Map();

/** Сильніший бонус до ease (~2 матчі після тренування). */
const COACH_DRILL_STRONG = new Set(['tactical', 'pressing', 'setpieces']);
/** Середній бонус до ease. */
const COACH_DRILL_WEAK = new Set(['technical', 'passes', 'finishing']);

function coachDrillKindValid(k) {
  return Boolean(k && (COACH_DRILL_STRONG.has(k) || COACH_DRILL_WEAK.has(k)));
}

/** Режим агента: розвідка талантів, продаж контрактів, репутація (легкість у товариських / турнірі). */
/** @type {Map<number, { reputation: number; prospects: { first: string; last: string; ovr: number; potential: string }[] }>} */
const agentStateByUser = new Map();

const AGENT_ROSTER_MAX = 5;
const AGENT_FIRST_NAMES = [
  'Данііл',
  'Марко',
  'Тарас',
  'Орест',
  'Адам',
  'Лукʼян',
  'Назар',
  'Богдан',
  'Тимофій',
  'Ярослав',
];
const AGENT_LAST_NAMES = [
  'Шевченко',
  'Бойко',
  'Коваленко',
  'Гриценко',
  'Лисенко',
  'Мельник',
  'Бондар',
  'Олійник',
  'Ткаченко',
  'Романюк',
];

function getAgentState(userId) {
  if (!agentStateByUser.has(userId)) {
    agentStateByUser.set(userId, { reputation: 52, prospects: [] });
  }
  const a = agentStateByUser.get(userId);
  if (a.reputation == null || a.reputation < 1) a.reputation = 52;
  if (!Array.isArray(a.prospects)) a.prospects = [];
  return a;
}

/** Ймовірність «порожньої» розвідки: при високій репутації падає помітно сильніше. */
function agentScoutFailChance(rep) {
  const r = Math.min(100, Math.max(25, rep));
  return Math.max(0.17, Math.min(0.58, 0.615 - (r - 52) * 0.0072));
}

/** Короткий опис рівня — щоб репутація була зрозумілою в офісі. */
function agentReputationTierTitle(rep) {
  const x = Math.min(100, Math.max(25, rep));
  if (x >= 86) return '⭐ Елітний агент';
  if (x >= 72) return '📈 Імʼя на ринку';
  if (x >= 58) return '🎯 Помічений клубами';
  if (x >= 44) return '📋 Працюєш по базі';
  return '⚠️ Новачок у бізнесі';
}

/** Якщо не null — знайдено таланта (після успішної перевірки). */
function rollAgentProspectOnHit(userId) {
  const rep = getAgentState(userId).reputation;
  const r = Math.min(100, Math.max(25, rep));
  const ceiling = Math.min(87, 74 + Math.floor((r - 52) / 5));
  let ovr = 55 + Math.floor((r - 52) / 8) + Math.floor(Math.random() * 8) - 3;
  const trimChance = Math.max(0.35, 0.76 - (r - 52) * 0.0065);
  if (Math.random() < trimChance) ovr -= Math.floor(Math.random() * 4);
  ovr = Math.max(52, Math.min(ceiling, ovr));
  const gemChance = Math.min(0.145, 0.036 + (r - 52) * 0.00115);
  if (Math.random() < gemChance) ovr = Math.min(89, ovr + 2 + Math.floor(Math.random() * 5));
  const potRoll = Math.random() + r / 195;
  const potential =
    potRoll > 1.2 ? '★ топ-потенціал' : potRoll > 0.92 ? 'хороший запас' : 'перспективний';
  const first = AGENT_FIRST_NAMES[Math.floor(Math.random() * AGENT_FIRST_NAMES.length)];
  const last = AGENT_LAST_NAMES[Math.floor(Math.random() * AGENT_LAST_NAMES.length)];
  return { first, last, ovr, potential };
}

function randomAgentScoutMissLine() {
  const lines = [
    '<b>Без результату.</b> Академія не пустила на огляд — спробуй пізніше.',
    '<b>Без результату.</b> На зборах «нікого видного» — лише другий план.',
    '<b>Без результату.</b> Тренер заховав перспективних — доступ закритий.',
    '<b>Без результату.</b> Перегляд у «нижчій лізі» не склався — дорога марна.',
    '<b>Без результату.</b> Конкурент встиг перехопити контакт.',
  ];
  return lines[Math.floor(Math.random() * lines.length)];
}

function agentEaseFromState(userId) {
  const r = getAgentState(userId).reputation;
  const clamped = Math.max(25, Math.min(100, r));
  return Math.min(0.034, Math.max(0, (clamped - 42) * 0.00072));
}

function bumpAgentAfterMatch(userId, you, them) {
  if (getCareerMode(userId) !== 'agent') return;
  const a = getAgentState(userId);
  if (you > them) a.reputation = Math.min(100, a.reputation + 2);
  else if (them > you) a.reputation = Math.max(25, a.reputation - 1);
  else a.reputation = Math.min(100, a.reputation + 1);
}

function bumpCoachOrAgentAfterFriendly(userId, you, them, leagueSnap, psSnap) {
  if (leagueSnap || psSnap) return;
  const m = getCareerMode(userId);
  if (m === 'coach') bumpCoachAfterMatch(userId, you, them);
  else if (m === 'agent') bumpAgentAfterMatch(userId, you, them);
}

function agentOfficeKeyboard(userId) {
  const a = getAgentState(userId);
  const rows = [];
  rows.push([Markup.button.callback('🔍 Розвідка (новий талант)', 'agent:scout')]);
  for (let i = 0; i < a.prospects.length; i += 1) {
    const p = a.prospects[i];
    const label = `💼 ${p.first.slice(0, 9)} ·${p.ovr}`.slice(0, 58);
    rows.push([Markup.button.callback(label, `agent:sell:${i}`)]);
  }
  rows.push([Markup.button.callback('📇 Мережа клубів (+реп.)', 'agent:network')]);
  rows.push([Markup.button.callback('🔙 Закрити', 'agent:close')]);
  return Markup.inlineKeyboard(rows);
}

async function openAgentOfficeOrHint(ctx) {
  if (getCareerMode(ctx.from.id) !== 'agent') {
    await ctx.reply(
      '<b>🤝 Офіс агента</b> доступний у режимі агента.\nПеремкни <code>/swap</code>: клуб → гравець → тренер → <b>агент</b>. Потім «🤝 Агент» або «📊 Чемпіонат».',
      { parse_mode: 'HTML' }
    );
    return;
  }
  await showAgentOffice(ctx);
}

async function showAgentOffice(ctx) {
  const uid = ctx.from.id;
  getWallet(uid);
  const a = getAgentState(uid);
  const bonus = agentEaseFromState(uid).toFixed(3);
  const tier = agentReputationTierTitle(a.reputation);
  const failPct = Math.round(agentScoutFailChance(a.reputation) * 100);
  const rosterLines =
    a.prospects.length === 0
      ? '<i>Поки нікого — натисни «Розвідка».</i>'
      : a.prospects
          .map((p, i) => `${i + 1}. <b>${escapeHtml(p.first)} ${escapeHtml(p.last)}</b> · OVR <b>${p.ovr}</b> · ${escapeHtml(p.potential)}`)
          .join('\n');
  await ctx.reply(
    `<b>🤝 Офіс агента</b>\n\n` +
      `<b>Репутація:</b> ${a.reputation}/100 · ${tier}\n` +
      `<i>Ефект: рідші провали розвідки (~<b>${failPct}%</b> «нічого не знайшли»), вищі OVR і кращий потенціал талантів, більша комісія при продажі, сильніший бонус у матчі проти бота.</i>\n` +
      `<i>Бонус до легкості матчу (зі складом): до ~<b>${bonus}</b>.</i>\n\n` +
      `<b>Твої таланти (${a.prospects.length}/${AGENT_ROSTER_MAX}):</b>\n${rosterLines}\n\n` +
      `<i>Без клубної ліги; товариські матчі та турніри як у тренера. Контракти — кнопками 💼.</i>\n` +
      `Баланс: <b>${getWallet(uid).coins}</b> 🪙.`,
    { parse_mode: 'HTML', ...agentOfficeKeyboard(uid) }
  );
}

/**
 * Кар'єра гравця (режим /swap → player): сезони, контракти, симуляція турнірів, фінали гра/сим.
 * @type {Map<number, {
 *   season: number,
 *   phase: 'pick_player' | 'pick_club' | 'contracts' | 'sim_idle' | 'final_pick' | 'season_outro',
 *   playerKey: string,
 *   playerName: string,
 *   playerOvr: number,
 *   playerAge: number,
 *   playerOffers: { key: string, name: string, baseOvr: number, startAge: number }[] | null,
 *   clubKey: string,
 *   clubName: string,
 *   offers: { clubKey: string, clubName: string }[] | null,
 *   resultLines: string[],
 *   finalsQueue: { key: string, label: string, opponent: string, strength: number }[],
 *   leaguePlace: number | null,
 *   cupReachedFinal: boolean,
 *   euroReachedFinal: boolean,
 *   wcReachedFinal: boolean,
 *   cupWon: boolean | null,
 *   euroWon: boolean | null,
 *   wcWon: boolean | null,
 *   careerStats?: { leagueTitles: number, cupWins: number, euroWins: number, wcWins: number, goldenBalls: number, goldenBoots: number, silverStars: number },
 *   careerQuestClaimed?: Record<string, boolean>,
 *   honorsGrantedSeason?: number | null,
 *   accumulatedSeason?: number | null,
 *   careerTripleCrowns?: number,
 *   triplesRecordedSeason?: number | null,
 * }>}
 */
const playerCareerByUser = new Map();

/** Клуби для контрактів у кар'єрі гравця (короткі ключі для callback). */
const PLAYER_CAREER_CLUBS = [
  { key: 'p1', name: 'ФК «Район»' },
  { key: 'p2', name: '«Оболонь-2»' },
  { key: 'p3', name: '«Колос» (молодь)' },
  { key: 'p4', name: '«Верес»' },
  { key: 'p5', name: '«Десна»' },
  { key: 'p6', name: '«Зоря»' },
  { key: 'p7', name: '«Ворскла»' },
  { key: 'p8', name: '«Шахтар» (молодь)' },
  { key: 'p9', name: '«Динамо» (молодь)' },
  { key: 'p10', name: '«Рух»' },
  { key: 'p11', name: '«Металіст 1925»' },
  { key: 'p12', name: '«Львів»' },
  { key: 'e1', name: '«Барселона»' },
  { key: 'e2', name: '«Реал Мадрид»' },
  { key: 'e3', name: '«Атлетіко» (Мадрид)' },
  { key: 'e4', name: '«Манчестер Сіті»' },
  { key: 'e5', name: '«Ліверпуль»' },
  { key: 'e6', name: '«Челсі»' },
  { key: 'e7', name: '«Арсенал»' },
  { key: 'e8', name: '«Баварія»' },
  { key: 'e9', name: '«Боруссія Дортмунд»' },
  { key: 'e10', name: '«Інтер»' },
  { key: 'e11', name: '«Мілан»' },
  { key: 'e12', name: '«Ювентус»' },
  { key: 'e13', name: '«ПСЖ»' },
  { key: 'e14', name: '«Марсель»' },
  { key: 'e15', name: '«Бенфіка»' },
  { key: 'e16', name: '«Порту»' },
  { key: 'e17', name: '«Аякс»' },
];

const CAREER_ICON_PLAYERS = [
  { key: 'cp_m10', name: 'Ліонель Мессі', baseOvr: 93, startAge: 24 },
  { key: 'cp_cr7', name: 'Кріштіану Роналду', baseOvr: 92, startAge: 23 },
  { key: 'cp_neym', name: 'Неймар', baseOvr: 91, startAge: 22 },
  { key: 'cp_mbap', name: 'Кіліан Мбаппе', baseOvr: 92, startAge: 20 },
  { key: 'cp_haal', name: 'Ерлінг Голанд', baseOvr: 91, startAge: 21 },
  { key: 'cp_benz', name: 'Карім Бензема', baseOvr: 90, startAge: 26 },
  { key: 'cp_lewa', name: 'Роберт Левандовський', baseOvr: 91, startAge: 25 },
  { key: 'cp_salah', name: 'Мохамед Салах', baseOvr: 90, startAge: 25 },
  { key: 'cp_kdb', name: 'Кевін де Брейне', baseOvr: 91, startAge: 26 },
  { key: 'cp_modr', name: 'Лука Модрич', baseOvr: 89, startAge: 28 },
  { key: 'cp_vini', name: 'Вінісіус Жуніор', baseOvr: 90, startAge: 21 },
  { key: 'cp_pedri', name: 'Педрі', baseOvr: 88, startAge: 19 },
  { key: 'cp_belli', name: 'Джуд Беллінгем', baseOvr: 90, startAge: 20 },
  { key: 'cp_kane', name: 'Гаррі Кейн', baseOvr: 90, startAge: 27 },
  { key: 'cp_vvd', name: 'Вірджил ван Дейк', baseOvr: 89, startAge: 27 },
];

function careerProByKey(key) {
  return CAREER_ICON_PLAYERS.find((p) => p.key === key) || null;
}

function pickDistinctCareerPlayersForOffers(n) {
  const shuffled = [...CAREER_ICON_PLAYERS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

function careerClubByKey(key) {
  return PLAYER_CAREER_CLUBS.find((c) => c.key === key) || null;
}

function pickDistinctCareerClubs(n, excludeKeys = []) {
  const pool = PLAYER_CAREER_CLUBS.filter((c) => !excludeKeys.includes(c.key));
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

function pickInitialCareerOffers() {
  return pickDistinctCareerClubs(3).map((c) => ({ clubKey: c.key, clubName: c.name }));
}

function buildCareerContractOffers(pc) {
  const cur = careerClubByKey(pc.clubKey);
  if (!cur) return pickInitialCareerOffers();
  const others = pickDistinctCareerClubs(2, [pc.clubKey]).map((c) => ({
    clubKey: c.key,
    clubName: c.name,
  }));
  const stay = { clubKey: pc.clubKey, clubName: `${cur.name} (продовжити контракт)` };
  return [stay, ...others].sort(() => Math.random() - 0.5);
}

function createPlayerCareerState(season = 1) {
  const picks = pickDistinctCareerPlayersForOffers(3);
  return {
    season,
    phase: 'pick_player',
    playerKey: '',
    playerName: '',
    playerOvr: 0,
    playerAge: 0,
    playerOffers: picks.map((p) => ({
      key: p.key,
      name: p.name,
      baseOvr: p.baseOvr,
      startAge: p.startAge,
    })),
    clubKey: '',
    clubName: '',
    offers: null,
    resultLines: [],
    finalsQueue: [],
    leaguePlace: null,
    cupReachedFinal: false,
    euroReachedFinal: false,
    wcReachedFinal: false,
    cupWon: null,
    euroWon: null,
    wcWon: null,
    careerStats: {
      leagueTitles: 0,
      cupWins: 0,
      euroWins: 0,
      wcWins: 0,
      goldenBalls: 0,
      goldenBoots: 0,
      silverStars: 0,
    },
    careerQuestClaimed: {},
    honorsGrantedSeason: null,
    accumulatedSeason: null,
    careerTripleCrowns: 0,
    triplesRecordedSeason: null,
  };
}

function ensureCareerStats(pc) {
  if (!pc.careerStats) {
    pc.careerStats = {
      leagueTitles: 0,
      cupWins: 0,
      euroWins: 0,
      wcWins: 0,
      goldenBalls: 0,
      goldenBoots: 0,
      silverStars: 0,
    };
  }
  if (!pc.careerQuestClaimed) pc.careerQuestClaimed = {};
  if (pc.careerTripleCrowns == null) pc.careerTripleCrowns = 0;
  if (pc.triplesRecordedSeason === undefined) pc.triplesRecordedSeason = null;
}

/** Додає підсумки щойно завершеного сезону до статистики кар'єри (один раз на сезон). */
function accumulateCareerSeasonStats(pc) {
  ensureCareerStats(pc);
  const s = pc.careerStats;
  if (pc.leaguePlace === 1) s.leagueTitles += 1;
  if (pc.cupWon) s.cupWins += 1;
  if (pc.euroWon) s.euroWins += 1;
  if (pc.wcWon) s.wcWins += 1;
}

function careerQuestIsComplete(pc, qid) {
  ensureCareerStats(pc);
  const s = pc.careerStats;
  switch (qid) {
    case 'cq_wc_win':
      return s.wcWins >= 1;
    case 'cq_league_3':
      return s.leagueTitles >= 3;
    case 'cq_triple_once':
      return (pc.careerTripleCrowns || 0) >= 1;
    case 'cq_golden_3':
      return s.goldenBalls >= 3;
    case 'cq_euro_2':
      return s.euroWins >= 2;
    case 'cq_ovr93':
      return pc.playerOvr >= 93;
    default:
      return false;
  }
}

function careerQuestProgressShort(pc, qid) {
  ensureCareerStats(pc);
  const s = pc.careerStats;
  switch (qid) {
    case 'cq_wc_win':
      return `${Math.min(s.wcWins, 1)}/1`;
    case 'cq_league_3':
      return `${Math.min(s.leagueTitles, 3)}/3`;
    case 'cq_triple_once':
      return `${Math.min(pc.careerTripleCrowns || 0, 1)}/1`;
    case 'cq_golden_3':
      return `${Math.min(s.goldenBalls, 3)}/3`;
    case 'cq_euro_2':
      return `${Math.min(s.euroWins, 2)}/2`;
    case 'cq_ovr93':
      return `${Math.min(pc.playerOvr || 0, 93)}/93`;
    default:
      return '…';
  }
}

/** Нагороджує виконані завдання монетами (грає при переході між сезонами). */
function evaluateNewCareerQuestRewards(userId, pc) {
  ensureCareerStats(pc);
  const mdLines = [];
  const htmlLines = [];
  for (const q of CAREER_QUEST_DEFS) {
    if (pc.careerQuestClaimed[q.id]) continue;
    if (!careerQuestIsComplete(pc, q.id)) continue;
    pc.careerQuestClaimed[q.id] = true;
    addCoins(userId, q.rewardCoins);
    mdLines.push(`• ${q.label} · **+${q.rewardCoins}** 🪙`);
    htmlLines.push(`• ${escapeHtml(q.label)} · +${q.rewardCoins} 🪙`);
  }
  return { mdLines, htmlLines };
}

function formatCareerQuestProgressHtml(pc) {
  ensureCareerStats(pc);
  const lines = [];
  for (const q of CAREER_QUEST_DEFS) {
    if (pc.careerQuestClaimed[q.id]) continue;
    const prog = careerQuestProgressShort(pc, q.id);
    lines.push(`• ${escapeHtml(q.label)} — <i>${escapeHtml(prog)}</i>`);
    if (lines.length >= 5) break;
  }
  if (!lines.length) return '';
  return (
    `<b>🎯 Завдання карʼєри</b> <i>(нагорода — кнопка «Наступний сезон»)</i>\n` +
    `${lines.join('\n')}`
  );
}

/** Особисті нагороди — дуже м’які умови (часті Золотий / Срібний м’яч). */
function maybeAwardSeasonHonors(userId, pc) {
  ensureCareerStats(pc);
  if (pc.honorsGrantedSeason === pc.season) return '';
  const parts = [];
  const s = pc.careerStats;
  const majorWin = pc.cupWon || pc.euroWon || pc.wcWon;
  const majorFinal = pc.cupReachedFinal || pc.euroReachedFinal || pc.wcReachedFinal;
  const lp = pc.leaguePlace;
  const goldenBall =
    majorWin ||
    (typeof lp === 'number' && lp <= 3) ||
    (typeof lp === 'number' && lp <= 5 && majorFinal);
  if (goldenBall) {
    grantTrophy(userId, 'trophy_golden_ball');
    addCoins(userId, 45);
    s.goldenBalls += 1;
    parts.push("🏅 <b>Золотий м'яч</b> сезону — трофей у /sklad · +45 🪙");
  }
  if (pc.wcWon) {
    grantTrophy(userId, 'trophy_golden_boot_career');
    addCoins(userId, 25);
    s.goldenBoots += 1;
    parts.push('👟 <b>Золота бутса</b> (ЧС) · трофей у /sklad · +25 🪙');
  }
  const silverBall =
    !goldenBall &&
    ((typeof lp === 'number' && lp <= 7) || majorFinal || majorWin);
  if (silverBall) {
    grantTrophy(userId, 'trophy_career_silver_ball');
    addCoins(userId, 28);
    s.silverStars += 1;
    parts.push("🥈 <b>Срібний м'яч</b> сезону · трофей у /sklad · +28 🪙");
  }
  if (!parts.length) return '';
  pc.honorsGrantedSeason = pc.season;
  return `\n\n<b>Особисті нагороди</b>\n${parts.join('\n')}`;
}

function buildCareerEndRecapHtml(pc) {
  ensureCareerStats(pc);
  const s = pc.careerStats;
  const nQuest = CAREER_QUEST_DEFS.filter((q) => pc.careerQuestClaimed[q.id]).length;
  const nm = escapeHtml(pc.playerName || 'Гравець');
  return (
    `🌟 <b>Карʼєра завершена!</b> ${nm}\n\n` +
    `📊 <b>Підсумки за 20 сезонів</b>\n` +
    `• Чемпіонств ліги: <b>${s.leagueTitles}</b>\n` +
    `• Кубків країни: <b>${s.cupWins}</b>\n` +
    `• Єврокубків: <b>${s.euroWins}</b>\n` +
    `• Чемпіонатів світу: <b>${s.wcWins}</b>\n` +
    `• Золотих мʼячів: <b>${s.goldenBalls}</b>\n` +
    `• Золотих бутс (ЧС): <b>${s.goldenBoots}</b>\n` +
    `• Срібних мʼячів: <b>${s.silverStars}</b>\n` +
    `• Тройних корон (ліга + кубок + єврокубок): <b>${pc.careerTripleCrowns || 0}</b>\n\n` +
    `⚽ Фінальний профіль: <b>${pc.playerOvr}</b> OVR · <b>${pc.playerAge}</b> років\n` +
    `🎯 Завдань виконано: <b>${nQuest}</b> / ${CAREER_QUEST_DEFS.length}\n\n` +
    `+400 🪙 за завершення карʼєри`
  );
}

function careerFakeScore() {
  let y = Math.floor(Math.random() * 3);
  let t = Math.floor(Math.random() * 3);
  if (Math.random() < 0.22) y += 1;
  if (Math.random() < 0.22) t += 1;
  return `${Math.min(y, 5)}:${Math.min(t, 5)}`;
}

function careerWinProb(pc, stagePenalty) {
  let base = 0.78 - (pc.season - 1) * 0.007 - stagePenalty;
  const ovr = pc.playerOvr || 0;
  if (ovr >= 90) base += 0.052;
  else if (ovr >= 86) base += 0.036;
  else if (ovr >= 82) base += 0.024;
  else if (ovr >= 78) base += 0.012;
  else if (ovr > 0 && ovr < 72) base -= 0.012;
  return Math.max(0.52, Math.min(0.92, base));
}

function runCareerCupBracket(pc, title, roundsBeforeFinal, queueKey, opponentPool = LEAGUE_OPPONENTS) {
  const lines = [];
  const rndLabels = ['1/16', '1/8', '1/4', 'півфінал'];
  for (let i = 0; i < roundsBeforeFinal; i++) {
    const opp = randomPick(opponentPool).name;
    const lbl = rndLabels[i] || `${i + 1}`;
    const win = Math.random() < careerWinProb(pc, i * 0.042);
    lines.push(`${title} (${lbl}): ${win ? '✅' : '✖️'} ${careerFakeScore()} vs ${opp}`);
    if (!win) return { lines, reachedFinal: false };
  }
  const fo = randomPick(opponentPool);
  let strengthBoost = 0;
  if (queueKey === 'euro') strengthBoost = 0.044;
  else if (queueKey === 'wc') strengthBoost = 0.058;
  const strength = Math.min(0.22, 0.052 + (pc.season - 1) * 0.0088 + strengthBoost);
  pc.finalsQueue.push({
    key: queueKey,
    label: title,
    opponent: fo.name,
    strength,
  });
  lines.push(`${title}: 🏁 фінал проти ${fo.name}`);
  return { lines, reachedFinal: true };
}

function finalizeCareerSeasonStats(pc) {
  if (!pc.cupReachedFinal) pc.cupWon = false;
  else if (pc.cupWon == null) pc.cupWon = false;
  if (!pc.euroReachedFinal) pc.euroWon = false;
  else if (pc.euroWon == null) pc.euroWon = false;
  if (!pc.wcReachedFinal) pc.wcWon = false;
  else if (pc.wcWon == null) pc.wcWon = false;
}

/** Один сезон кар'єри: вік +1 і зміна OVR за підсумками (може зрости або впасти). */
function applyCareerSeasonGrowth(pc) {
  if (!pc.playerKey || pc.playerOvr <= 0) return;
  pc.playerAge += 1;
  let d = 0;
  const lp = pc.leaguePlace ?? 6;
  if (lp <= 2) d += 2;
  else if (lp <= 5) d += 1;
  else if (lp >= 9) d -= 1;
  if (pc.cupWon) d += 2;
  else if (pc.cupReachedFinal && pc.cupWon === false) d -= 1;
  if (pc.euroWon) d += 2;
  else if (pc.euroReachedFinal && pc.euroWon === false) d -= 1;
  if (pc.wcWon) d += 3;
  else if (pc.wcReachedFinal && pc.wcWon === false) d -= 1;
  if (pc.playerAge <= 22) d += 1;
  if (pc.playerAge >= 33) d -= 1;
  if (pc.playerAge >= 36) d -= 2;
  if (pc.playerAge >= 38) d -= 1;
  d += Math.floor(Math.random() * 3) - 1;
  pc.playerOvr = Math.max(55, Math.min(99, Math.round(pc.playerOvr + d)));
}

function bumpCareerOvrAfterFinal(pc, win) {
  if (!pc?.playerOvr || pc.playerOvr <= 0) return;
  if (win) pc.playerOvr = Math.min(99, pc.playerOvr + (Math.random() < 0.55 ? 2 : 1));
  else pc.playerOvr = Math.max(55, pc.playerOvr - (Math.random() < 0.65 ? 1 : 0));
}

/** Заповнює чергу фіналів і resultLines; phase → final_pick або season_outro. */
function runCareerSeasonSimulation(pc) {
  pc.finalsQueue = [];
  pc.leaguePlace = null;
  pc.cupReachedFinal = false;
  pc.euroReachedFinal = false;
  pc.wcReachedFinal = false;
  pc.cupWon = null;
  pc.euroWon = null;
  pc.wcWon = null;

  const leagueLines = [];
  let pts = 0;
  for (let t = 0; t < 5; t++) {
    const opp = randomPick(LEAGUE_OPPONENTS).name;
    let winP = 0.78;
    const ovr = pc.playerOvr || 0;
    if (ovr >= 92) winP += 0.085;
    else if (ovr >= 88) winP += 0.065;
    else if (ovr >= 84) winP += 0.048;
    else if (ovr >= 80) winP += 0.03;
    else if (ovr >= 76) winP += 0.014;
    else if (ovr > 0 && ovr < 74) winP -= 0.045;
    winP = Math.max(0.64, Math.min(0.93, winP));
    const drawHi = winP + 0.14;
    const r = Math.random();
    let symbol = 'П';
    if (r < winP) {
      symbol = 'В';
      pts += 3;
    } else if (r < drawHi) {
      symbol = 'Н';
      pts += 1;
    }
    leagueLines.push(`Ліга · тур ${t + 1}: ${symbol} ${careerFakeScore()} vs ${opp}`);
  }
  const place = Math.min(10, Math.max(1, 11 - Math.round(pts / 2.28)));
  pc.leaguePlace = place;
  leagueLines.push(`Ліга · підсумок: ${place} місце · ~${pts} очок`);

  const cup = runCareerCupBracket(pc, 'Кубок країни', 3, 'cup');
  pc.cupReachedFinal = cup.reachedFinal;
  const euro = runCareerCupBracket(pc, 'Єврокубок', 2, 'euro');
  pc.euroReachedFinal = euro.reachedFinal;
  const wc = runCareerCupBracket(pc, 'Чемпіонат світу', 4, 'wc', CAREER_WORLD_OPPONENTS);
  pc.wcReachedFinal = wc.reachedFinal;

  pc.resultLines = [
    `${pc.playerName} · ${pc.playerOvr} OVR · вік ${pc.playerAge}`,
    `Клуб: ${pc.clubName}`,
    '── ЛІГА ──',
    ...leagueLines,
    '── КУБОК ──',
    ...cup.lines,
    '── ЄВРОКУБОК ──',
    ...euro.lines,
    '── ЧЕМПІОНАТ СВІТУ ──',
    ...wc.lines,
  ];

  if (pc.finalsQueue.length > 0) pc.phase = 'final_pick';
  else {
    finalizeCareerSeasonStats(pc);
    pc.phase = 'season_outro';
  }
}

function getCareerMode(userId) {
  return careerModeByUser.get(userId) || 'club';
}

function hasIncompletePlayerCareer(userId) {
  const pc = playerCareerByUser.get(userId);
  return Boolean(pc && pc.season >= 1 && pc.season <= 20);
}

/** Поки йде ліга або кар'єра гравця — недоступні турнір і товариський /fifa. */
function careerBarsTournamentOrFriendly(userId) {
  return hasActiveLeague(userId) || hasIncompletePlayerCareer(userId);
}

function hasActiveLeague(userId) {
  const lg = leagueByUser.get(userId);
  return Boolean(lg && !lg.finished);
}

function createLeagueRows(userId) {
  const u = knownUsersById.get(userId);
  const yourName = (u?.first_name && String(u.first_name).trim()) || 'Твій клуб';
  const rows = [
    { key: 'you', name: yourName, pl: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ];
  for (const o of LEAGUE_OPPONENTS) {
    rows.push({
      key: o.key,
      name: o.name,
      pl: 0,
      w: 0,
      d: 0,
      l: 0,
      gf: 0,
      ga: 0,
      pts: 0,
    });
  }
  return rows;
}

function getLeagueRow(lg, key) {
  return lg.rows.find((r) => r.key === key);
}

function applyLeagueMatchResult(lg, keyA, keyB, goalsA, goalsB) {
  const a = getLeagueRow(lg, keyA);
  const b = getLeagueRow(lg, keyB);
  if (!a || !b) return;
  a.pl += 1;
  b.pl += 1;
  a.gf += goalsA;
  a.ga += goalsB;
  b.gf += goalsB;
  b.ga += goalsA;
  if (goalsA > goalsB) {
    a.w += 1;
    a.pts += 3;
    b.l += 1;
  } else if (goalsB > goalsA) {
    b.w += 1;
    b.pts += 3;
    a.l += 1;
  } else {
    a.d += 1;
    b.d += 1;
    a.pts += 1;
    b.pts += 1;
  }
}

/** Чотири матчі між іншими ботами (без твого суперника цього туру). */
function simulateLeagueParallelMatch(lg, roundIdx) {
  const oppKey = LEAGUE_OPPONENTS[roundIdx].key;
  const others = LEAGUE_OPPONENTS.map((o) => o.key).filter((k) => k !== oppKey);
  const shuffled = [...others].sort(() => Math.random() - 0.5);
  for (let i = 0; i + 1 < shuffled.length; i += 2) {
    let ga = Math.floor(Math.random() * 3);
    let gb = Math.floor(Math.random() * 3);
    if (Math.random() < 0.16) ga += 1;
    if (Math.random() < 0.16) gb += 1;
    applyLeagueMatchResult(lg, shuffled[i], shuffled[i + 1], ga, gb);
  }
}

function sortLeagueRows(rows) {
  return [...rows].sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    const gda = a.gf - a.ga;
    const gdb = b.gf - b.ga;
    if (gdb !== gda) return gdb - gda;
    return b.gf - a.gf;
  });
}

function formatLeagueTableHtml(lg) {
  const sorted = sortLeagueRows(lg.rows);
  const lines = [
    '<b>📊 Турнірна таблиця</b> · 10 команд, 9 турів',
    '<pre>',
    '#  Команда         М  В Н П  З:П  О',
    '—  —————————————  —  — — —  ———  —',
  ];
  let rank = 0;
  for (const r of sorted) {
    rank += 1;
    const nm = escapeHtml(r.name).slice(0, 14).padEnd(14, ' ');
    lines.push(
      `${rank}  ${nm}  ${r.pl}  ${r.w} ${r.d} ${r.l}  ${String(r.gf).padStart(2)}:${String(r.ga).padStart(2)}  ${r.pts}`
    );
  }
  lines.push('</pre><i>М — матчі, В/Н/П, З:П — голи, О — очки (3/1/0).</i>');
  return lines.join('\n');
}

/**
 * Турніри: кожен етап — один матч; strength зростає → бот сильніший (пороги в resolveTurn).
 * finalBonus — монети за перемогу у фіналі.
 */
const TOURNAMENT_DEFS = [
  {
    id: 'cup_city',
    name: 'Кубок міста',
    emoji: '🏙',
    stages: [
      { label: '1/4', opponent: 'ФК «Район»', strength: 0 },
      { label: '1/2', opponent: '«Оболонь-2»', strength: 0.055 },
      { label: 'Фінал', opponent: '«Динамо» (молодь)', strength: 0.11 },
    ],
    finalBonus: 95,
  },
  {
    id: 'cup_nation',
    name: 'Кубок країни',
    emoji: '🏆',
    stages: [
      { label: '1/8', opponent: 'Середняк ліги', strength: 0.02 },
      { label: '1/4', opponent: 'Топ-8', strength: 0.065 },
      { label: '1/2', opponent: 'Півфіналіст', strength: 0.11 },
      { label: 'Фінал', opponent: 'Чемпіон минулого року', strength: 0.16 },
    ],
    finalBonus: 185,
  },
  {
    id: 'ucl_style',
    name: 'Ліга чемпіонів',
    emoji: '⭐',
    stages: [
      { label: '1/16', opponent: 'Аутсайдер групи', strength: 0.03 },
      { label: '1/8', opponent: 'Стабільний клуб', strength: 0.07 },
      { label: '1/4', opponent: 'Гранд', strength: 0.12 },
      { label: '1/2', opponent: 'Фаворит турніру', strength: 0.165 },
      { label: 'Фінал', opponent: 'Топ Європи', strength: 0.22 },
    ],
    finalBonus: 320,
  },
];

const SHOP_ITEMS = [
  { id: 'sticker', name: 'Наліпка клубу', price: 12, note: 'колекційний дрібничок' },
  { id: 'bracelet', name: 'Фан-браслет', price: 20, note: 'настрій +100 (майже)' },
  { id: 'scarf', name: 'Шарф уболівальника', price: 35, note: 'тепло на трибунах' },
];

/** Кубки / медалі — лічаться в inventory, показ у /sklad у блоці «Трофеї». */
const TROPHY_ITEMS = [
  { id: 'trophy_cup_city', name: 'Кубок міста', emoji: '🏙' },
  { id: 'trophy_cup_nation', name: 'Кубок країни', emoji: '🏆' },
  { id: 'trophy_ucl', name: 'Ліга чемпіонів', emoji: '⭐' },
  { id: 'trophy_league_gold', name: 'Чемпіонат — золото', emoji: '🥇' },
  { id: 'trophy_league_silver', name: 'Чемпіонат — срібло', emoji: '🥈' },
  { id: 'trophy_league_bronze', name: 'Чемпіонат — бронза', emoji: '🥉' },
  { id: 'trophy_player_career', name: "Кар'єра гравця — 20 сезонів", emoji: '🌟' },
  { id: 'trophy_golden_ball', name: "Золотий м'яч (кар'єра)", emoji: '🏅' },
  { id: 'trophy_golden_boot_career', name: 'Золота бутса (ЧС)', emoji: '👟' },
  { id: 'trophy_career_silver_ball', name: "Срібний м'яч (кар'єра)", emoji: '🥈' },
];

/** Гравці в магазині (кожного можна мати лише одного у складі). */
/** Всесвітньо відомі гравці (умовні OVR як у симуляторів). */
const SHOP_PLAYERS_STARS = [
  { id: 'pl_star_messi', name: 'Ліонель Месі (НП)', rating: 93, price: 500, note: 'баланс, удар, пас' },
  { id: 'pl_star_ronaldo', name: 'Кріштіану Роналду (НП)', rating: 91, price: 460, note: 'фізика, голови, пенальті' },
  { id: 'pl_star_mbappe', name: 'Кіліан Мбаппе (НП)', rating: 92, price: 495, note: 'швидкість, завершення' },
  { id: 'pl_star_haaland', name: 'Ерлінг Голанд (НП)', rating: 92, price: 485, note: 'сила, завершення в штрафному' },
  { id: 'pl_star_benzema', name: 'Карім Бензема (НП)', rating: 90, price: 425, note: 'лінк-гра, клініка' },
  { id: 'pl_star_lewa', name: 'Роберт Левандовський (НП)', rating: 90, price: 418, note: 'позиція, удар' },
  { id: 'pl_star_salah', name: 'Мохамед Салах (НП)', rating: 89, price: 395, note: 'лівий фланг, обведення' },
  { id: 'pl_star_vini', name: 'Вінісіус Жуніор (НП)', rating: 90, price: 408, note: 'дриблінг, темп' },
  { id: 'pl_star_kane', name: 'Гаррі Кейн (НП)', rating: 90, price: 402, note: 'пас останнього, удар' },
  { id: 'pl_star_debruyne', name: 'Кевін де Брейне (ПЗ)', rating: 91, price: 445, note: 'паси, стандарти' },
  { id: 'pl_star_modric', name: 'Лука Модрич (ПЗ)', rating: 88, price: 365, note: 'контроль, досвід' },
  { id: 'pl_star_bellingham', name: 'Джуд Беллінгем (ПЗ)', rating: 90, price: 432, note: 'вриви, гол з другого плану' },
  { id: 'pl_star_pedri', name: 'Педрі (ПЗ)', rating: 88, price: 375, note: 'техніка, пресинг' },
  { id: 'pl_star_vvd', name: 'Вірджил ван Дейк (ЗХ)', rating: 89, price: 388, note: 'відбір, гра в повітрі' },
  { id: 'pl_star_ramos', name: 'Серхіо Рамос (ЗХ)', rating: 85, price: 288, note: 'характер, стандарти' },
  { id: 'pl_star_alaba', name: 'Давід Алаба (ЗХ)', rating: 86, price: 312, note: 'універсал лінії' },
  { id: 'pl_star_neuer', name: 'Мануель Нойєр (ВР)', rating: 88, price: 350, note: 'свіпер-кіпер' },
  { id: 'pl_star_courtois', name: 'Тібо Куртуа (ВР)', rating: 90, price: 380, note: 'реакція, ріст' },
  { id: 'pl_star_alisson', name: 'Аліссон (ВР)', rating: 89, price: 370, note: 'виходи 1в1' },
];

const SHOP_PLAYERS_LOCAL = [
  { id: 'pl_gk1', name: 'Орест Мазурак (ВР)', rating: 77, price: 72, note: 'надійні руки' },
  { id: 'pl_df1', name: 'Тарас Мельник (ЗХ)', rating: 79, price: 92, note: 'жорсткий у відборі' },
  { id: 'pl_df2', name: 'Богдан Савченко (ЗХ)', rating: 81, price: 115, note: 'високий пресинг' },
  { id: 'pl_mid1', name: 'Марко Коваленко (ПЗ)', rating: 82, price: 140, note: 'роздає паси' },
  { id: 'pl_mid2', name: 'Данило Романюк (ПЗ)', rating: 84, price: 170, note: 'дальні удари' },
  { id: 'pl_fwd1', name: 'Андрій Лисенко (НП)', rating: 83, price: 160, note: 'швидкий врив' },
  { id: 'pl_fwd2', name: 'Олег Шевченко (НП)', rating: 86, price: 218, note: 'клінічний фініш' },
];

const SHOP_PLAYERS = [...SHOP_PLAYERS_STARS, ...SHOP_PLAYERS_LOCAL];

/** Паки: один випадковий гравець з каталогу (лише ті, кого ще немає у складі). */
const SHOP_PACKS = [
  { id: 'pack_bronze', name: 'Бронзовий пак', price: 195 },
  { id: 'pack_silver', name: 'Срібний пак', price: 460 },
  { id: 'pack_gold', name: 'Золотий пак', price: 890 },
];

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getUnownedShopPlayerIds(userId) {
  const w = getWallet(userId);
  const owned = new Set(Object.keys(w.squad || {}).filter((id) => (w.squad[id] || 0) > 0));
  return SHOP_PLAYERS.map((p) => p.id).filter((id) => !owned.has(id));
}

function pickRandomPackPlayerId(packId, userId) {
  const cand = getUnownedShopPlayerIds(userId);
  if (!cand.length) return null;
  const isStar = (id) => SHOP_PLAYERS_STARS.some((p) => p.id === id);
  const entries = cand.map((id) => {
    let wgt = 1;
    if (packId === 'pack_bronze') wgt = isStar(id) ? 1 : 9;
    else if (packId === 'pack_silver') wgt = isStar(id) ? 5 : 6;
    else wgt = isStar(id) ? 11 : 3;
    return { id, wgt };
  });
  const sum = entries.reduce((s, e) => s + e.wgt, 0);
  let r = Math.random() * sum;
  for (const e of entries) {
    r -= e.wgt;
    if (r <= 0) return e.id;
  }
  return entries[entries.length - 1].id;
}

async function playPackOpeningAnimation(telegram, chatId, messageId, teaserNames, wonMeta) {
  const icons = ['📦', '✨', '🎴', '🎲', '⚽', '💫', '⭐', '🏆'];
  const pool = teaserNames.length ? teaserNames : ['…'];
  for (let step = 0; step < 8; step++) {
    const icon = icons[Math.min(step, icons.length - 1)];
    const flash = pool[Math.floor(Math.random() * pool.length)];
    const text = `<b>${icon} Відкриття паку…</b>\n<code>${escapeHtml(flash)}</code>`;
    try {
      await telegram.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
      });
    } catch {
      /* ignore */
    }
    await sleepMs(200 + step * 28);
  }
  const finalText = `<b>✅ Випало:</b>\n<b>${escapeHtml(wonMeta.name)}</b> · ${wonMeta.rating} OVR`;
  try {
    await telegram.editMessageText(finalText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
    });
  } catch {
    await telegram.sendMessage(chatId, finalText, { parse_mode: 'HTML' });
  }
}

const MAX_TURNS = 15;
const MINUTES_PER_TURN = 15;
const REGULATION_PENALTIES = 5;
const REGULATION_KICKS = REGULATION_PENALTIES * 2;

function getWallet(userId) {
  if (!userWallet.has(userId)) {
    userWallet.set(userId, { coins: 30, inventory: {}, squad: {} });
  }
  const w = userWallet.get(userId);
  if (!w.squad) w.squad = {};
  return w;
}

function addCoins(userId, delta) {
  const w = getWallet(userId);
  w.coins = Math.max(0, w.coins + delta);
}

/** Щоденна цепочка: нескінченна серія; у панелі — лише 3 наступні дні; пропуск скидає на день 1. */
/** @type {Map<number, { step: number, lastClaimKey: string | null }>} */
const loginChainByUser = new Map();

const LOGIN_CHAIN_BASE = [25, 45, 80];
const LOGIN_CHAIN_PREVIEW_DAYS = 3;

/** Нагорода для N-го дня серії (цикл 25/45/80 + бонус кожні 3 дні). */
function loginChainRewardForDay(dayNum) {
  const n = Math.max(1, Math.floor(dayNum));
  const idx = (n - 1) % LOGIN_CHAIN_BASE.length;
  const tier = Math.floor((n - 1) / LOGIN_CHAIN_BASE.length);
  return LOGIN_CHAIN_BASE[idx] + tier * 20;
}

function calendarDateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function yesterdayDateKey() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return calendarDateKey(d);
}

/** Каталог цепочок: id = назва для /can (daily, vip, …). */
const CHAIN_DEFS = {
  daily: {
    id: 'daily',
    title: 'Щоденна цепочка',
    emoji: '🔗',
    access: 'public',
  },
  vip: {
    id: 'vip',
    title: 'VIP-цепочка',
    emoji: '👑',
    access: 'restricted',
  },
};

const CHAIN_ORDER = ['daily', 'vip'];

/** Дозволи на закриті цепочки (видає /can). */
/** @type {Map<number, Set<string>>} */
const chainGrantsByUser = new Map();

function normalizeChainSlug(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function resolveChainId(name) {
  const slug = normalizeChainSlug(name);
  if (CHAIN_DEFS[slug]) return slug;
  const aliases = { щоденна: 'daily', daily_chain: 'daily', віп: 'vip', vip_chain: 'vip' };
  if (aliases[slug]) return aliases[slug];
  return null;
}

function getChainDef(chainId) {
  const id = resolveChainId(chainId) || chainId;
  return CHAIN_DEFS[id] || null;
}

function canUserClaimChain(userId, chainId) {
  const id = resolveChainId(chainId) || chainId;
  const def = CHAIN_DEFS[id];
  if (!def) return false;
  if (def.access === 'public') return true;
  if (isAdminUserId(userId)) return true;
  const grants = chainGrantsByUser.get(userId);
  return Boolean(grants && grants.has(id));
}

function grantChainAccess(userId, chainId) {
  const id = resolveChainId(chainId);
  if (!id) return { ok: false, err: 'unknown_chain' };
  const def = CHAIN_DEFS[id];
  if (def.access === 'public') return { ok: false, err: 'already_public', chainId: id, title: def.title };
  if (!chainGrantsByUser.has(userId)) chainGrantsByUser.set(userId, new Set());
  chainGrantsByUser.get(userId).add(id);
  return { ok: true, chainId: id, title: def.title };
}

function listChainsHelpHtml() {
  return CHAIN_ORDER.map((id) => {
    const d = CHAIN_DEFS[id];
    const acc = d.access === 'public' ? 'відкрита' : 'закрита';
    return `• <code>${id}</code> — ${d.title} (${acc})`;
  }).join('\n');
}

function getLoginChainState(userId) {
  if (!loginChainByUser.has(userId)) {
    loginChainByUser.set(userId, { step: 0, lastClaimKey: null });
  }
  const st = loginChainByUser.get(userId);
  if (st.step == null || st.step < 0) st.step = 0;
  return st;
}

/** Номер дня, який можна (або буде) забрати наступним. */
function loginChainNextClaimDay(userId) {
  const st = getLoginChainState(userId);
  const today = calendarDateKey();
  const yesterday = yesterdayDateKey();
  if (st.lastClaimKey === today) return st.step + 1;
  if (st.lastClaimKey == null) return 1;
  if (st.lastClaimKey === yesterday) return st.step + 1;
  return 1;
}

function loginChainProgressVisual(userId) {
  const st = getLoginChainState(userId);
  const claimedToday = st.lastClaimKey === calendarDateKey();
  const startDay = loginChainNextClaimDay(userId);

  const lines = [];
  for (let i = 0; i < LOGIN_CHAIN_PREVIEW_DAYS; i += 1) {
    const dayNum = startDay + i;
    const coins = loginChainRewardForDay(dayNum);
    let mark = '⬜';
    if (i === 0 && !claimedToday) mark = '🎁';
    else if (i === 0 && claimedToday) mark = '⏭';
    lines.push(`${mark} <b>День ${dayNum}</b> — +${coins} 🪙`);
  }
  return lines.join('\n');
}

function loginChainStatusLine(userId) {
  const st = getLoginChainState(userId);
  const today = calendarDateKey();
  const yesterday = yesterdayDateKey();
  const streakLine = st.step > 0 ? `Поточна серія: <b>${st.step}</b> дн. поспіль.` : '';

  if (st.lastClaimKey === today) {
    const next = st.step + 1;
    const nextCoins = loginChainRewardForDay(next);
    return (
      `${streakLine}\n` +
      `Сьогодні забрано <b>день ${st.step}</b>. Завтра — <b>день ${next}</b> (+${nextCoins} 🪙).`
    ).trim();
  }
  if (st.step === 0 || st.lastClaimKey == null) {
    return 'Серія не розпочата — натисни «Забрати нагороду» для <b>дня 1</b>.';
  }
  if (st.lastClaimKey === yesterday) {
    const next = st.step + 1;
    const coins = loginChainRewardForDay(next);
    return (
      `${streakLine}\n` +
      `Сьогодні можна забрати <b>день ${next}</b> (+${coins} 🪙).`
    ).trim();
  }
  return 'Пропущено день — серія скинулась. Сьогодні знову <b>день 1</b>.';
}

function tryClaimLoginChain(userId) {
  getWallet(userId);
  const st = getLoginChainState(userId);
  const today = calendarDateKey();
  const yesterday = yesterdayDateKey();

  if (st.lastClaimKey === today) {
    return { ok: false, reason: 'already', step: st.step };
  }

  let reset = false;
  if (st.lastClaimKey == null) {
    st.step = 1;
  } else if (st.lastClaimKey === yesterday) {
    st.step += 1;
  } else {
    reset = true;
    st.step = 1;
  }

  const coins = loginChainRewardForDay(st.step);
  addCoins(userId, coins);
  st.lastClaimKey = today;

  return {
    ok: true,
    reset,
    day: st.step,
    coins,
    step: st.step,
  };
}

async function showLoginChainPanel(ctx) {
  const uid = ctx.from.id;
  getWallet(uid);
  let body =
    '<b>🔗 Цепочки нагород</b>\n\n' +
    '<i>Кожна цепочка має <b>назву</b> (daily, vip…). Заходь щодня — серія без кінця; пропуск = день 1. Нижче — 3 наступні дні.</i>\n';
  for (let i = 0; i < CHAIN_ORDER.length; i += 1) {
    const chainId = CHAIN_ORDER[i];
    if (i > 0) body += '\n— — —\n\n';
    body += formatChainSectionHtml(uid, chainId);
  }
  const boostLine = adminBoostRemainingText(uid);
  if (boostLine) body += `\n\n${boostLine}`;
  body += `\n\nБаланс: <b>${getWallet(uid).coins}</b> 🪙`;
  await ctx.reply(body, { parse_mode: 'HTML', ...chainPanelKeyboard(uid) });
}

function formatChainSectionHtml(userId, chainId) {
  const def = CHAIN_DEFS[chainId];
  if (!def) return '';
  let accessLine = '';
  if (def.access === 'restricted') {
    accessLine = canUserClaimChain(userId, chainId)
      ? ' <i>(доступ відкрито)</i>'
      : ' 🔒 <i>(закрито — попроси власника: /can)</i>';
  }
  const visual = chainId === 'daily' ? loginChainProgressVisual(userId) : vipChainProgressVisual(userId);
  const status = chainId === 'daily' ? loginChainStatusLine(userId) : vipChainStatusLine(userId);
  const intro =
    chainId === 'daily'
      ? 'Монети щодня — чим довша серія, тим більше.'
      : 'Окрема серія: гравець · монети · VIP-режим 15 хв.';
  return (
    `${def.emoji} <b>${def.title}</b> <code>${def.id}</code>${accessLine}\n` +
    `<i>${intro}</i>\n\n${visual}\n\n${status}`
  );
}

/** VIP-цепочка: окрема серія, видима всім; claim — admin або /can vip. */
/** @type {Map<number, { step: number, lastClaimKey: string | null }>} */
const vipChainByUser = new Map();

/** Тимчасовий супер-бонус у матчах після VIP-нагороди (15 хв). */
/** @type {Map<number, number>} */
const adminMatchBoostByUser = new Map();

const VIP_CHAIN_REWARD_CYCLE = [
  { kind: 'player', label: '⭐ Новий гравець', preview: 'випадкова зірка у склад' },
  { kind: 'coins', coins: 1500, label: '💰 1500 монет', preview: '+1500 🪙' },
  { kind: 'admin_boost', minutes: 15, label: '🛡 VIP-режим 15 хв', preview: 'дуже легкі матчі 15 хв' },
];

function vipChainRewardForDay(dayNum) {
  const n = Math.max(1, Math.floor(dayNum));
  return VIP_CHAIN_REWARD_CYCLE[(n - 1) % VIP_CHAIN_REWARD_CYCLE.length];
}

function getVipChainState(userId) {
  if (!vipChainByUser.has(userId)) {
    vipChainByUser.set(userId, { step: 0, lastClaimKey: null });
  }
  const st = vipChainByUser.get(userId);
  if (st.step == null || st.step < 0) st.step = 0;
  return st;
}

function vipChainNextClaimDay(userId) {
  const st = getVipChainState(userId);
  const today = calendarDateKey();
  const yesterday = yesterdayDateKey();
  if (st.lastClaimKey === today) return st.step + 1;
  if (st.lastClaimKey == null) return 1;
  if (st.lastClaimKey === yesterday) return st.step + 1;
  return 1;
}

function vipChainProgressVisual(userId) {
  const st = getVipChainState(userId);
  const claimedToday = st.lastClaimKey === calendarDateKey();
  const startDay = vipChainNextClaimDay(userId);
  const lines = [];
  for (let i = 0; i < LOGIN_CHAIN_PREVIEW_DAYS; i += 1) {
    const dayNum = startDay + i;
    const reward = vipChainRewardForDay(dayNum);
    let mark = '⬜';
    if (i === 0 && !claimedToday) mark = canUserClaimChain(userId, 'vip') ? '🎁' : '🔒';
    else if (i === 0 && claimedToday) mark = '⏭';
    lines.push(`${mark} <b>День ${dayNum}</b> — ${reward.label} <i>(${reward.preview})</i>`);
  }
  return lines.join('\n');
}

function vipChainStatusLine(userId) {
  const st = getVipChainState(userId);
  const today = calendarDateKey();
  const yesterday = yesterdayDateKey();
  if (!canUserClaimChain(userId, 'vip')) {
    return '<i>Закрито. Доступ — власник бота або команда /can від нього.</i>';
  }
  const streakLine = st.step > 0 ? `VIP-серія: <b>${st.step}</b> дн.` : '';
  if (st.lastClaimKey === today) {
    const next = st.step + 1;
    const reward = vipChainRewardForDay(next);
    return `${streakLine}\nСьогодні VIP забрано (<b>день ${st.step}</b>). Завтра — <b>${reward.label}</b>.`.trim();
  }
  if (st.step === 0 || st.lastClaimKey == null) {
    return 'VIP-серія не розпочата — «👑 VIP нагорода».';
  }
  if (st.lastClaimKey === yesterday) {
    const next = st.step + 1;
    const reward = vipChainRewardForDay(next);
    return `${streakLine}\nСьогодні VIP: <b>${reward.label}</b>.`.trim();
  }
  return 'VIP: пропущено день — знову з <b>дня 1</b>.';
}

function adminMatchBoostActive(userId) {
  const exp = adminMatchBoostByUser.get(userId);
  if (!exp) return false;
  if (Date.now() >= exp) {
    adminMatchBoostByUser.delete(userId);
    return false;
  }
  return true;
}

function adminBoostRemainingText(userId) {
  const exp = adminMatchBoostByUser.get(userId);
  if (!exp || Date.now() >= exp) return null;
  const min = Math.max(1, Math.ceil((exp - Date.now()) / 60000));
  return `<b>🛡 VIP-режим</b> активний ще ~<b>${min}</b> хв — матчі проти бота набагато легші.`;
}

function pickVipChainPlayerId(userId) {
  const unowned = getUnownedShopPlayerIds(userId);
  if (!unowned.length) return null;
  const stars = unowned.filter((id) => SHOP_PLAYERS_STARS.some((p) => p.id === id));
  const pool = stars.length ? stars : unowned;
  return pool[Math.floor(Math.random() * pool.length)];
}

function applyVipChainReward(userId, dayNum) {
  const reward = vipChainRewardForDay(dayNum);
  if (reward.kind === 'coins') {
    addCoins(userId, reward.coins);
    return { kind: 'coins', text: `+<b>${reward.coins}</b> 🪙`, label: reward.label };
  }
  if (reward.kind === 'player') {
    const pid = pickVipChainPlayerId(userId);
    if (!pid) {
      const fallback = 600;
      addCoins(userId, fallback);
      return {
        kind: 'coins',
        text: `Усі гравці вже є — компенсація <b>+${fallback}</b> 🪙`,
        label: reward.label,
      };
    }
    addPlayerToSquad(userId, pid);
    const meta = getPlayerMeta(pid);
    return {
      kind: 'player',
      text: `<b>${escapeHtml(meta.name)}</b> · ${meta.rating} OVR у склад`,
      label: reward.label,
    };
  }
  if (reward.kind === 'admin_boost') {
    const ms = (reward.minutes || 15) * 60 * 1000;
    adminMatchBoostByUser.set(userId, Date.now() + ms);
    return {
      kind: 'admin_boost',
      text: `<b>VIP-режим ${reward.minutes} хв</b> — суперлегкі матчі та турніри`,
      label: reward.label,
    };
  }
  return { kind: 'unknown', text: 'нагорода', label: '?' };
}

function tryClaimVipChain(userId) {
  if (!canUserClaimChain(userId, 'vip')) {
    return { ok: false, reason: 'locked' };
  }
  getWallet(userId);
  const st = getVipChainState(userId);
  const today = calendarDateKey();
  const yesterday = yesterdayDateKey();
  if (st.lastClaimKey === today) {
    return { ok: false, reason: 'already', step: st.step };
  }
  let reset = false;
  if (st.lastClaimKey == null) {
    st.step = 1;
  } else if (st.lastClaimKey === yesterday) {
    st.step += 1;
  } else {
    reset = true;
    st.step = 1;
  }
  const applied = applyVipChainReward(userId, st.step);
  st.lastClaimKey = today;
  return {
    ok: true,
    reset,
    day: st.step,
    step: st.step,
    applied,
  };
}

function chainPanelKeyboard(userId) {
  const today = calendarDateKey();
  const rows = [];
  for (const chainId of CHAIN_ORDER) {
    const def = CHAIN_DEFS[chainId];
    const st = chainId === 'daily' ? getLoginChainState(userId) : getVipChainState(userId);
    const claimedToday = st.lastClaimKey === today;
    if (chainId === 'daily') {
      if (!claimedToday) {
        rows.push([Markup.button.callback(`🎁 ${def.title}`, 'chain:claim:daily')]);
      }
      continue;
    }
    if (canUserClaimChain(userId, chainId)) {
      if (!claimedToday) {
        rows.push([Markup.button.callback(`${def.emoji} ${def.title}`, `chain:claim:${chainId}`)]);
      }
    } else {
      rows.push([Markup.button.callback(`🔒 ${def.title}`, `chain:locked:${chainId}`)]);
    }
  }
  rows.push([Markup.button.callback('🔙 Закрити', 'chain:close')]);
  return Markup.inlineKeyboard(rows);
}

function loginChainKeyboard(userId) {
  return chainPanelKeyboard(userId);
}

async function handleChainClaim(ctx, chainName) {
  const uid = ctx.from.id;
  const chainId = resolveChainId(chainName);
  if (!chainId) {
    await ctx.reply('Невідома цепочка. Доступні: daily, vip.');
    return;
  }
  if (!canUserClaimChain(uid, chainId)) {
    const def = CHAIN_DEFS[chainId];
    await ctx.reply(
      `🔒 Цепочка <b>${def.title}</b> (<code>${chainId}</code>) закрита. Попроси власника: <code>/can @username ${chainId}</code>.`,
      { parse_mode: 'HTML', ...chainPanelKeyboard(uid) }
    );
    return;
  }
  const result = chainId === 'daily' ? tryClaimLoginChain(uid) : tryClaimVipChain(uid);
  if (!result.ok) {
    if (result.reason === 'already') {
      const def = CHAIN_DEFS[chainId];
      await ctx.reply(`Нагороду «${def.title}» сьогодні вже забрано. Завтра — наступний день.`, {
        parse_mode: 'HTML',
        ...chainPanelKeyboard(uid),
      });
    }
    return;
  }
  let extra = '';
  if (result.reset) extra = '\n<i>Серію перервано — знову з дня 1.</i>';
  if (chainId === 'daily') {
    await ctx.reply(
      `<b>🎁 ${CHAIN_DEFS.daily.title} · день ${result.day}:</b> +<b>${result.coins}</b> 🪙${extra}\n` +
        `Серія: <b>${result.step}</b> дн. · баланс: <b>${getWallet(uid).coins}</b> 🪙`,
      { parse_mode: 'HTML', ...chainPanelKeyboard(uid) }
    );
    return;
  }
  await ctx.reply(
    `<b>${CHAIN_DEFS.vip.emoji} ${CHAIN_DEFS.vip.title} · день ${result.day}:</b> ${result.applied.label}\n${result.applied.text}${extra}\n` +
      `VIP-серія: <b>${result.step}</b> дн. · баланс: <b>${getWallet(uid).coins}</b> 🪙`,
    { parse_mode: 'HTML', ...chainPanelKeyboard(uid) }
  );
}

function addInventory(userId, itemId, qty = 1) {
  const w = getWallet(userId);
  w.inventory[itemId] = (w.inventory[itemId] || 0) + qty;
}

function trophyIdForTournamentDefId(defId) {
  if (defId === 'cup_city') return 'trophy_cup_city';
  if (defId === 'cup_nation') return 'trophy_cup_nation';
  if (defId === 'ucl_style') return 'trophy_ucl';
  return null;
}

function grantTrophy(userId, trophyId) {
  if (!TROPHY_ITEMS.some((t) => t.id === trophyId)) return false;
  addInventory(userId, trophyId, 1);
  return true;
}

function trophyLabelById(id) {
  const t = TROPHY_ITEMS.find((x) => x.id === id);
  return t ? `${t.emoji} ${t.name}` : id;
}

function addPlayerToSquad(userId, playerId) {
  const w = getWallet(userId);
  w.squad[playerId] = 1;
}

function removePlayerFromSquad(userId, playerId) {
  const w = getWallet(userId);
  if (w.squad && w.squad[playerId]) delete w.squad[playerId];
}

function hasPlayer(userId, playerId) {
  return Boolean(getWallet(userId).squad[playerId]);
}

function getPlayerMeta(playerId) {
  return SHOP_PLAYERS.find((p) => p.id === playerId);
}

/** Середній OVR гравців у складі (0 — немає карток у магазинному каталозі). */
function averageSquadOvr(userId) {
  const w = getWallet(userId);
  const ids = Object.keys(w.squad || {}).filter((id) => (w.squad[id] || 0) > 0);
  if (!ids.length) return 0;
  let sum = 0;
  let c = 0;
  for (const id of ids) {
    const m = getPlayerMeta(id);
    if (m) {
      sum += m.rating;
      c += 1;
    }
  }
  return c ? sum / c : 0;
}

/**
 * 0…~0.11 — чим вищий середній OVR складу, тим сильніше зменшується «сила бота» у матчі
 * (рідше їхні голи / контри, трохи легше забивати). У PvP кожен грає зі своїм складом на своєму ході.
 */
function squadEaseStrength(userId) {
  const avg = averageSquadOvr(userId);
  if (avg <= 0) return 0;
  return Math.min(0.11, Math.max(0, (avg - 74) * 0.0055));
}

/** Для кар'єри гравця OVR легенди теж полегшує матч проти бота (як склад). */
function careerProEaseFromCareer(userId) {
  const pc = playerCareerByUser.get(userId);
  const ovr = pc?.playerOvr;
  if (ovr == null || ovr <= 0) return 0;
  return Math.min(0.11, Math.max(0, (ovr - 74) * 0.0055));
}

function getCoachState(userId) {
  if (!coachStateByUser.has(userId)) {
    coachStateByUser.set(userId, {
      tactic: 'balance',
      morale: 72,
      fatigue: 0,
      drillKind: null,
      drillMatchesLeft: 0,
      subsFresh: true,
    });
  }
  const c = coachStateByUser.get(userId);
  if (c.drillMatchesLeft == null || c.drillMatchesLeft < 0) c.drillMatchesLeft = 0;
  if (!Object.prototype.hasOwnProperty.call(c, 'drillKind')) c.drillKind = null;
  if (!coachDrillKindValid(c.drillKind)) {
    c.drillKind = null;
    c.drillMatchesLeft = 0;
  }
  if (c.subsFresh === undefined) c.subsFresh = true;
  return c;
}

function coachDrillEaseBonus(c) {
  if (!c.drillMatchesLeft || c.drillMatchesLeft <= 0 || !c.drillKind) return 0;
  if (COACH_DRILL_STRONG.has(c.drillKind)) return 0.012;
  if (COACH_DRILL_WEAK.has(c.drillKind)) return 0.009;
  return 0;
}

function coachActiveDrillHtml(c) {
  if (!c.drillMatchesLeft || c.drillMatchesLeft <= 0 || !c.drillKind) return '';
  const labels = {
    tactical: 'розстановка й модель гри',
    pressing: 'пресинг і відбір',
    setpieces: 'стандарти (подачі, штрафні)',
    technical: 'техніка м’яча',
    passes: 'паси й комбінації',
    finishing: 'удари й завершення атак',
  };
  const lab = labels[c.drillKind] || 'тренування';
  return `\n<b>Активне тренування:</b> ${lab} · ще <b>${c.drillMatchesLeft}</b> матч(ів) бонусу.`;
}

/** Додаткова «легкість» матчу для режиму тренера (resolveTurn обмежує сумарний ease). */
function coachEaseFromState(userId) {
  const c = getCoachState(userId);
  let x = 0.014;
  if (c.tactic === 'attack') x = 0.024;
  else if (c.tactic === 'defense') x = 0.019;
  x += (c.morale - 72) * 0.00045;
  x -= c.fatigue * 0.0022;
  x += coachDrillEaseBonus(c);
  return Math.max(0, Math.min(0.048, x));
}

function bumpCoachAfterMatch(userId, you, them) {
  if (getCareerMode(userId) !== 'coach') return;
  const c = getCoachState(userId);
  c.fatigue = Math.min(22, c.fatigue + 1);
  if (you > them) c.morale = Math.min(100, c.morale + 6);
  else if (them > you) c.morale = Math.max(42, c.morale - 7);
  else c.morale = Math.min(100, c.morale + 2);
  if (c.drillMatchesLeft > 0) {
    c.drillMatchesLeft -= 1;
    if (c.drillMatchesLeft <= 0) {
      c.drillMatchesLeft = 0;
      c.drillKind = null;
    }
  }
  c.subsFresh = true;
}

function matchEaseCombined(userId) {
  let ease = Math.max(squadEaseStrength(userId), careerProEaseFromCareer(userId));
  if (getCareerMode(userId) === 'coach') ease += coachEaseFromState(userId);
  if (getCareerMode(userId) === 'agent') ease += agentEaseFromState(userId);
  if (adminMatchBoostActive(userId)) ease += 0.095;
  return ease;
}

/** Головний екран офісу: матч або тренування. */
function coachOfficeRootKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⚽ Підготовка до матчу', 'coach:hub:match')],
    [Markup.button.callback('🏋️ Тренування (паси, удари…)', 'coach:hub:train')],
    [Markup.button.callback('🔙 Закрити', 'coach:close')],
  ]);
}

/** Тактика й заміни перед грою. */
function coachMatchPrepKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('⚡ Атака', 'coach:tactic:attack'),
      Markup.button.callback('⚖️ Баланс', 'coach:tactic:balance'),
      Markup.button.callback('🛡 Оборона', 'coach:tactic:defense'),
    ],
    [Markup.button.callback('▶️ Новий матч', 'fifa:new')],
    [Markup.button.callback('🔁 Заміни гравців', 'coach:subs')],
    [Markup.button.callback('← До офісу', 'coach:hub:root')],
  ]);
}

/** Вправи на полі (окремі види тренування). */
function coachTrainingKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🔁 Паси', 'coach:tr:pass'),
      Markup.button.callback('🎯 Удари', 'coach:tr:finish'),
    ],
    [
      Markup.button.callback('📌 Стандарти', 'coach:tr:set'),
      Markup.button.callback('📋 Пресинг', 'coach:tr:press'),
    ],
    [Markup.button.callback('🏃 Витривалість', 'coach:tr:end')],
    [
      Markup.button.callback('📋 Схема поля (бонус 2 матчі)', 'coach:drill:tactical'),
      Markup.button.callback('⚽ Комбінації', 'coach:drill:technical'),
    ],
    [Markup.button.callback('← До офісу', 'coach:hub:root')],
  ]);
}

function coachOfficeKeyboard() {
  return coachOfficeRootKeyboard();
}

async function openCoachOfficeOrHint(ctx) {
  if (getCareerMode(ctx.from.id) !== 'coach') {
    await ctx.reply(
      '<b>🎧 Офіс тренера</b> відкривається в режимі тренера.\nПеремкни <code>/swap</code>: клуб → гравець → тренер → агент → клуб. Далі натисни «🎧 Тренер», «📊 Чемпіонат» або кнопку «🎧 Офіс тренера» в меню.',
      { parse_mode: 'HTML' }
    );
    return;
  }
  await showCoachOffice(ctx);
}

async function showCoachOffice(ctx) {
  const uid = ctx.from.id;
  const c = getCoachState(uid);
  const tacticLabel =
    c.tactic === 'attack' ? '⚡ Атакувальна' : c.tactic === 'defense' ? '🛡 Оборонна' : '⚖️ Збалансована';
  const bonus = coachEaseFromState(uid).toFixed(3);
  const w = getWallet(uid);
  const subsLine = c.subsFresh
    ? '<i>Заміни доступні до наступного матчу — освіжити склад.</i>'
    : '<i>Заміни вже зіграні — знову після матчу.</i>';
  await ctx.reply(
    `<b>🎧 Офіс тренера</b>\n\n` +
      `Тактика: <b>${tacticLabel}</b>\n` +
      `Мораль: <b>${c.morale}</b>/100\n` +
      `Втома: <b>${c.fatigue}</b>/22 <i>(занижує бонус)</i>` +
      coachActiveDrillHtml(c) +
      `\n\n${subsLine}\n\n` +
      `<i>У режимі тренера ти граєш товариські матчі та турніри; клубної ліги немає — перемкни /swap на 🏟 клуб.</i>\n` +
      `<i>Сумарний бонус до легкості матчу (зі складом): до ~<b>${bonus}</b>.</i>\n\n` +
      `<b>Обери розділ:</b> <b>матч</b> — тактика й заміни; <b>тренування</b> — паси, удари, пресинг тощо. Усе безкоштовно.\n` +
      `Баланс: <b>${w.coins}</b> 🪙 <i>(для магазину тощо)</i>.`,
    { parse_mode: 'HTML', ...coachOfficeRootKeyboard() }
  );
}

function formatSklad(userId) {
  const w = getWallet(userId);
  const lines = [`💰 Монети: **${w.coins}**`, '', '👥 **Склад команди:**'];
  const squadIds = Object.keys(w.squad).filter((id) => w.squad[id] > 0);
  if (!squadIds.length) {
    lines.push('_поки нікого — гравців можна отримати з паків у /shop_');
  } else {
    squadIds.sort();
    for (const id of squadIds) {
      const p = getPlayerMeta(id);
      lines.push(p ? `• ${p.name} — ${p.rating} OVR` : `• ${id}`);
    }
    const avgOvr = averageSquadOvr(userId);
    if (avgOvr > 0) {
      lines.push('', `_Середній OVR **${avgOvr.toFixed(1)}** — чим він вищий, тим легше в матчі проти бота (і на своєму ході в PvP)._`);
    }
  }
  if (getCareerMode(userId) === 'coach') {
    lines.push('', '_🎧 Режим тренера: офіс — «🎧 Тренер» або «📊 Чемпіонат» (/championship)._');
  }
  if (getCareerMode(userId) === 'agent') {
    lines.push('', '_🤝 Режим агента: офіс — «🤝 Агент» або «📊 Чемпіонат» (/championship)._');
  }
  lines.push('', '🏆 **Трофеї (кубки):**');
  const trophyEntries = Object.entries(w.inventory).filter(
    ([id, n]) => n > 0 && TROPHY_ITEMS.some((t) => t.id === id)
  );
  if (!trophyEntries.length) {
    lines.push('_поки немає — виграй кубковий турнір, чемпіонат або отримай від адміна_');
  } else {
    trophyEntries.sort(([a], [b]) => a.localeCompare(b));
    for (const [id, n] of trophyEntries) {
      lines.push(`• ${trophyLabelById(id)} ×${n}`);
    }
  }
  lines.push('', '📦 **Сувеніри:**');
  const souvenirEntries = Object.entries(w.inventory).filter(
    ([id, n]) => n > 0 && !TROPHY_ITEMS.some((t) => t.id === id)
  );
  if (!souvenirEntries.length) {
    lines.push('_немає_');
  } else {
    for (const [id, n] of souvenirEntries) {
      const meta = SHOP_ITEMS.find((x) => x.id === id);
      const label = meta ? meta.name : id;
      lines.push(`• ${label} ×${n}`);
    }
  }
  return lines.join('\n');
}

function shopKeyboard() {
  const rows = [];
  rows.push([Markup.button.callback('—— Паки (рандом гравець) ——', 'shop:nop')]);
  for (const pk of SHOP_PACKS) {
    rows.push([Markup.button.callback(`📦 ${pk.name} — ${pk.price} 🪙`, `shop:pack:${pk.id}`)]);
  }
  rows.push([Markup.button.callback('—— Сувеніри ——', 'shop:nop')]);
  for (const item of SHOP_ITEMS) {
    rows.push([Markup.button.callback(`${item.name} — ${item.price} 🪙`, `shop:buy:${item.id}`)]);
  }
  rows.push([Markup.button.callback('🔙 Закрити', 'shop:close')]);
  return Markup.inlineKeyboard(rows);
}

function awardAfterMatch(userId, you, them) {
  if (you > them) addCoins(userId, 28);
  else if (them > you) addCoins(userId, 6);
  else addCoins(userId, 12);
}

function awardAfterPenalty(userId, youWon, draw) {
  if (draw) addCoins(userId, 10);
  else if (youWon) addCoins(userId, 22);
  else addCoins(userId, 5);
}

function getMatch(userId) {
  return fifaMatchByUser.get(userId);
}

function getTournamentDef(defId) {
  return TOURNAMENT_DEFS.find((d) => d.id === defId) || null;
}

function buildTournamentMeta(defId, stageIndex) {
  const def = getTournamentDef(defId);
  if (!def || stageIndex < 0 || stageIndex >= def.stages.length) return null;
  const st = def.stages[stageIndex];
  return {
    defId,
    stageIndex,
    label: st.label,
    opponent: st.opponent,
    strength: st.strength,
    defName: def.name,
    emoji: def.emoji,
    finalBonus: def.finalBonus,
    stagesCount: def.stages.length,
  };
}

function formatTournamentBracket(defId, stageIndex) {
  const def = getTournamentDef(defId);
  if (!def) return '';
  const parts = def.stages.map((st, i) => {
    if (i < stageIndex) return `${st.label} ✓`;
    if (i === stageIndex) return `**${st.label}**`;
    return st.label;
  });
  const s = def.stages[stageIndex].strength;
  const pct = Math.min(99, Math.round(s * 380));
  return `${def.emoji} _${def.name}_\n${parts.join('  ·  ')}\nСуперник: **${def.stages[stageIndex].opponent}** · сила бота ~${pct}%`;
}

function tournamentStartKeyboard() {
  return Markup.inlineKeyboard(
    TOURNAMENT_DEFS.map((d) => [
      Markup.button.callback(`${d.emoji} ${d.name}`, `tour:start:${d.id}`),
    ]).concat([[Markup.button.callback('🔙 Назад', 'tour:cancel')]])
  );
}

function startMatch(userId, opts = {}) {
  const state = {
    you: 0,
    them: 0,
    turn: 0,
    maxTurns: MAX_TURNS,
    possession: 'you',
    tournament: opts.tournament || null,
    league: opts.league || null,
    playerSeason: opts.playerSeason || null,
    liveAnimMessageId: null,
  };
  fifaMatchByUser.set(userId, state);
  return state;
}

function isMatchActive(state) {
  return Boolean(state && state.turn < state.maxTurns);
}

function formatScore(state) {
  return `${state.you} : ${state.them}`;
}

function minuteLabel(turn) {
  return Math.min(turn * MINUTES_PER_TURN, 90);
}

function possessionLabel(state) {
  return state.possession === 'you' ? '🟢 Мʼяч у тебе' : '🔴 Мʼяч у суперника';
}

function decideNextPossession(action, result, previous) {
  if (result.you > result.them) return 'them';
  if (result.them > result.you) return 'you';

  const defensive = action === 'tackle' || action === 'block' || action === 'mark';
  if (defensive) {
    if (
      result.text.includes('м’яч твій') ||
      result.text.includes('перехоплюєш') ||
      result.text.includes('Контратака — ти забиваєш')
    ) {
      return 'you';
    }
    return 'them';
  }

  if (
    result.text.includes('перехопив пас') ||
    result.text.includes('відрізав передачу') ||
    result.text.includes('Контратака суперника')
  ) {
    return 'them';
  }
  return previous;
}

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fifaMoveKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('⚽ Пас', 'fifa:pass'),
      Markup.button.callback('🎯 Навіс', 'fifa:cross'),
      Markup.button.callback('🔥 Удар', 'fifa:shoot'),
    ],
    [
      Markup.button.callback('🛡 Відбір', 'fifa:tackle'),
      Markup.button.callback('🧱 Блок', 'fifa:block'),
      Markup.button.callback('📌 Пресинг', 'fifa:mark'),
    ],
  ]);
}

function cornerLabel(side) {
  if (side === 'left') return 'вліво';
  if (side === 'right') return 'вправо';
  return 'у центр';
}

function penaltyShootKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('⬅️ Вліво', 'pen:sh:left'),
      Markup.button.callback('⏺ Центр', 'pen:sh:center'),
      Markup.button.callback('Вправо ➡️', 'pen:sh:right'),
    ],
  ]);
}

function penaltySaveKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('⬅️ Стрибок вліво', 'pen:sv:left'),
      Markup.button.callback('⏺ Центр', 'pen:sv:center'),
      Markup.button.callback('Вправо ➡️', 'pen:sv:right'),
    ],
  ]);
}

function isYouShooterMove(moves) {
  return moves % 2 === 0;
}

function penaltySummary(st) {
  const phase = st.moves >= REGULATION_KICKS ? ' (булліти)' : '';
  return `Рахунок серії: **${st.you} : ${st.them}**\nЗавершено ударів: ${st.moves}/${REGULATION_KICKS}${phase}`;
}

function penaltySeriesFinished(st) {
  return st.moves >= REGULATION_KICKS && st.moves % 2 === 0 && st.you !== st.them;
}

/**
 * botStrength — турнір (суперник сильніший).
 * squadEase — бонус від складу (середній OVR): зменшує up/down, тобто легше проти бота.
 */
function resolveTurn(action, botStrength = 0, squadEase = 0) {
  const rawB = Math.min(0.24, Math.max(0, botStrength)) * 0.72;
  const ease = Math.min(0.11, Math.max(0, squadEase));
  const b = Math.max(0, rawB - ease * 0.75);
  const up = Math.max(0, b * 0.95 - ease * 0.28);
  const down = Math.max(0, b * 0.75 - ease * 0.45);
  const roll = Math.random();
  const opp = randomPick(['press', 'park', 'counter']);

  if (action === 'pass') {
    if (roll < 0.1 + up && opp !== 'park') {
      return {
        you: 0,
        them: 0,
        text: 'Суперник перехопив пас — відрізав передачу. Мʼяч переходить до нього.',
      };
    }
    if (roll < 0.18 + up * 0.9 && opp === 'counter') {
      return {
        you: 0,
        them: 1,
        text: 'Перехопив пас і контратакою забиває у твої ворота!',
      };
    }
    if (roll < 0.32 - down * 0.25 && opp === 'press') {
      return { you: 0, them: 0, text: 'Під пресингом змушений віддати назад — м’яч твій, позиція гірша.' };
    }
    if (roll < 0.55 - down * 0.2) {
      return { you: 0, them: 0, text: 'Точний пас — комбінація розвивається, мʼяч у тебе.' };
    }
    return { you: 0, them: 0, text: 'Розіграв атаку флангом — контролюєш мʼяч.' };
  }

  if (action === 'cross') {
    if (roll < 0.16 + up && opp === 'counter') {
      return {
        you: 0,
        them: 1,
        text: 'Контратака суперника — вони вибігають у швидкий відрив і забивають.',
      };
    }
    if (roll < 0.38 - down) {
      return {
        you: 1,
        them: 0,
        text: 'Навіс у штрафний — партнер підстрахувався й забиває головою!',
      };
    }
    if (roll < 0.62 + up * 0.35) {
      return { you: 0, them: 0, text: 'Воротар вибиває мʼяч після навісу — мʼяч твій.' };
    }
    if (roll < 0.78 + up * 0.25) {
      return { you: 0, them: 0, text: 'Захисник накриває простріл — нічого небезпечного.' };
    }
    return { you: 0, them: 0, text: 'Навіс відбито, боротьба в середині поля.' };
  }

  if (action === 'shoot') {
    if (roll < 0.26 - down * 0.45 && opp === 'park') {
      return { you: 1, them: 0, text: 'Удар з дистанції — воротар не дотягується. ГОЛ!' };
    }
    if (roll < 0.4 - down) {
      return { you: 1, them: 0, text: 'Протаранив лінію захисту і влучив у кут — ГОЛ!' };
    }
    if (roll < 0.58 + up * 0.3) {
      return { you: 0, them: 0, text: 'Мимо воріт — трохи не влучив у кут.' };
    }
    if (roll < 0.74 + up * 0.25) {
      return { you: 0, them: 0, text: 'Воротар забирає мʼяч у руки після слабкого удару.' };
    }
    if (roll < 0.86 + up * 0.5 && opp === 'counter') {
      return {
        you: 0,
        them: 1,
        text: 'Після твого промаху швидка контратака — гол у твої ворота.',
      };
    }
    return { you: 0, them: 0, text: 'Удар заблоковано — мʼяч лишається біля штрафного.' };
  }

  if (action === 'tackle') {
    if (roll < 0.38 - down * 0.35) {
      return { you: 0, them: 0, text: 'Чистий відбір — перехоплюєш і мʼяч твій!' };
    }
    if (roll < 0.62 + up * 0.2) {
      return { you: 0, them: 0, text: 'Свисток — фол на тобі, суперник з мʼячем.' };
    }
    if (roll < 0.82 + up * 0.15) {
      return { you: 0, them: 0, text: 'Суперник обіграв кроком — мʼяч у нього.' };
    }
    if (roll < Math.min(0.97, 0.93 + up * 0.6)) {
      return { you: 0, them: 1, text: 'Промах у відборі — Контратака суперника і ГОЛ!' };
    }
    return { you: 1, them: 0, text: 'Контратака — ти забиваєш після вкраденого мʼяча!' };
  }

  if (action === 'block') {
    if (roll < 0.42 - down * 0.3) {
      return { you: 0, them: 0, text: 'Тілом перекрив простріл — мʼяч твій, можна виходити в атаку.' };
    }
    if (roll < 0.68 + up * 0.2) {
      return { you: 0, them: 0, text: 'Удар зрикошетив у аут — суперник подає.' };
    }
    if (roll < 0.86 + up * 0.15) {
      return { you: 0, them: 0, text: 'Блок частковий — суперник підбирає другий мʼяч.' };
    }
    return { you: 0, them: 1, text: 'Контратака суперника — проскочили блок і забили.' };
  }

  if (action === 'mark') {
    if (roll < 0.4 - down * 0.3) {
      return { you: 0, them: 0, text: 'Пресинг змусив помилитися — перехоплюєш пас!' };
    }
    if (roll < 0.65 + up * 0.15) {
      return { you: 0, them: 0, text: 'Суперник віддає назад — мʼяч у них, але без небезпеки.' };
    }
    if (roll < 0.85 + up * 0.1) {
      return { you: 0, them: 0, text: 'Тебе обіграли корпусом — втратив позицію.' };
    }
    return { you: 0, them: 1, text: 'Прорвали пресинг — швидка атака і гол у твої ворота.' };
  }

  return { you: 0, them: 0, text: 'Нічого особливого — гра триває.' };
}

function endMessage(state) {
  const { you, them } = state;
  if (you > them) return `\n🏆 Фінал: ${formatScore(state)}. Ти переміг!`;
  if (them > you) return `\n😔 Фінал: ${formatScore(state)}. Поразка — наступного разу!`;
  return `\n🤝 Фінал: ${formatScore(state)}. Нічия!`;
}

function mainMenuKeyboard(userId) {
  const rows = [];
  if (userId != null && userId > 0) {
    const cm = getCareerMode(userId);
    const badge =
      cm === 'club'
        ? '🏟 Режим: клуб'
        : cm === 'player'
          ? '👤 Режим: гравець'
          : cm === 'coach'
            ? '🎧 Режим: тренер'
            : '🤝 Режим: агент';
    rows.push([Markup.button.callback(badge, 'menu:mode_tip')]);
    rows.push([Markup.button.callback('❓ Режими карʼєри', 'menu:modes_help')]);
  }
  rows.push(
    [Markup.button.callback('▶️ Новий матч', 'fifa:new')],
    [Markup.button.callback('🏆 Турнір (сітка)', 'tour:menu')],
    [Markup.button.callback('📊 Чемпіонат (ліга)', 'league:menu')],
    [Markup.button.callback('🎧 Офіс тренера', 'coach:menu')],
    [Markup.button.callback('🤝 Офіс агента', 'agent:menu')],
    [Markup.button.callback('🔗 Цепочка нагород', 'chain:menu')],
    [
      Markup.button.callback('🥅 Пенальті', 'pen:new'),
      Markup.button.callback('🛒 Магазин', 'shop:open'),
    ],
    [Markup.button.callback('👥 Склад команди', 'sklad:open')]
  );
  return Markup.inlineKeyboard(rows);
}

/**
 * Постійна клавіатура знизу (Reply).
 * @param {{ prependContactRequest?: boolean }} [opts] — для /pvp_contact: перший рядок «поділитися номером», далі завжди «📋 Меню» й решта.
 */
function bottomMenuReplyKeyboard(opts = {}) {
  const prependContactRequest = Boolean(opts.prependContactRequest);
  const rows = [
    ['📋 Меню'],
    ['▶️ Матч', '🏆 Турнір'],
    ['📊 Чемпіонат', '🎧 Тренер'],
    ['🤝 Агент'],
    ['🔗 Цепочка'],
    ['🛒 Магазин', '👥 Склад'],
    ['🥅 Пенальті'],
  ];
  if (transferExchangeEnabled) rows.push(['🔄 Обмін гравцями']);
  if (prependContactRequest) {
    return Markup.keyboard([[Markup.button.contactRequest('📱 Поділитися номером')], ...rows]).resize();
  }
  return Markup.keyboard(rows).resize();
}

async function broadcastBottomMenuToKnownUsers(telegram, text) {
  let ok = 0;
  let fail = 0;
  for (const id of knownUsersById.keys()) {
    try {
      await telegram.sendMessage(id, text, { parse_mode: 'Markdown', ...bottomMenuReplyKeyboard() });
      ok += 1;
    } catch {
      fail += 1;
    }
  }
  return { ok, fail };
}

function tradePickOfferKeyboard(userId) {
  const w = getWallet(userId);
  const ids = Object.keys(w.squad || {}).filter((pid) => (w.squad[pid] || 0) > 0);
  if (!ids.length) return null;
  const rows = [];
  for (const pid of ids) {
    const m = getPlayerMeta(pid);
    const label = (m ? `${m.name} (${m.rating})` : pid).slice(0, 58);
    rows.push([Markup.button.callback(label, `tr:ofr:${pid}`)]);
  }
  rows.push([Markup.button.callback('Скасувати чернетку', 'tr:cancel')]);
  return Markup.inlineKeyboard(rows);
}

async function handleFifaStart(ctx) {
  const userId = ctx.from.id;
  if (getPvpSessionByUser(userId)) {
    await ctx.reply('Ти в PvP-матчі. Дограй або напиши /pvp_stop (якщо ти в цьому матчі).');
    return;
  }
  if (careerBarsTournamentOrFriendly(userId)) {
    await ctx.reply(
      getCareerMode(userId) === 'club'
        ? 'У тебе йде <b>чемпіонат (ліга)</b>. Продовжи через «📊 Чемпіонат» або /championship, або скинь: /league_stop.'
        : 'У тебе йде <b>карʼєра гравця</b> (20 сезонів). Продовжи через /championship або скинь: /league_stop.',
      { parse_mode: 'HTML' }
    );
    return;
  }
  if (penaltyByUser.has(userId)) {
    await ctx.reply('Спочатку заверши серію пенальті (/penalty_stop) або дограй удари.');
    return;
  }

  const existing = getMatch(userId);

  if (isMatchActive(existing)) {
    await ctx.reply(
      `Матч уже йде: ${formatScore(existing)}. Хвилина ~${minuteLabel(existing.turn)}.\n` +
        `${possessionLabel(existing)}.\n` +
        'Обери хід кнопками (атака й захист) або команди /pass, /cross, /shoot, /tackle, /block, /mark.',
      fifaMoveKeyboard()
    );
    return;
  }

  tournamentProgressByUser.delete(userId);
  startMatch(userId);
  const state = getMatch(userId);
  const caption =
    `⚽ Новий матч!\nРахунок ${formatScore(state)}.\n` +
    `${possessionLabel(state)}.\n` +
    `Хід 1/${state.maxTurns} (~${MINUTES_PER_TURN} хв).\n\n` +
    'Обери хід кнопками 👇 (верхній ряд — атака, нижній — захист).';
  await postSoloMatchLiveBoard(
    ctx,
    state,
    {
      caption,
      ...fifaMoveKeyboard(),
    }
  );
}

async function startPenaltySeries(ctx, options = {}) {
  const {
    fromMatchDraw = false,
    tournamentMeta = null,
    leagueMeta = null,
    playerSeasonMeta = null,
  } = options;
  const userId = ctx.from.id;
  if (getPvpSessionByUser(userId)) {
    await ctx.reply('Спочатку заверши PvP (/pvp_stop).');
    return;
  }
  if (!fromMatchDraw && isMatchActive(getMatch(userId))) {
    await ctx.reply('Заверши спочатку матч (/fifa_stop) або дограй до фінального свистка.');
    return;
  }
  if (penaltyByUser.has(userId)) {
    await ctx.reply('Серія вже йде — обери кут кнопками під останнім повідомленням.');
    return;
  }
  penaltyByUser.set(userId, {
    you: 0,
    them: 0,
    moves: 0,
    fromMatchDraw,
    tournamentMeta: tournamentMeta || null,
    leagueMeta: leagueMeta || null,
    playerSeasonMeta: playerSeasonMeta || null,
  });
  const st = penaltyByUser.get(userId);
  const intro = fromMatchDraw
    ? `🥅 **Нічия в матчі — вирішує серія пенальті!**\n`
    : `🥅 **Серія пенальті**\n`;
  await ctx.reply(
    intro +
      `По ${REGULATION_PENALTIES} ударів кожному, ти бʼєш першим.\n` +
      `${penaltySummary(st)}\n\nТвій удар — обери кут:`,
    { parse_mode: 'Markdown', ...penaltyShootKeyboard() }
  );
}

async function finishPenaltySeries(ctx, st) {
  const userId = ctx.from.id;
  penaltyByUser.delete(userId);
  const coachPenaltyBump =
    (getCareerMode(userId) === 'coach' || getCareerMode(userId) === 'agent') &&
    !st.leagueMeta &&
    !st.playerSeasonMeta;
  if (coachPenaltyBump) bumpCoachOrAgentAfterFriendly(userId, st.you, st.them, st.leagueMeta, st.playerSeasonMeta);
  let tail = '';
  const drawExtra = st.fromMatchDraw ? '\n_+12 🪙 за нічию в основний час_' : '';
  if (st.you > st.them) {
    awardAfterPenalty(userId, true, false);
    if (st.fromMatchDraw) addCoins(userId, 12);
    tail = `\n🏆 Ти виграв серію!\n+22 🪙${drawExtra}\nБаланс: **${getWallet(userId).coins}** 🪙`;
  } else if (st.them > st.you) {
    awardAfterPenalty(userId, false, false);
    if (st.fromMatchDraw) addCoins(userId, 12);
    tail = `\n😔 Суперник виграв серію.\n+5 🪙${drawExtra}\nБаланс: **${getWallet(userId).coins}** 🪙`;
  } else {
    awardAfterPenalty(userId, false, true);
    if (st.fromMatchDraw) addCoins(userId, 12);
    tail = `\n🤝 Нічия й у пенальті.\n+10 🪙${drawExtra}\nБаланс: **${getWallet(userId).coins}** 🪙`;
  }
  await ctx.reply(`Фінал серії: **${st.you} : ${st.them}**${tail}`, { parse_mode: 'Markdown' });

  if (st.leagueMeta) {
    const lm = st.leagueMeta;
    let yG = lm.regYou;
    let tG = lm.regThem;
    if (yG === tG) {
      if (st.you > st.them) yG += 1;
      else tG += 1;
    }
    await finishLeagueRoundAfterMatch(ctx, userId, yG, tG, lm);
    return;
  }

  if (st.playerSeasonMeta) {
    const pm = st.playerSeasonMeta;
    let yG = pm.regYou;
    let tG = pm.regThem;
    if (yG === tG) {
      if (st.you > st.them) yG += 1;
      else tG += 1;
    }
    await finishPlayerCareerMatch(ctx, userId, yG, tG, pm);
    return;
  }

  if (st.tournamentMeta) {
    const tm = st.tournamentMeta;
    const def = getTournamentDef(tm.defId);
    if (def && st.you > st.them) {
      const nextIdx = tm.stageIndex + 1;
      if (nextIdx >= def.stages.length) {
        tournamentProgressByUser.delete(userId);
        addCoins(userId, def.finalBonus);
        const tid = trophyIdForTournamentDefId(tm.defId);
        let trophyExtra = '';
        if (tid && grantTrophy(userId, tid)) {
          trophyExtra = `\n🏆 Трофей у /sklad: **${trophyLabelById(tid)}**`;
        }
        await ctx.reply(
          `🏆 **Турнір виграно** (${def.emoji} ${def.name})\n+${def.finalBonus} 🪙${trophyExtra}\nБаланс: **${getWallet(userId).coins}** 🪙`,
          { parse_mode: 'Markdown' }
        );
        return;
      }
      tournamentProgressByUser.set(userId, { defId: tm.defId, stageIndex: nextIdx });
      addCoins(userId, 14 + tm.stageIndex * 7);
      await ctx.reply(
        `✅ Етап **${tm.label}** на пенальті пройдено.\nБаланс: **${getWallet(userId).coins}** 🪙`,
        { parse_mode: 'Markdown' }
      );
      await beginTournamentRound(ctx, tm.defId, nextIdx);
    } else if (st.them > st.you) {
      tournamentProgressByUser.delete(userId);
      await ctx.reply('**Виліт із турніру** після пенальті.', { parse_mode: 'Markdown' });
    }
  }
}

async function handlePenaltyShoot(ctx, side) {
  const userId = ctx.from.id;
  const st = penaltyByUser.get(userId);
  if (!st || !isYouShooterMove(st.moves)) return;

  const keeper = randomPick(['left', 'center', 'right']);
  const goal = keeper !== side;
  if (goal) st.you += 1;
  const res = goal
    ? `⚽ **ГОЛ!** Ти влучив ${cornerLabel(side)}, воротар стрибнув ${cornerLabel(keeper)}.`
    : `🧤 **Сейв.** Ти бив ${cornerLabel(side)}, воротар вгадав ${cornerLabel(keeper)}.`;

  st.moves += 1;
  let msg = `${res}\n${penaltySummary(st)}`;

  if (penaltySeriesFinished(st)) {
    await ctx.reply(msg, { parse_mode: 'Markdown' });
    await finishPenaltySeries(ctx, st);
    return;
  }

  if (!isYouShooterMove(st.moves)) {
    msg += '\n\nСуперник бʼє — **обери, куди стрибати:**';
    await ctx.reply(msg, { parse_mode: 'Markdown', ...penaltySaveKeyboard() });
    return;
  }

  msg += '\n\nТвій удар — обери кут:';
  await ctx.reply(msg, { parse_mode: 'Markdown', ...penaltyShootKeyboard() });
}

async function handlePenaltySave(ctx, dive) {
  const userId = ctx.from.id;
  const st = penaltyByUser.get(userId);
  if (!st || isYouShooterMove(st.moves)) return;

  const shot = randomPick(['left', 'center', 'right']);
  const saved = dive === shot;
  if (!saved) st.them += 1;
  const res = saved
    ? `🧤 **Сейв!** Вони били ${cornerLabel(shot)}, ти стрибнув ${cornerLabel(dive)}.`
    : `⚽ **Гол суперника.** Удар ${cornerLabel(shot)}, ти стрибнув ${cornerLabel(dive)}.`;

  st.moves += 1;
  let msg = `${res}\n${penaltySummary(st)}`;

  if (penaltySeriesFinished(st)) {
    await ctx.reply(msg, { parse_mode: 'Markdown' });
    await finishPenaltySeries(ctx, st);
    return;
  }

  if (isYouShooterMove(st.moves)) {
    msg += '\n\nТвій удар — обери кут:';
    await ctx.reply(msg, { parse_mode: 'Markdown', ...penaltyShootKeyboard() });
  } else {
    msg += '\n\nСуперник знову бʼє — **стрибай:**';
    await ctx.reply(msg, { parse_mode: 'Markdown', ...penaltySaveKeyboard() });
  }
}

async function finishLeagueRoundAfterMatch(ctx, userId, yG, tG, snap) {
  const lg = leagueByUser.get(userId);
  if (!lg) return;
  applyLeagueMatchResult(lg, 'you', snap.oppKey, yG, tG);
  simulateLeagueParallelMatch(lg, snap.round);
  lg.round += 1;
  awardAfterMatch(userId, yG, tG);
  await ctx.reply(formatLeagueTableHtml(lg), { parse_mode: 'HTML' });

  if (lg.round >= 9) {
    lg.finished = true;
    const sorted = sortLeagueRows(lg.rows);
    const pos = sorted.findIndex((r) => r.key === 'you') + 1;
    const bonus = LEAGUE_POS_BONUS[pos - 1] ?? LEAGUE_POS_BONUS[LEAGUE_POS_BONUS.length - 1];
    addCoins(userId, bonus);
    const winner = sorted[0];
    let trophyLine = '';
    if (pos === 1) {
      grantTrophy(userId, 'trophy_league_gold');
      trophyLine = `\n🥇 Трофей: <b>${escapeHtml(trophyLabelById('trophy_league_gold'))}</b> — у /sklad`;
    } else if (pos === 2) {
      grantTrophy(userId, 'trophy_league_silver');
      trophyLine = `\n🥈 Трофей: <b>${escapeHtml(trophyLabelById('trophy_league_silver'))}</b> — у /sklad`;
    } else if (pos === 3) {
      grantTrophy(userId, 'trophy_league_bronze');
      trophyLine = `\n🥉 Трофей: <b>${escapeHtml(trophyLabelById('trophy_league_bronze'))}</b> — у /sklad`;
    }
    await ctx.reply(
      `🏆 <b>Чемпіонат завершено!</b>\nТвоє місце: <b>${pos}</b> / 10\nПереможець ліги: <b>${escapeHtml(winner.name)}</b>\n+${bonus} 🪙 · баланс: <b>${getWallet(userId).coins}</b> 🪙${trophyLine}`,
      { parse_mode: 'HTML' }
    );
    leagueByUser.delete(userId);
    return;
  }

  const next = LEAGUE_OPPONENTS[lg.round];
  await ctx.reply(
    `▶️ Наступний тур <b>${lg.round + 1}/9</b> — суперник: <b>${escapeHtml(next.name)}</b>.\nНатисни кнопку або <code>/championship</code>.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('⚽ Старт туру', 'league:play')]]),
    }
  );
}

async function finishPlayerCareerMatch(ctx, userId, yG, tG, snap) {
  awardAfterMatch(userId, yG, tG);
  const pc = playerCareerByUser.get(userId);
  if (!pc || !snap.careerFinalKey) return;

  const win = yG > tG;
  const q = pc.finalsQueue;
  if (q.length && q[0].key === snap.careerFinalKey) q.shift();

  if (snap.careerFinalKey === 'cup') pc.cupWon = win;
  if (snap.careerFinalKey === 'euro') pc.euroWon = win;
  if (snap.careerFinalKey === 'wc') pc.wcWon = win;
  bumpCareerOvrAfterFinal(pc, win);
  const coinWin =
    win && snap.careerFinalKey === 'wc' ? 52 : win ? 42 : 15;
  addCoins(userId, coinWin);

  await ctx.reply(
    `🏆 ${snap.careerFinalLabel}: ${win ? '**перемога**' : '**поразка**'} (${yG}:${tG}).\n` +
      `**${escapeMarkdownV1(pc.playerName)}** · ${pc.playerOvr} OVR · ${pc.playerAge} років\nБаланс: **${getWallet(userId).coins}** 🪙`,
    { parse_mode: 'Markdown' }
  );

  if (pc.finalsQueue.length > 0) {
    pc.phase = 'final_pick';
    await promptCareerFinalChoice(ctx, pc);
    return;
  }
  pc.phase = 'season_outro';
  await showSeasonOutroSummary(ctx, userId, pc);
}

async function promptCareerFinalChoice(ctx, pc) {
  const f = pc.finalsQueue[0];
  if (!f) return;
  const pct = Math.min(99, Math.round(f.strength * 380));
  const pline =
    pc.playerName &&
    `<i>${escapeHtml(pc.playerName)} · ${pc.playerOvr} OVR · ${pc.playerAge} років</i>\n\n`;
  await ctx.reply(
    `${pline || ''}<b>Фінал</b> · ${escapeHtml(f.label)}\nvs <b>${escapeHtml(f.opponent)}</b> · сила бота ~${pct}%\n\n` +
      'Обери: зіграти матч або швидка симуляція.',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🎮 Грати фінал', 'pc:fplay'),
          Markup.button.callback('⚡ Симулювати', 'pc:fsim'),
        ],
      ]),
    }
  );
}

async function showSeasonOutroSummary(ctx, userId, pc) {
  finalizeCareerSeasonStats(pc);
  ensureCareerStats(pc);
  if (pc.leaguePlace === 1 && pc.cupWon && pc.euroWon && pc.triplesRecordedSeason !== pc.season) {
    pc.careerTripleCrowns = (pc.careerTripleCrowns || 0) + 1;
    pc.triplesRecordedSeason = pc.season;
  }
  const honorExtra = maybeAwardSeasonHonors(userId, pc);
  const questBlock = formatCareerQuestProgressHtml(pc);

  const cupTxt = !pc.cupReachedFinal ? 'виліт до фіналу' : pc.cupWon ? '🏆 перемога у фіналі' : 'фінал програно';
  const euroTxt = !pc.euroReachedFinal ? 'виліт до фіналу' : pc.euroWon ? '🏆 перемога у фіналі' : 'фінал програно';
  const wcTxt = !pc.wcReachedFinal ? 'виліт до фіналу' : pc.wcWon ? '🏆 перемога у фіналі' : 'фінал програно';

  const inner = pc.resultLines.map((x) => escapeHtml(x)).join('\n');
  let body =
    `<b>Підсумок сезону ${pc.season}/20</b>\n${escapeHtml(pc.clubName)}\n` +
    `<b>Гравець:</b> ${escapeHtml(pc.playerName)} · ${pc.playerOvr} OVR · ${pc.playerAge} років\n\n` +
    `<pre>${inner}</pre>\n` +
    `<b>Ліга:</b> ${pc.leaguePlace} місце\n<b>Кубок:</b> ${cupTxt}\n<b>Єврокубок:</b> ${euroTxt}\n<b>Чемпіонат світу:</b> ${wcTxt}`;
  body += honorExtra;
  if (questBlock) body += `\n\n${questBlock}`;

  const kb =
    pc.season >= 20
      ? [[Markup.button.callback('🏁 Завершити карʼєру', 'pc:next')]]
      : [[Markup.button.callback('▶️ Наступний сезон', 'pc:next')]];

  await ctx.reply(body, { parse_mode: 'HTML', ...Markup.inlineKeyboard(kb) });
}

function careerContractKeyboard(pc) {
  if (!pc.offers?.length) return Markup.inlineKeyboard([]);
  return Markup.inlineKeyboard(
    pc.offers.map((o) => [
      Markup.button.callback(o.clubName.slice(0, 58), `pc:ctr:${o.clubKey}`),
    ])
  );
}

function careerPlayerPickKeyboard(pc) {
  if (!pc.playerOffers?.length) return Markup.inlineKeyboard([]);
  const rows = pc.playerOffers.map((p) => {
    const lbl = `${p.name.slice(0, 20)} ·${p.baseOvr} ·${p.startAge}р`.slice(0, 58);
    return [Markup.button.callback(lbl, `pc:pfp:${p.key}`)];
  });
  rows.push([Markup.button.callback('🔁 Інші зірки', 'pc:pfr')]);
  return Markup.inlineKeyboard(rows);
}

async function beginPlayerCareerFinalMatch(ctx) {
  const userId = ctx.from.id;
  if (getPvpSessionByUser(userId)) {
    await ctx.reply('Спочатку заверши PvP (/pvp_stop).');
    return;
  }
  if (penaltyByUser.has(userId)) {
    await ctx.reply('Спочатку заверши пенальті.');
    return;
  }
  if (tournamentProgressByUser.has(userId)) {
    await ctx.reply('Спочатку заверши або скинь кубковий турнір (/tournament_stop).');
    return;
  }
  if (hasActiveLeague(userId)) {
    await ctx.reply('У тебе активна **ліга за клуб**. Перемкни /swap на клуб або скинь лігу.', {
      parse_mode: 'Markdown',
    });
    return;
  }

  const active = getMatch(userId);
  if (isMatchActive(active)) {
    if (!active.playerSeason?.careerFinalKey) {
      await ctx.reply('Зараз інший матч. Заверши або /fifa_stop.');
      return;
    }
    const meta = active.playerSeason;
    const pct = Math.min(99, Math.round(meta.strength * 380));
    const pc0 = playerCareerByUser.get(userId);
    const pline = pc0?.playerName
      ? `\n${escapeHtml(pc0.playerName)} · ${pc0.playerOvr} OVR · ${pc0.playerAge} років`
      : '';
    await ctx.reply(
      `🏆 <b>Фінал кар'єри</b> · сезон <b>${meta.season}/20</b>${pline}\n${escapeHtml(meta.careerFinalLabel)}\nvs <b>${escapeHtml(meta.opponent)}</b> · ~${pct}%\n\n` +
        `▶️ Матч: <b>${formatScore(active)}</b> · хід ${active.turn + 1}/${active.maxTurns}`,
      { parse_mode: 'HTML', ...fifaMoveKeyboard() }
    );
    return;
  }

  const pc = playerCareerByUser.get(userId);
  const f = pc?.finalsQueue?.[0];
  if (!pc || pc.phase !== 'final_pick' || !f) {
    await ctx.reply('Немає фіналу для матчу. Відкрий /championship.');
    return;
  }

  tournamentProgressByUser.delete(userId);
  startMatch(userId, {
    playerSeason: {
      season: pc.season,
      strength: f.strength,
      opponent: f.opponent,
      careerFinalKey: f.key,
      careerFinalLabel: f.label,
    },
  });
  const state = getMatch(userId);
  const pct = Math.min(99, Math.round(f.strength * 380));
  const cap =
    `🏆 <b>Фінал</b> · сезон <b>${pc.season}/20</b>\n` +
    `${escapeHtml(pc.playerName)} · ${pc.playerOvr} OVR · ${pc.playerAge} років\n` +
    `${escapeHtml(f.label)}\nvs <b>${escapeHtml(f.opponent)}</b> · ~${pct}%\n\n` +
    `Рахунок: <b>${formatScore(state)}</b>\n${possessionLabel(state)}.\n` +
    `Хід 1/${state.maxTurns} — обери дію:`;
  await postSoloMatchLiveBoard(
    ctx,
    state,
    {
      caption: cap,
      parse_mode: 'HTML',
      ...fifaMoveKeyboard(),
    }
  );
}

async function runCareerSimulationStep(ctx) {
  const userId = ctx.from.id;
  const pc = playerCareerByUser.get(userId);
  if (!pc || pc.phase !== 'sim_idle') {
    await ctx.reply('Зараз немає кроку симуляції. Відкрий /championship.');
    return;
  }
  runCareerSeasonSimulation(pc);
  const md =
    `📋 **Результати турнірів** · сезон ${pc.season}/20 · ${escapeMarkdownV1(pc.clubName)}\n` +
    `Гравець: **${escapeMarkdownV1(pc.playerName)}** · ${pc.playerOvr} OVR · ${pc.playerAge} років\n\n` +
    pc.resultLines.map((x) => `• ${escapeMarkdownV1(x)}`).join('\n');
  await ctx.reply(md, { parse_mode: 'Markdown' });

  if (pc.phase === 'final_pick') await promptCareerFinalChoice(ctx, pc);
  else await showSeasonOutroSummary(ctx, userId, pc);
}

async function runCareerFinalSimStep(ctx) {
  const userId = ctx.from.id;
  const pc = playerCareerByUser.get(userId);
  if (!pc || pc.phase !== 'final_pick' || !pc.finalsQueue.length) {
    await ctx.reply('Немає фіналу для симуляції.');
    return;
  }
  const f = pc.finalsQueue[0];
  const ease = matchEaseCombined(userId);
  const win = Math.random() < Math.max(0.38, Math.min(0.78, 0.62 - f.strength * 0.95 + ease * 2.65));
  pc.finalsQueue.shift();
  if (f.key === 'cup') pc.cupWon = win;
  if (f.key === 'euro') pc.euroWon = win;
  if (f.key === 'wc') pc.wcWon = win;
  bumpCareerOvrAfterFinal(pc, win);
  addCoins(userId, win ? (f.key === 'wc' ? 48 : 38) : 14);
  await ctx.reply(
    `⚡ Симуляція фіналу (**${f.label}**): ${win ? '**перемога**' : '**поразка**'} vs ${escapeMarkdownV1(f.opponent)}.\n` +
      `Гравець: **${escapeMarkdownV1(pc.playerName)}** · ${pc.playerOvr} OVR · ${pc.playerAge} років\n+монети · баланс **${getWallet(userId).coins}** 🪙`,
    { parse_mode: 'Markdown' }
  );

  if (pc.finalsQueue.length > 0) await promptCareerFinalChoice(ctx, pc);
  else {
    pc.phase = 'season_outro';
    await showSeasonOutroSummary(ctx, userId, pc);
  }
}

async function advanceCareerAfterSeasonOutro(ctx) {
  const userId = ctx.from.id;
  const pc = playerCareerByUser.get(userId);
  if (!pc || pc.phase !== 'season_outro') return;

  finalizeCareerSeasonStats(pc);
  ensureCareerStats(pc);
  if (pc.accumulatedSeason !== pc.season) {
    accumulateCareerSeasonStats(pc);
    pc.accumulatedSeason = pc.season;
  }
  const questRewards = evaluateNewCareerQuestRewards(userId, pc);

  if (pc.season >= 20) {
    const recapHtml = buildCareerEndRecapHtml(pc);
    let trophyHtml = '';
    if (grantTrophy(userId, 'trophy_player_career')) {
      trophyHtml = `\n🏆 Трофей у /sklad: <b>${escapeHtml(trophyLabelById('trophy_player_career'))}</b>`;
    }
    playerCareerByUser.delete(userId);
    addCoins(userId, 400);
    let bonusHtml = '';
    if (questRewards.htmlLines.length) {
      bonusHtml = `\n\n<b>🎯 Бонуси завдань</b>\n${questRewards.htmlLines.join('\n')}`;
    }
    await ctx.reply(
      `${recapHtml}${bonusHtml}${trophyHtml}\n\nБаланс: <b>${getWallet(userId).coins}</b> 🪙`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  applyCareerSeasonGrowth(pc);

  pc.season += 1;
  pc.phase = 'contracts';
  pc.offers = buildCareerContractOffers(pc);
  pc.resultLines = [];
  pc.finalsQueue = [];
  pc.leaguePlace = null;
  pc.cupReachedFinal = false;
  pc.euroReachedFinal = false;
  pc.wcReachedFinal = false;
  pc.cupWon = null;
  pc.euroWon = null;
  pc.wcWon = null;

  let questPrefix = '';
  if (questRewards.htmlLines.length) {
    questPrefix = `<b>🎯 Завдання виконано!</b>\n${questRewards.htmlLines.join('\n')}\n\n`;
  }

  await ctx.reply(
    questPrefix +
      `<b>Сезон ${pc.season}/20</b>\n<b>${escapeHtml(pc.playerName)}</b> · ${pc.playerOvr} OVR · вік ${pc.playerAge}\n\nІнші клуби надсилають пропозиції — обери контракт:`,
    { parse_mode: 'HTML', ...careerContractKeyboard(pc) }
  );
}

async function applyCareerPlayerChoice(ctx, playerKey) {
  const userId = ctx.from.id;
  const pc = playerCareerByUser.get(userId);
  if (!pc || pc.phase !== 'pick_player' || !pc.playerOffers?.length) {
    await ctx.reply('Зараз не час обирати гравця.');
    return;
  }
  const meta = careerProByKey(playerKey);
  const ok = pc.playerOffers.some((x) => x.key === playerKey);
  if (!meta || !ok) {
    await ctx.reply('Цього гравця немає серед запропонованих.');
    return;
  }

  pc.playerKey = playerKey;
  pc.playerName = meta.name;
  pc.playerOvr = meta.baseOvr;
  pc.playerAge = meta.startAge;
  pc.playerOffers = null;
  pc.phase = 'pick_club';
  pc.offers = pickInitialCareerOffers();

  await ctx.reply(
    `<b>${escapeHtml(meta.name)}</b> · ${meta.baseOvr} OVR · вік ${meta.startAge}\n\nОбери клуб (перший контракт):`,
    { parse_mode: 'HTML', ...careerContractKeyboard(pc) }
  );
}

async function applyCareerContractChoice(ctx, clubKey) {
  const userId = ctx.from.id;
  const pc = playerCareerByUser.get(userId);
  if (!pc || !pc.offers || (pc.phase !== 'pick_club' && pc.phase !== 'contracts')) return;

  const hit = pc.offers.find((o) => o.clubKey === clubKey);
  const meta = careerClubByKey(clubKey);
  if (!hit || !meta) {
    await ctx.reply('Такого контракту немає в списку.');
    return;
  }

  pc.clubKey = clubKey;
  pc.clubName = meta.name;
  pc.offers = null;
  pc.phase = 'sim_idle';

  await ctx.reply(
    `<b>${escapeHtml(meta.name)}</b>\nКонтракт підписано.\n<b>${escapeHtml(pc.playerName)}</b> · ${pc.playerOvr} OVR · ${pc.playerAge} років\n\nДалі — симуляція ліги, кубка, єврокубка й чемпіонату світу. Натисни кнопку нижче.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('⚙️ Запустити симуляцію турнірів', 'pc:sim')]]),
    }
  );
}

async function showPlayerCareerPanel(ctx) {
  const userId = ctx.from.id;
  if (tournamentProgressByUser.has(userId)) {
    await ctx.reply('Спочатку заверши кубковий турнір (/tournament_stop) або дограй етап.');
    return;
  }
  if (getPvpSessionByUser(userId)) {
    await ctx.reply('Спочатку заверши PvP (/pvp_stop).');
    return;
  }
  if (penaltyByUser.has(userId)) {
    await ctx.reply('Спочатку заверши пенальті.');
    return;
  }

  const match = getMatch(userId);
  if (isMatchActive(match) && match.playerSeason?.careerFinalKey) {
    await beginPlayerCareerFinalMatch(ctx);
    return;
  }

  const pc = playerCareerByUser.get(userId);

  if (!pc || pc.season < 1 || pc.season > 20) {
    await ctx.reply(
      '<b>👤 Карʼєра гравця</b> (20 сезонів)\nОбери <b>відомого гравця</b>, потім клуб (українські й топ європейські команди). ОVR і вік змінюються з сезонами та фіналами.\nРежим клубу: /swap.\n\nПочни з кнопки нижче.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback("🌟 Нова кар'єра гравця", 'league:new')]]),
      }
    );
    return;
  }

  if (pc.phase === 'pick_player') {
    await ctx.reply(
      '<b>Обери відомого гравця</b>\nТри варіанти нижче. «Інші зірки» — інший випадковий трійник.\n<i>Після кожного сезону змінюються OVR і вік.</i>',
      { parse_mode: 'HTML', ...careerPlayerPickKeyboard(pc) }
    );
    return;
  }

  if (pc.phase === 'pick_club' || pc.phase === 'contracts') {
    const title =
      pc.phase === 'pick_club'
        ? '<b>Перший контракт</b>\nОбери клуб з пропозицій нижче:'
        : `<b>Нові контракти</b> · сезон ${pc.season}/20`;
    const extra = pc.phase === 'contracts' ? `\n\nПоточний клуб: <b>${escapeHtml(pc.clubName)}</b>` : '';
    await ctx.reply(title + extra, {
      parse_mode: 'HTML',
      ...careerContractKeyboard(pc),
    });
    return;
  }

  if (pc.phase === 'sim_idle') {
    await ctx.reply(
      `<b>👤 Сезон ${pc.season}/20</b>\n<b>${escapeHtml(pc.playerName)}</b> · ${pc.playerOvr} OVR · ${pc.playerAge} років\nКлуб: <b>${escapeHtml(pc.clubName)}</b>\n\n` +
        'Натисни — згенеруються результати ліги, кубка країни, єврокубка й чемпіонат світу (збірні). Якщо дійдеш до фіналу — зможеш грати або симулювати.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⚙️ Запустити симуляцію турнірів', 'pc:sim')],
          [Markup.button.callback("🗑 Скинути кар'єру", 'league:reset')],
        ]),
      }
    );
    return;
  }

  if (pc.phase === 'final_pick') {
    await promptCareerFinalChoice(ctx, pc);
    return;
  }

  if (pc.phase === 'season_outro') {
    await showSeasonOutroSummary(ctx, userId, pc);
    return;
  }

  await ctx.reply('Відкрий /championship ще раз або напиши /menu.');
}

async function beginLeagueRound(ctx) {
  const userId = ctx.from.id;
  if (getPvpSessionByUser(userId)) {
    await ctx.reply('Спочатку заверши PvP (/pvp_stop).');
    return;
  }
  if (penaltyByUser.has(userId)) {
    await ctx.reply('Спочатку заверши пенальті.');
    return;
  }
  if (tournamentProgressByUser.has(userId)) {
    await ctx.reply('Спочатку заверши або скинь кубковий турнір (/tournament_stop).');
    return;
  }
  if (getCareerMode(userId) === 'coach') {
    await ctx.reply(
      'У режимі <b>тренера</b> немає матчів ліги. Перемкни <code>/swap</code> на 🏟 клуб.',
      { parse_mode: 'HTML' }
    );
    return;
  }
  if (getCareerMode(userId) === 'agent') {
    await ctx.reply(
      'У режимі <b>агента</b> немає матчів ліги. Перемкни <code>/swap</code> на 🏟 клуб.',
      { parse_mode: 'HTML' }
    );
    return;
  }
  if (hasIncompletePlayerCareer(userId)) {
    await ctx.reply(
      'Спочатку заверши або скинь <b>карʼєру гравця</b> (/swap на режим гравця, потім /league_stop).',
      { parse_mode: 'HTML' }
    );
    return;
  }
  const active = getMatch(userId);
  if (isMatchActive(active)) {
    if (!active.league) {
      await ctx.reply('Зараз інший матч. Заверши або /fifa_stop.');
      return;
    }
    const lg0 = leagueByUser.get(userId);
    const tab0 = lg0 ? `${formatLeagueTableHtml(lg0)}\n\n` : '';
    await ctx.reply(
      `${tab0}▶️ Матч: <b>${formatScore(active)}</b> · хід ${active.turn + 1}/${active.maxTurns}`,
      { parse_mode: 'HTML', ...fifaMoveKeyboard() }
    );
    return;
  }

  const lg = leagueByUser.get(userId);
  if (!lg || lg.finished) {
    await ctx.reply('Обери «Новий чемпіонат» у панелі /championship.');
    return;
  }
  if (lg.round >= 9) {
    await ctx.reply('Сезон уже зіграний. Обирай «Новий чемпіонат».');
    return;
  }

  const opp = LEAGUE_OPPONENTS[lg.round];
  tournamentProgressByUser.delete(userId);
  startMatch(userId, {
    league: {
      round: lg.round,
      oppKey: opp.key,
      opponent: opp.name,
      strength: opp.strength,
    },
  });
  const state = getMatch(userId);
  const table = formatLeagueTableHtml(lg);
  const cap =
    `📊 <b>Чемпіонат</b> · тур <b>${lg.round + 1}/9</b>\nvs <b>${escapeHtml(opp.name)}</b>\n\n${table}\n\n` +
    `Рахунок матчу: <b>${formatScore(state)}</b>\n${possessionLabel(state)}.\n` +
    `Хід 1/${state.maxTurns} — обери дію:`;
  await postSoloMatchLiveBoard(
    ctx,
    state,
    {
      caption: cap,
      parse_mode: 'HTML',
      ...fifaMoveKeyboard(),
    }
  );
}

async function showLeaguePanel(ctx) {
  const userId = ctx.from.id;
  if (getCareerMode(userId) === 'player') {
    await showPlayerCareerPanel(ctx);
    return;
  }
  if (getCareerMode(userId) === 'coach') {
    await showCoachOffice(ctx);
    return;
  }
  if (getCareerMode(userId) === 'agent') {
    await showAgentOffice(ctx);
    return;
  }
  if (tournamentProgressByUser.has(userId)) {
    await ctx.reply('Спочатку заверши кубковий турнір (/tournament_stop) або дограй етап.');
    return;
  }
  if (getPvpSessionByUser(userId)) {
    await ctx.reply('Спочатку заверши PvP (/pvp_stop).');
    return;
  }
  if (penaltyByUser.has(userId)) {
    await ctx.reply('Спочатку заверши пенальті.');
    return;
  }
  const match = getMatch(userId);
  if (isMatchActive(match) && match.league) {
    const lg = leagueByUser.get(userId);
    const table = lg ? formatLeagueTableHtml(lg) : '';
    await ctx.reply(
      `${table}\n\n▶️ Матч чемпіонату: <b>${formatScore(match)}</b> · хід ${match.turn + 1}/${match.maxTurns}`,
      { parse_mode: 'HTML', ...fifaMoveKeyboard() }
    );
    return;
  }

  const lg = leagueByUser.get(userId);
  const rows = [];
  if (!lg || lg.finished) {
    rows.push([Markup.button.callback('🏁 Новий чемпіонат', 'league:new')]);
  } else {
    rows.push([Markup.button.callback('⚽ Старт туру', 'league:play')]);
    rows.push([Markup.button.callback('🗑 Скинути лігу', 'league:reset')]);
  }

  let body =
    '<b>📊 Чемпіонат (ліга)</b>\nЛіга з <b>турнірною таблицею</b>: ти та девʼять клубів бота; кожен тур — твій матч + симуляція матчів між іншими ботами.\n' +
    'Переможець за <b>очками</b> після 9 турів. Скинути: <code>/league_stop</code>.';
  if (lg && !lg.finished) body += `\n\n${formatLeagueTableHtml(lg)}`;

  await ctx.reply(body, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
}

async function beginTournamentRound(ctx, defId, stageIndex) {
  const userId = ctx.from.id;
  if (careerBarsTournamentOrFriendly(userId)) {
    await ctx.reply(
      'Спочатку заверши <b>лігу</b> або <b>карʼєру гравця</b> (/league_stop) або продовж через /championship.',
      { parse_mode: 'HTML' }
    );
    return;
  }
  if (getPvpSessionByUser(userId)) {
    await ctx.reply('Спочатку заверши PvP (/pvp_stop).');
    return;
  }
  const meta = buildTournamentMeta(defId, stageIndex);
  if (!meta) {
    await ctx.reply('Помилка: невідомий турнір або етап.');
    return;
  }
  tournamentProgressByUser.set(userId, { defId, stageIndex });
  startMatch(userId, { tournament: meta });
  const state = getMatch(userId);
  const bracket = formatTournamentBracket(defId, stageIndex);
  const caption =
    `🏆 **Турнірний матч** · ${meta.label}\n${bracket}\n\n` +
    `Рахунок ${formatScore(state)}.\n${possessionLabel(state)}.\n` +
    `Хід 1/${state.maxTurns} (~${MINUTES_PER_TURN} хв) — обери хід:`;
  await postSoloMatchLiveBoard(
    ctx,
    state,
    {
      caption,
      parse_mode: 'Markdown',
      ...fifaMoveKeyboard(),
    }
  );
}

async function showTournamentPanel(ctx) {
  const userId = ctx.from.id;
  if (careerBarsTournamentOrFriendly(userId)) {
    await ctx.reply(
      'У тебе йде <b>чемпіонат (ліга)</b> або <b>карʼєра гравця</b>. Заверши /league_stop або продовж через /championship.',
      { parse_mode: 'HTML' }
    );
    return;
  }
  if (getPvpSessionByUser(userId)) {
    await ctx.reply('Спочатку заверши PvP (/pvp_stop).');
    return;
  }
  if (penaltyByUser.has(userId)) {
    await ctx.reply('Спочатку заверши серію пенальті (/penalty_stop).');
    return;
  }
  const match = getMatch(userId);
  if (isMatchActive(match) && match.tournament) {
    const t = match.tournament;
    await ctx.reply(
      `📋 **Турнірна сітка**\n\n${formatTournamentBracket(t.defId, t.stageIndex)}\n\n` +
        `▶️ Матч триває: **${formatScore(match)}**. Хід ${match.turn + 1}/${match.maxTurns}.`,
      { parse_mode: 'Markdown', ...fifaMoveKeyboard() }
    );
    return;
  }
  if (isMatchActive(match)) {
    await ctx.reply('Зараз звичайний матч. Заверши /fifa_stop або дограй — потім відкрий турнір.');
    return;
  }
  if (tournamentProgressByUser.has(userId)) {
    const prog = tournamentProgressByUser.get(userId);
    await ctx.reply(
      `📋 **Турнірна сітка**\n\n${formatTournamentBracket(prog.defId, prog.stageIndex)}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('▶️ Продовжити', 'tour:resume')],
          [Markup.button.callback('🗑 Скинути турнір', 'tour:reset')],
        ]),
      }
    );
    return;
  }
  await ctx.reply(
    '**Турніри:** кожен етап — один матч; далі суперник **сильніший** (більший % сили бота).\n\nОбери турнір:',
    { parse_mode: 'Markdown', ...tournamentStartKeyboard() }
  );
}

async function handleTournamentMenu(ctx) {
  await ctx.answerCbQuery();
  await showTournamentPanel(ctx);
}

bot.start(async (ctx) => {
  const name = ctx.from.first_name || 'друже';
  getWallet(ctx.from.id);
  const caption =
    `Привіт, ${name}! Міні-гра «Фіфа» — матч проти бота (${MAX_TURNS} ходів ≈ 90 хв).\n\n` +
    '**Матч:** /fifa, кнопка «▶️ Матч» знизу або інлайн «Новий матч»\n' +
    '**Пенальті:** /penalty\n' +
    '**Магазин:** /shop (паки й сувеніри) · **Склад:** /sklad\n' +
    '**Турнір:** «🏆 Турнір» знизу, інлайн або /tournament\n' +
    '**Цепочка:** «🔗 Цепочка» — daily (усім) та vip (закрита; доступ — /can). Адмін: <code>/can username vip</code>\n' +
    '**Чемпіонат / карʼєра:** «📊 Чемпіонат» або /championship — клуб (ліга), гравець (20 сезонів), **тренер** або **агент** (офіси через меню знизу): перемикання **/swap** (клуб → гравець → тренер → агент)\n' +
    'Зупинити: /fifa_stop, /penalty_stop, /tournament_stop, /league_stop (ліга чи карʼєра гравця залежно від режиму)\n\n' +
    'Захист у матчі: «Відбір», «Блок», «Пресинг» або /tackle, /block, /mark.\n\n' +
    '🔖 У інлайн-меню зверху: **режим карʼєри** (клуб / гравець / тренер / агент) та **❓ Режими карʼєри**.\n\n' +
    '🔽 **Кнопки меню знизу** — швидкий доступ (наступне повідомлення).';
  await ctx.reply(caption, {
    parse_mode: 'Markdown',
    ...mainMenuKeyboard(ctx.from.id),
  });
  await ctx.reply('⌨️ Меню знизу екрана:', bottomMenuReplyKeyboard());
});

bot.command('menu', async (ctx) => {
  await ctx.reply(
    'Обери дію.\n_Інлайн зверху_: режим (**клуб / гравець / тренер / агент**) та **❓ Режими карʼєри**.',
    { parse_mode: 'Markdown', ...mainMenuKeyboard(ctx.from.id) }
  );
  await ctx.reply('⌨️ Меню знизу екрана:', bottomMenuReplyKeyboard());
});

bot.hears(/^📋 Меню$/, async (ctx) => {
  await ctx.reply(
    'Головне меню:\n_Зверху_: активний режим (**клуб** / **гравець** / **тренер** / **агент**) та довідка **❓ Режими карʼєри**.',
    { parse_mode: 'Markdown', ...mainMenuKeyboard(ctx.from.id) }
  );
  await ctx.reply('⌨️ Меню знизу екрана:', bottomMenuReplyKeyboard());
});

bot.hears(/^▶️ Матч$/, async (ctx) => {
  await handleFifaStart(ctx);
});

bot.hears(/^🏆 Турнір$/, async (ctx) => {
  await showTournamentPanel(ctx);
});

bot.hears(/^📊 Чемпіонат$/, async (ctx) => {
  await showLeaguePanel(ctx);
});

bot.hears(/^🎧 Тренер$/, async (ctx) => {
  await openCoachOfficeOrHint(ctx);
});

bot.hears(/^🤝 Агент$/, async (ctx) => {
  await openAgentOfficeOrHint(ctx);
});

bot.hears(/^🔗 Цепочка$/, async (ctx) => {
  await showLoginChainPanel(ctx);
});

bot.hears(/^🛒 Магазин$/, async (ctx) => {
  getWallet(ctx.from.id);
  const w = getWallet(ctx.from.id);
  await ctx.reply(`🛒 **Магазин**\nТвій баланс: **${w.coins}** 🪙\nОбери товар:`, {
    parse_mode: 'Markdown',
    ...shopKeyboard(),
  });
});

bot.hears(/^👥 Склад$/, async (ctx) => {
  getWallet(ctx.from.id);
  await ctx.reply(formatSklad(ctx.from.id), { parse_mode: 'Markdown' });
});

bot.hears(/^🥅 Пенальті$/, async (ctx) => {
  await startPenaltySeries(ctx);
});

bot.hears(/^🔄 Обмін гравцями$/, async (ctx) => {
  if (!transferExchangeEnabled) {
    await ctx.reply('Обмін гравцями зараз вимкнено.');
    return;
  }
  const kb = tradePickOfferKeyboard(ctx.from.id);
  if (!kb) {
    await ctx.reply('У складі немає гравців для обміну. Купи у /shop.');
    return;
  }
  await ctx.reply('Обери **кого віддаєш** (один гравець):', { parse_mode: 'Markdown', ...kb });
});

bot.command('fifa', (ctx) => handleFifaStart(ctx));

bot.command('chain', async (ctx) => {
  await showLoginChainPanel(ctx);
});

bot.action('chain:menu', async (ctx) => {
  await ctx.answerCbQuery();
  await showLoginChainPanel(ctx);
});

bot.action('chain:claim', async (ctx) => {
  await ctx.answerCbQuery();
  await handleChainClaim(ctx, 'daily');
});

bot.action(/^chain:claim:(\w+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await handleChainClaim(ctx, ctx.match[1]);
});

bot.action('chain:close', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Готово. Цепочки — «🔗 Цепочка» або кнопка в меню.');
});

bot.action(/^chain:locked:(\w+)$/, async (ctx) => {
  const chainId = resolveChainId(ctx.match[1]);
  const title = chainId ? CHAIN_DEFS[chainId]?.title : 'Цепочка';
  await ctx.answerCbQuery({
    text: `🔒 ${title} закрита — доступ через /can від власника`,
    show_alert: true,
  });
});

bot.action('vipchain:locked', async (ctx) => {
  await ctx.answerCbQuery({
    text: '🔒 VIP-цепочка закрита — доступ через /can vip від власника',
    show_alert: true,
  });
});

bot.action('vipchain:claim', async (ctx) => {
  await ctx.answerCbQuery();
  await handleChainClaim(ctx, 'vip');
});

bot.action('fifa:new', async (ctx) => {
  await ctx.answerCbQuery();
  await handleFifaStart(ctx);
});

bot.command('fifa_stop', (ctx) => {
  fifaMatchByUser.delete(ctx.from.id);
  tournamentProgressByUser.delete(ctx.from.id);
  leagueByUser.delete(ctx.from.id);
  ctx.reply('Матч / прогрес турніру / лігу скинуто. /fifa або меню у /start.');
});

bot.command('tournament_stop', (ctx) => {
  tournamentProgressByUser.delete(ctx.from.id);
  fifaMatchByUser.delete(ctx.from.id);
  ctx.reply('Турнір і матч скинуто.');
});

bot.command('league_stop', (ctx) => {
  const uid = ctx.from.id;
  fifaMatchByUser.delete(uid);
  if (getCareerMode(uid) === 'player') {
    playerCareerByUser.delete(uid);
    ctx.reply("Кар'єру гравця скинуто. /championship — почати знову.");
    return;
  }
  if (getCareerMode(uid) === 'coach') {
    coachStateByUser.delete(uid);
    ctx.reply('Режим тренера: офіс скинуто (тактика, мораль, втома). /championship — офіс знову.');
    return;
  }
  if (getCareerMode(uid) === 'agent') {
    agentStateByUser.delete(uid);
    ctx.reply('Режим агента: офіс скинуто (репутація, таланти). /championship — офіс знову.');
    return;
  }
  leagueByUser.delete(uid);
  ctx.reply('Чемпіонат (лігу) скинуто. /championship — почати знову.');
});

bot.command('swap', async (ctx) => {
  const uid = ctx.from.id;
  if (getPvpSessionByUser(uid)) {
    await ctx.reply('Заверши спочатку PvP (/pvp_stop).');
    return;
  }
  if (penaltyByUser.has(uid)) {
    await ctx.reply('Заверши спочатку пенальті (/penalty_stop).');
    return;
  }
  if (isMatchActive(getMatch(uid))) {
    await ctx.reply('Заверши спочатку матч (/fifa_stop) або дограй.');
    return;
  }
  if (tournamentProgressByUser.has(uid)) {
    await ctx.reply('Заверши або скинь турнір (/tournament_stop).');
    return;
  }
  if (hasActiveLeague(uid)) {
    await ctx.reply(
      'Спочатку заверши або скинь <b>лігу за клуб</b> (/league_stop), потім /swap.',
      { parse_mode: 'HTML' }
    );
    return;
  }
  if (hasIncompletePlayerCareer(uid)) {
    await ctx.reply(
      'Спочатку заверши або скинь <b>карʼєру гравця</b> (/league_stop у цьому режимі), потім /swap.',
      { parse_mode: 'HTML' }
    );
    return;
  }
  const cycle = ['club', 'player', 'coach', 'agent'];
  const cur = getCareerMode(uid);
  let idx = cycle.indexOf(cur);
  if (idx < 0) idx = 0;
  const next = cycle[(idx + 1) % cycle.length];
  careerModeByUser.set(uid, next);
  if (next === 'player') {
    await ctx.reply(
      '🔁 Режим: <b>карʼєра гравця</b> (20 сезонів).\n/championship — старт або продовження. Далі: /swap → тренер.',
      { parse_mode: 'HTML' }
    );
  } else if (next === 'coach') {
    await ctx.reply(
      '🔁 Режим: <b>тренер</b>.\n/championship — офіс (тактика, тренування). Товариські /fifa та 🏆 турніри без клубної ліги. Далі /swap → агент.',
      { parse_mode: 'HTML' }
    );
  } else if (next === 'agent') {
    await ctx.reply(
      '🔁 Режим: <b>агент</b>.\n/championship або «🤝 Агент» — розвідка талантів, продаж контрактів, репутація. Товариські та турніри без ліги. Далі /swap → клуб.',
      { parse_mode: 'HTML' }
    );
  } else {
    await ctx.reply(
      '🔁 Режим: <b>клуб</b> (ліга, 9 турів).\n/championship — чемпіонат. Інші режими: /swap.',
      { parse_mode: 'HTML' }
    );
  }
});

bot.command('championship', async (ctx) => {
  await showLeaguePanel(ctx);
});

bot.action('tour:menu', async (ctx) => {
  await handleTournamentMenu(ctx);
});

bot.action('league:menu', async (ctx) => {
  await ctx.answerCbQuery();
  await showLeaguePanel(ctx);
});

bot.action('league:new', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  if (getPvpSessionByUser(userId)) {
    await ctx.reply('Спочатку заверши PvP (/pvp_stop).');
    return;
  }
  if (penaltyByUser.has(userId)) {
    await ctx.reply('Спочатку заверши пенальті.');
    return;
  }
  if (tournamentProgressByUser.has(userId)) {
    await ctx.reply('Спочатку заверши кубковий турнір (/tournament_stop).');
    return;
  }
  fifaMatchByUser.delete(userId);

  if (getCareerMode(userId) === 'player') {
    if (hasActiveLeague(userId)) {
      await ctx.reply(
        'Спочатку заверши або скинь <b>лігу за клуб</b> (/swap на клуб, потім /league_stop).',
        { parse_mode: 'HTML' }
      );
      return;
    }
    playerCareerByUser.set(userId, createPlayerCareerState(1));
    await showPlayerCareerPanel(ctx);
    return;
  }

  if (getCareerMode(userId) === 'coach') {
    await ctx.reply(
      'У режимі тренера немає клубної ліги. Перемкни <code>/swap</code> на 🏟 клуб або відкрий офіс через «🎧 Тренер» / «📊 Чемпіонат».',
      { parse_mode: 'HTML' }
    );
    return;
  }

  if (getCareerMode(userId) === 'agent') {
    await ctx.reply(
      'У режимі <b>агента</b> немає клубної ліги. Офіс — «🤝 Агент» або «📊 Чемпіонат». Перемкни <code>/swap</code> на 🏟 клуб.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  if (hasIncompletePlayerCareer(userId)) {
    await ctx.reply(
      'Спочатку заверши або скинь <b>карʼєру гравця</b> (/swap на режим гравця, потім /league_stop).',
      { parse_mode: 'HTML' }
    );
    return;
  }
  leagueByUser.set(userId, { rows: createLeagueRows(userId), round: 0, finished: false });
  await beginLeagueRound(ctx);
});

bot.action('league:play', async (ctx) => {
  await ctx.answerCbQuery();
  if (getCareerMode(ctx.from.id) === 'player') {
    await showPlayerCareerPanel(ctx);
    return;
  }
  if (getCareerMode(ctx.from.id) === 'coach') {
    await showCoachOffice(ctx);
    return;
  }
  if (getCareerMode(ctx.from.id) === 'agent') {
    await showAgentOffice(ctx);
    return;
  }
});

bot.action('league:reset', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  fifaMatchByUser.delete(userId);
  if (getCareerMode(userId) === 'player') {
    playerCareerByUser.delete(userId);
    await ctx.reply('Карʼєру гравця скинуто.');
    return;
  }
  if (getCareerMode(userId) === 'coach') {
    coachStateByUser.delete(userId);
    await ctx.reply('Офіс тренера скинуто (тактика й стан команди на стартових значеннях при наступному відкритті).');
    return;
  }
  if (getCareerMode(userId) === 'agent') {
    agentStateByUser.delete(userId);
    await ctx.reply('Офіс агента скинуто (репутація й список талантів — з нуля при наступному відкритті).');
    return;
  }
  leagueByUser.delete(userId);
  await ctx.reply('Лігу скинуто.');
});

bot.action(/^coach:tactic:(attack|balance|defense)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (getCareerMode(uid) !== 'coach') {
    await ctx.reply('Це меню лише в режимі тренера. Напиши /swap.');
    return;
  }
  const t = ctx.match[1];
  getCoachState(uid).tactic = t;
  const label = t === 'attack' ? '⚡ Атакувальна' : t === 'defense' ? '🛡 Оборонна' : '⚖️ Збалансована';
  await ctx.reply(`Тактика: <b>${label}</b>`, { parse_mode: 'HTML', ...coachMatchPrepKeyboard() });
});

bot.action('coach:hub:match', async (ctx) => {
  await ctx.answerCbQuery();
  if (getCareerMode(ctx.from.id) !== 'coach') {
    await ctx.reply('Це меню лише в режимі тренера. Напиши /swap.');
    return;
  }
  await ctx.reply(
    '<b>⚽ Підготовка до матчу</b>\nОбери <b>схему гри</b> (атака / баланс / оборона) і за потреби зроби <b>заміни</b> перед грою.',
    { parse_mode: 'HTML', ...coachMatchPrepKeyboard() }
  );
});

bot.action('coach:hub:train', async (ctx) => {
  await ctx.answerCbQuery();
  if (getCareerMode(ctx.from.id) !== 'coach') {
    await ctx.reply('Це меню лише в режимі тренера. Напиши /swap.');
    return;
  }
  await ctx.reply(
    '<b>🏋️ Тренування на полі</b>\nПаси, удари, стандарти, пресинг, витривалість — безкоштовно. Частина вправ дає бонус ще на кілька матчів (див. офіс).\nТакож є класичні блоки «схема поля» та «комбінації».',
    { parse_mode: 'HTML', ...coachTrainingKeyboard() }
  );
});

bot.action('coach:hub:root', async (ctx) => {
  await ctx.answerCbQuery();
  if (getCareerMode(ctx.from.id) !== 'coach') {
    await ctx.reply('Це меню лише в режимі тренера. Напиши /swap.');
    return;
  }
  await ctx.reply(
    '<b>🎧 Офіс тренера</b>\nОбери: <b>підготовка до матчу</b> або <b>тренування</b>.',
    { parse_mode: 'HTML', ...coachOfficeRootKeyboard() }
  );
});

bot.action('coach:menu', async (ctx) => {
  await ctx.answerCbQuery();
  await openCoachOfficeOrHint(ctx);
});

bot.action('coach:train', async (ctx) => {
  await ctx.answerCbQuery({ text: 'Обери розділ' });
  const uid = ctx.from.id;
  if (getCareerMode(uid) !== 'coach') {
    await ctx.reply('Це меню лише в режимі тренера. Напиши /swap.');
    return;
  }
  await ctx.reply(
    'Меню оновлено: спочатку <b>матч</b> або <b>тренування</b>, далі детальні кнопки.',
    { parse_mode: 'HTML', ...coachOfficeRootKeyboard() }
  );
});

bot.action('coach:drill:physical', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (getCareerMode(uid) !== 'coach') {
    await ctx.reply('Це меню лише в режимі тренера. Напиши /swap.');
    return;
  }
  getWallet(uid);
  const c = getCoachState(uid);
  c.fatigue = Math.max(0, c.fatigue - 8);
  c.morale = Math.min(100, c.morale + 2);
  await ctx.reply(
    `<b>🏃 Фізичне навантаження.</b> Безкоштовно.\nВтома: <b>${c.fatigue}</b>, мораль: <b>${c.morale}</b>.`,
    { parse_mode: 'HTML', ...coachTrainingKeyboard() }
  );
});

bot.action('coach:drill:tactical', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (getCareerMode(uid) !== 'coach') {
    await ctx.reply('Це меню лише в режимі тренера. Напиши /swap.');
    return;
  }
  getWallet(uid);
  const c = getCoachState(uid);
  c.drillKind = 'tactical';
  c.drillMatchesLeft = 2;
  c.morale = Math.min(100, c.morale + 3);
  await ctx.reply(
    `<b>📋 Схема поля.</b> Безкоштовно.\nДва наступні матчі — сильніший бонус до легкості. Мораль: <b>${c.morale}</b>.`,
    { parse_mode: 'HTML', ...coachTrainingKeyboard() }
  );
});

bot.action('coach:drill:technical', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (getCareerMode(uid) !== 'coach') {
    await ctx.reply('Це меню лише в режимі тренера. Напиши /swap.');
    return;
  }
  getWallet(uid);
  const c = getCoachState(uid);
  c.drillKind = 'technical';
  c.drillMatchesLeft = 2;
  c.fatigue = Math.max(0, c.fatigue - 3);
  c.morale = Math.min(100, c.morale + 4);
  await ctx.reply(
    `<b>⚽ Комбінації.</b> Безкоштовно.\nДва матчі — середній бонус до легкості. Втома: <b>${c.fatigue}</b>, мораль: <b>${c.morale}</b>.`,
    { parse_mode: 'HTML', ...coachTrainingKeyboard() }
  );
});

bot.action('coach:subs', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (getCareerMode(uid) !== 'coach') {
    await ctx.reply('Це меню лише в режимі тренера. Напиши /swap.');
    return;
  }
  const c = getCoachState(uid);
  if (!c.subsFresh) {
    await ctx.reply('Заміни вже використані — зіграй матч, щоб знову освіжити склад.', {
      parse_mode: 'HTML',
      ...coachMatchPrepKeyboard(),
    });
    return;
  }
  getWallet(uid);
  c.fatigue = Math.max(0, c.fatigue - 7);
  c.morale = Math.min(100, c.morale + 3);
  c.subsFresh = false;
  await ctx.reply(
    `<b>🔁 Заміни.</b> Безкоштовно.\nСвіжі ноги перед матчем. Втома: <b>${c.fatigue}</b>, мораль: <b>${c.morale}</b>. Наступні заміни — після матчу.`,
    { parse_mode: 'HTML', ...coachMatchPrepKeyboard() }
  );
});

bot.action('coach:tr:end', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (getCareerMode(uid) !== 'coach') {
    await ctx.reply('Це меню лише в режимі тренера. Напиши /swap.');
    return;
  }
  getWallet(uid);
  const c = getCoachState(uid);
  c.fatigue = Math.max(0, c.fatigue - 8);
  c.morale = Math.min(100, c.morale + 2);
  await ctx.reply(
    `<b>🏃 Витривалість.</b> Безкоштовно.\nБігові вправи — менша втома, трохи краща мораль. Без бонусу «на кілька матчів».\nВтома: <b>${c.fatigue}</b>, мораль: <b>${c.morale}</b>.`,
    { parse_mode: 'HTML', ...coachTrainingKeyboard() }
  );
});

bot.action('coach:tr:pass', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (getCareerMode(uid) !== 'coach') {
    await ctx.reply('Це меню лише в режимі тренера. Напиши /swap.');
    return;
  }
  getWallet(uid);
  const c = getCoachState(uid);
  c.drillKind = 'passes';
  c.drillMatchesLeft = 2;
  c.morale = Math.min(100, c.morale + 3);
  await ctx.reply(
    `<b>🔁 Паси й комбінації.</b> Безкоштовно.\nДва матчі — середній бонус до легкості. Мораль: <b>${c.morale}</b>.`,
    { parse_mode: 'HTML', ...coachTrainingKeyboard() }
  );
});

bot.action('coach:tr:finish', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (getCareerMode(uid) !== 'coach') {
    await ctx.reply('Це меню лише в режимі тренера. Напиши /swap.');
    return;
  }
  getWallet(uid);
  const c = getCoachState(uid);
  c.drillKind = 'finishing';
  c.drillMatchesLeft = 2;
  c.fatigue = Math.max(0, c.fatigue - 2);
  c.morale = Math.min(100, c.morale + 4);
  await ctx.reply(
    `<b>🎯 Удари й завершення.</b> Безкоштовно.\nДва матчі — середній бонус. Втома: <b>${c.fatigue}</b>, мораль: <b>${c.morale}</b>.`,
    { parse_mode: 'HTML', ...coachTrainingKeyboard() }
  );
});

bot.action('coach:tr:set', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (getCareerMode(uid) !== 'coach') {
    await ctx.reply('Це меню лише в режимі тренера. Напиши /swap.');
    return;
  }
  getWallet(uid);
  const c = getCoachState(uid);
  c.drillKind = 'setpieces';
  c.drillMatchesLeft = 2;
  c.morale = Math.min(100, c.morale + 2);
  await ctx.reply(
    `<b>📌 Стандарти.</b> Безкоштовно.\nДва матчі — сильніший бонус до легкості. Мораль: <b>${c.morale}</b>.`,
    { parse_mode: 'HTML', ...coachTrainingKeyboard() }
  );
});

bot.action('coach:tr:press', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (getCareerMode(uid) !== 'coach') {
    await ctx.reply('Це меню лише в режимі тренера. Напиши /swap.');
    return;
  }
  getWallet(uid);
  const c = getCoachState(uid);
  c.drillKind = 'pressing';
  c.drillMatchesLeft = 2;
  c.fatigue = Math.max(0, c.fatigue - 1);
  c.morale = Math.min(100, c.morale + 3);
  await ctx.reply(
    `<b>📋 Пресинг.</b> Безкоштовно.\nДва матчі — сильніший бонус до легкості. Втома: <b>${c.fatigue}</b>, мораль: <b>${c.morale}</b>.`,
    { parse_mode: 'HTML', ...coachTrainingKeyboard() }
  );
});

bot.action('coach:close', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Готово. Матч — ▶️ Матч, турнір — меню, офіс тренера — «🎧 Тренер», «📊 Чемпіонат» або «🎧 Офіс тренера».');
});

bot.action('agent:menu', async (ctx) => {
  await ctx.answerCbQuery();
  await openAgentOfficeOrHint(ctx);
});

bot.action('agent:scout', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (getCareerMode(uid) !== 'agent') {
    await ctx.reply('Це меню лише в режимі агента. Напиши /swap.');
    return;
  }
  const a = getAgentState(uid);
  if (a.prospects.length >= AGENT_ROSTER_MAX) {
    await ctx.reply(
      `<b>Ростер повний</b> (${AGENT_ROSTER_MAX}/${AGENT_ROSTER_MAX}). Спочатку продай талант кнопкою 💼.`,
      { parse_mode: 'HTML', ...agentOfficeKeyboard(uid) }
    );
    return;
  }
  const rep = a.reputation;
  if (Math.random() < agentScoutFailChance(rep)) {
    await ctx.reply(randomAgentScoutMissLine(), { parse_mode: 'HTML', ...agentOfficeKeyboard(uid) });
    return;
  }
  const p = rollAgentProspectOnHit(uid);
  a.prospects.push(p);
  await ctx.reply(
    `<b>🔍 Новий талант:</b> ${escapeHtml(p.first)} ${escapeHtml(p.last)}, OVR <b>${p.ovr}</b>, ${escapeHtml(p.potential)}.`,
    { parse_mode: 'HTML', ...agentOfficeKeyboard(uid) }
  );
});

bot.action(/^agent:sell:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (getCareerMode(uid) !== 'agent') {
    await ctx.reply('Це меню лише в режимі агента. Напиши /swap.');
    return;
  }
  const idx = parseInt(ctx.match[1], 10);
  const a = getAgentState(uid);
  if (idx < 0 || idx >= a.prospects.length) {
    await ctx.reply('Такого номера в списку вже немає — онови офіс.', { parse_mode: 'HTML', ...agentOfficeKeyboard(uid) });
    return;
  }
  const [p] = a.prospects.splice(idx, 1);
  const w = getWallet(uid);
  const rep = a.reputation;
  const base = p.ovr * 5 + 18 + Math.floor(Math.random() * 38) + Math.floor(rep / 3);
  const prestigeCut = Math.floor((p.ovr * rep) / 72);
  const pay = base + prestigeCut;
  w.coins += pay;
  a.reputation = Math.min(100, a.reputation + 2 + (p.ovr >= 78 ? 1 : 0));
  await ctx.reply(
    `<b>💼 Угода:</b> ${escapeHtml(p.first)} ${escapeHtml(p.last)} → клуб.\n+<b>${pay}</b> 🪙 <i>(база + престиж × OVR)</i> · репутація <b>${a.reputation}</b>. Баланс: <b>${w.coins}</b> 🪙`,
    { parse_mode: 'HTML', ...agentOfficeKeyboard(uid) }
  );
});

bot.action('agent:network', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (getCareerMode(uid) !== 'agent') {
    await ctx.reply('Це меню лише в режимі агента. Напиши /swap.');
    return;
  }
  const a = getAgentState(uid);
  const gain = Math.random() < 0.38 ? 2 : 1;
  a.reputation = Math.min(100, a.reputation + gain);
  await ctx.reply(
    `<b>📇 Мережа клубів.</b> Обід із директорами та скаутами — контакти свіжі.\nРепутація <b>+${gain}</b> (тепер <b>${a.reputation}</b>).`,
    { parse_mode: 'HTML', ...agentOfficeKeyboard(uid) }
  );
});

bot.action('agent:close', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Готово. Офіс агента — «🤝 Агент», «📊 Чемпіонат» або «🤝 Офіс агента» в меню.');
});

bot.action('menu:mode_tip', async (ctx) => {
  const m = getCareerMode(ctx.from.id);
  await ctx.answerCbQuery({
    text:
      m === 'club'
        ? '🏟 Клуб — «📊 Чемпіонат», ліга 9 турів'
        : m === 'player'
          ? '👤 Гравець — /championship, 20 сезонів'
          : m === 'coach'
            ? '🎧 Тренер — «🎧 Тренер» / «📊 Чемпіонат», /fifa та турнір'
            : '🤝 Агент — «🤝 Агент» / «📊 Чемпіонат», розвідка й контракти',
  });
});

bot.action('menu:modes_help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    '<b>Режими карʼєри</b> (перемикання — <code>/swap</code>: клуб → гравець → тренер → агент → клуб, якщо немає активних матчів і незавершеної карʼєри гравця)\n\n' +
      '🏟 <b>За клуб</b> — чемпіонат із таблицею (9 турів).\n\n' +
      '👤 <b>За гравця</b> — спершу обираєш відомого гравця (можна «Інші зірки»), потім контракт із пропозицій клубів, у т. ч. топ-клубів Європи; між сезонами — нові офери. Під час карʼєри росте <b>вік</b>, <b>OVR</b> може підвищуватися й падати залежно від результатів і сезону. За рік симулюються ліга, кубок, єврокубок і <b>чемпіонат світу</b>; у фіналі — <b>симулювати</b> або <b>грати</b>. За результати сезону можливі особисті нагороди (Золотий м’яч тощо, трофеї в /sklad), у підсумку сезону показані <b>завдання карʼєри</b> — бонус монетами при «Наступний сезон». Після 20 сезонів — розгорнутий звіт.\n\n' +
      '🎧 <b>Тренер</b> — офіс: «🎧 Тренер», «📊 Чемпіонат» або «🎧 Офіс тренера». Спочатку дві гілки: <b>підготовка до матчу</b> (схема, заміни, старт матчу) і <b>тренування</b> (паси, удари, стандарти, пресинг, витривалість тощо). Тренування й заміни безкоштовно; частина вправ дає бонус на кілька матчів. Без клубної ліги; товариські матчі та турніри. Після матчів росте втома й змінюється мораль.\n\n' +
      '🤝 <b>Агент</b> — офіс: «🤝 Агент», «📊 Чемпіонат» або «🤝 Офіс агента». <b>Репутація</b> відкриває рівні (новачок → еліта), зменшує провали розвідки, піднімає стелю OVR і шанс «топ-потенціалу», збільшує комісію при продажі (бонус від rep × OVR) і посилює легкість матчів проти бота. Розвідка часто без результату — качай rep перемогами, угодами та «мережею клубів».\n\n' +
      '<i>Верхні інлайн-кнопки показують активний режим.</i>',
    { parse_mode: 'HTML' }
  );
});

bot.action('pc:sim', async (ctx) => {
  await ctx.answerCbQuery({ text: 'Симуляція…' });
  await runCareerSimulationStep(ctx);
});

bot.action('pc:fsim', async (ctx) => {
  await ctx.answerCbQuery();
  await runCareerFinalSimStep(ctx);
});

bot.action('pc:fplay', async (ctx) => {
  await ctx.answerCbQuery();
  await beginPlayerCareerFinalMatch(ctx);
});

bot.action('pc:next', async (ctx) => {
  await ctx.answerCbQuery();
  await advanceCareerAfterSeasonOutro(ctx);
});

bot.action(/^pc:ctr:(\w+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await applyCareerContractChoice(ctx, ctx.match[1]);
});

bot.action(/^pc:pfp:([\w]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await applyCareerPlayerChoice(ctx, ctx.match[1]);
});

bot.action('pc:pfr', async (ctx) => {
  await ctx.answerCbQuery();
  const pc = playerCareerByUser.get(ctx.from.id);
  if (!pc || pc.phase !== 'pick_player') return;
  const picks = pickDistinctCareerPlayersForOffers(3);
  pc.playerOffers = picks.map((p) => ({
    key: p.key,
    name: p.name,
    baseOvr: p.baseOvr,
    startAge: p.startAge,
  }));
  await ctx.reply('Інші кандидати:', { parse_mode: 'HTML', ...careerPlayerPickKeyboard(pc) });
});

bot.action(/^tour:start:([\w]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const defId = ctx.match[1];
  if (!getTournamentDef(defId)) {
    await ctx.reply('Невідомий турнір.');
    return;
  }
  const userId = ctx.from.id;
  if (careerBarsTournamentOrFriendly(userId)) {
    await ctx.reply(
      'Спочатку заверши <b>лігу</b> або <b>карʼєру гравця</b> (/league_stop) або продовж через /championship.',
      { parse_mode: 'HTML' }
    );
    return;
  }
  if (getPvpSessionByUser(userId)) {
    await ctx.reply('Спочатку заверши PvP (/pvp_stop).');
    return;
  }
  if (penaltyByUser.has(userId)) {
    await ctx.reply('Спочатку заверши пенальті.');
    return;
  }
  if (isMatchActive(getMatch(userId))) {
    await ctx.reply('Спочатку заверши поточний матч.');
    return;
  }
  tournamentProgressByUser.delete(userId);
  await beginTournamentRound(ctx, defId, 0);
});

bot.action('tour:resume', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  if (careerBarsTournamentOrFriendly(userId)) {
    await ctx.reply(
      'Спочатку заверши <b>лігу</b> або <b>карʼєру гравця</b> (/league_stop) або продовж через /championship.',
      { parse_mode: 'HTML' }
    );
    return;
  }
  if (getPvpSessionByUser(userId)) {
    await ctx.reply('Спочатку заверши PvP (/pvp_stop).');
    return;
  }
  const prog = tournamentProgressByUser.get(userId);
  if (!prog) {
    await ctx.reply('Немає турніру для продовження. Відкрий «Турнір (сітка)».');
    return;
  }
  if (penaltyByUser.has(userId)) {
    await ctx.reply('Спочатку заверши пенальті.');
    return;
  }
  if (isMatchActive(getMatch(userId))) {
    await ctx.reply('Матч уже йде.');
    return;
  }
  await beginTournamentRound(ctx, prog.defId, prog.stageIndex);
});

bot.action('tour:reset', async (ctx) => {
  await ctx.answerCbQuery();
  tournamentProgressByUser.delete(ctx.from.id);
  fifaMatchByUser.delete(ctx.from.id);
  await ctx.reply('Турнір скинуто.');
});

bot.action('tour:cancel', async (ctx) => {
  await ctx.answerCbQuery();
});

bot.command('tournament', async (ctx) => {
  await showTournamentPanel(ctx);
});

bot.command('sklad', (ctx) => {
  getWallet(ctx.from.id);
  ctx.reply(formatSklad(ctx.from.id), { parse_mode: 'Markdown' });
});

bot.action('sklad:open', async (ctx) => {
  await ctx.answerCbQuery();
  getWallet(ctx.from.id);
  await ctx.reply(formatSklad(ctx.from.id), { parse_mode: 'Markdown' });
});

bot.command('shop', async (ctx) => {
  getWallet(ctx.from.id);
  const w = getWallet(ctx.from.id);
  await ctx.reply(`🛒 **Магазин**\nТвій баланс: **${w.coins}** 🪙\nОбери товар:`, {
    parse_mode: 'Markdown',
    ...shopKeyboard(),
  });
});

bot.action('shop:open', async (ctx) => {
  await ctx.answerCbQuery();
  const w = getWallet(ctx.from.id);
  await ctx.reply(`🛒 **Магазин**\nТвій баланс: **${w.coins}** 🪙\nОбери товар:`, {
    parse_mode: 'Markdown',
    ...shopKeyboard(),
  });
});

bot.action('shop:nop', async (ctx) => {
  await ctx.answerCbQuery('Обери рядок нижче');
});

bot.action(/^shop:pack:([\w]+)$/, async (ctx) => {
  const packId = ctx.match[1];
  const pack = SHOP_PACKS.find((p) => p.id === packId);
  await ctx.answerCbQuery({ text: '📦 Відкриваємо…' });
  if (!pack) {
    await ctx.reply('Такого паку немає.');
    return;
  }
  const userId = ctx.from.id;
  const w = getWallet(userId);
  const unowned = getUnownedShopPlayerIds(userId);
  if (!unowned.length) {
    await ctx.reply('У тебе вже є всі гравці з магазину — пак не має сенсу.');
    return;
  }
  if (w.coins < pack.price) {
    await ctx.reply(`Не вистачає монет (потрібно ${pack.price}, є ${w.coins}).`);
    return;
  }

  const pickedId = pickRandomPackPlayerId(packId, userId);
  if (!pickedId) {
    await ctx.reply('Немає доступних гравців для паку.');
    return;
  }
  const won = getPlayerMeta(pickedId);
  if (!won) return;

  w.coins -= pack.price;

  const teaserNames = SHOP_PLAYERS.map((p) => p.name);
  const openMsg = await ctx.reply('<b>📦 Відкриття паку…</b>', { parse_mode: 'HTML' });
  await playPackOpeningAnimation(ctx.telegram, ctx.chat.id, openMsg.message_id, teaserNames, won);
  addPlayerToSquad(userId, pickedId);
  await ctx.reply(
    `Пак: <b>${escapeHtml(pack.name)}</b> (−${pack.price} 🪙)\n` +
      `У склад: <b>${escapeHtml(won.name)}</b> (${won.rating} OVR)\n` +
      `Баланс: <b>${w.coins}</b> 🪙\n/sklad`,
    { parse_mode: 'HTML' }
  );
});

bot.action(/^shop:buy:([\w]+)$/, async (ctx) => {
  const id = ctx.match[1];
  const item = SHOP_ITEMS.find((x) => x.id === id);
  const player = SHOP_PLAYERS.find((p) => p.id === id);
  await ctx.answerCbQuery();
  if (!item && !player) {
    await ctx.reply('Такого товару немає.');
    return;
  }
  if (player && !item) {
    await ctx.reply(
      'Пряма покупка гравців у магазині вимкнена. Отримай карти з **паків** у /shop.',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  const userId = ctx.from.id;
  const w = getWallet(userId);
  const price = item.price;
  const label = item.name;
  const note = item.note;

  if (w.coins < price) {
    await ctx.reply(`Не вистачає монет (потрібно ${price}, є ${w.coins}). Зіграй матч або пенальті.`);
    return;
  }
  w.coins -= price;
  addInventory(userId, item.id, 1);
  await ctx.reply(
    `Куплено: **${label}** (−${price} 🪙)\n_${note}_\nБаланс: **${w.coins}** 🪙\n/sklad — подивитись склад.`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('shop:close', async (ctx) => {
  await ctx.answerCbQuery('Ок');
});

bot.action(/^tr:ofr:([\w]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!transferExchangeEnabled) {
    await ctx.editMessageText('Режим обміну вимкнено.');
    return;
  }
  const uid = ctx.from.id;
  const pid = ctx.match[1];
  if (!hasPlayer(uid, pid)) {
    await ctx.editMessageText('Цього гравця вже немає у складі.');
    return;
  }
  tradeOfferDraft.set(uid, pid);
  const meta = getPlayerMeta(pid);
  await ctx.editMessageText(
    `Обрано: **${meta?.name || pid}**\n\nНадішли **Telegram id** партнера однією командою:\n\`/trade_partner 123456789\`\n\n` +
      'Партнер має хоч раз написати боту. Скинути чернетку: `/trade_cancel`.',
    { parse_mode: 'Markdown' }
  );
});

bot.action('tr:cancel', async (ctx) => {
  await ctx.answerCbQuery();
  tradeOfferDraft.delete(ctx.from.id);
  await ctx.editMessageText('Чернетку скасовано.');
});

bot.action(/^tr:no:(\d+)$/, async (ctx) => {
  const propId = parseInt(ctx.match[1], 10);
  const pr = tradeProposals.get(propId);
  if (!pr || pr.toId !== ctx.from.id) {
    await ctx.answerCbQuery('Не твоя заявка');
    return;
  }
  await ctx.answerCbQuery();
  tradeProposals.delete(propId);
  await ctx.editMessageText('Ти відмовився від обміну.');
  try {
    await ctx.telegram.sendMessage(pr.fromId, '🔄 Партнер відмовився від обміну.');
  } catch {
    /* ignore */
  }
});

bot.action(/^tr:yes:(\d+):([\w]+)$/, async (ctx) => {
  const propId = parseInt(ctx.match[1], 10);
  const bGiveId = ctx.match[2];
  const pr = tradeProposals.get(propId);
  if (!pr || pr.toId !== ctx.from.id) {
    await ctx.answerCbQuery('Недійсна заявка');
    return;
  }
  if (!transferExchangeEnabled) {
    await ctx.answerCbQuery('Режим обміну вимкнено');
    return;
  }
  const { fromId: aid, fromPlayerId: aGive } = pr;
  if (!hasPlayer(aid, aGive)) {
    tradeProposals.delete(propId);
    await ctx.answerCbQuery();
    await ctx.editMessageText('Заявка прострочена: у ініціатора вже немає того гравця.');
    return;
  }
  if (!hasPlayer(pr.toId, bGiveId)) {
    await ctx.answerCbQuery('Такого гравця у тебе немає');
    return;
  }
  const metaA = getPlayerMeta(aGive);
  const metaB = getPlayerMeta(bGiveId);
  removePlayerFromSquad(aid, aGive);
  removePlayerFromSquad(pr.toId, bGiveId);
  addPlayerToSquad(aid, bGiveId);
  addPlayerToSquad(pr.toId, aGive);
  tradeProposals.delete(propId);
  await ctx.answerCbQuery('Обмін виконано');
  await ctx.editMessageText(
    `✅ Обмін завершено:\nти віддав **${metaB?.name || bGiveId}** і отримав **${metaA?.name || aGive}**.`,
    { parse_mode: 'Markdown' }
  );
  try {
    await ctx.telegram.sendMessage(
      aid,
      `✅ Обмін завершено:\nти віддав **${metaA?.name || aGive}** і отримав **${metaB?.name || bGiveId}**.`,
      { parse_mode: 'Markdown' }
    );
  } catch {
    /* ignore */
  }
});

bot.command('trade_cancel', async (ctx) => {
  tradeOfferDraft.delete(ctx.from.id);
  await ctx.reply('Чернетку обміну скинуто.');
});

bot.command('trade_partner', async (ctx) => {
  if (!transferExchangeEnabled) {
    await ctx.reply('Режим обміну вимкнено.');
    return;
  }
  const uid = ctx.from.id;
  const giveId = tradeOfferDraft.get(uid);
  if (!giveId) {
    await ctx.reply('Спочатку натисни «🔄 Обмін гравцями» та обери гравця з кнопок.');
    return;
  }
  const rest = (ctx.message?.text || '').replace(/^\/trade_partner(@[A-Za-z0-9_]+)?\s*/i, '').trim();
  const tok = rest.split(/\s+/).filter(Boolean)[0];
  const partnerId = parseInt(tok, 10);
  if (!Number.isFinite(partnerId) || tok !== String(partnerId)) {
    await ctx.reply('Формат: `/trade_partner 123456789` (одне число — id друга в Telegram).', {
      parse_mode: 'Markdown',
    });
    return;
  }
  if (partnerId === uid) {
    await ctx.reply('Не можна обмінятися з самим собою.');
    return;
  }
  if (!hasPlayer(uid, giveId)) {
    tradeOfferDraft.delete(uid);
    await ctx.reply('Гравця більше немає у складі. Почни знову.');
    return;
  }
  const wB = getWallet(partnerId);
  const bSquad = Object.keys(wB.squad || {}).filter((p) => (wB.squad[p] || 0) > 0);
  if (!bSquad.length) {
    await ctx.reply('У цього користувача немає гравців у складі — він не зможе віддати картку.');
    return;
  }
  const propId = tradeProposalSeq++;
  const fromMeta = getPlayerMeta(giveId);
  tradeProposals.set(propId, { fromId: uid, toId: partnerId, fromPlayerId: giveId });
  tradeOfferDraft.delete(uid);

  const rows = [];
  for (const q of bSquad) {
    const m = getPlayerMeta(q);
    const label = (m ? `${m.name} (${m.rating})` : q).slice(0, 54);
    rows.push([Markup.button.callback(label, `tr:yes:${propId}:${q}`)]);
  }
  rows.push([Markup.button.callback('Відмова', `tr:no:${propId}`)]);

  const who = escapeMarkdownV1(formatPlayerLabel(uid));
  const offerName = escapeMarkdownV1(fromMeta?.name || giveId);
  const body =
    `🔄 **Запит на обмін**\n${who} пропонує: **${offerName}**\n\nОбери гравця, якого **ти віддаєш** у відповідь, або «Відмова».`;

  try {
    await ctx.telegram.sendMessage(partnerId, body, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(rows),
    });
    await ctx.reply(`Запит надіслано користувачу \`${partnerId}\`. Очікуй відповіді.`, { parse_mode: 'Markdown' });
  } catch {
    tradeProposals.delete(propId);
    await ctx.reply(
      `Не вдалося написати id \`${partnerId}\`. Невірний id або користувач не відкривав чат із ботом.`,
      { parse_mode: 'Markdown' }
    );
  }
});

bot.command('penalty', (ctx) => startPenaltySeries(ctx));

bot.action('pen:new', async (ctx) => {
  await ctx.answerCbQuery();
  await startPenaltySeries(ctx);
});

bot.command('penalty_stop', (ctx) => {
  if (penaltyByUser.delete(ctx.from.id)) {
    ctx.reply('Серію пенальті скинуто.');
  } else {
    ctx.reply('Немає активної серії пенальті.');
  }
});

bot.action(/^pen:sh:(left|center|right)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await handlePenaltyShoot(ctx, ctx.match[1]);
});

bot.action(/^pen:sv:(left|center|right)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await handlePenaltySave(ctx, ctx.match[1]);
});

function pvpHelpHtml(extraErrLine = '') {
  return (
    '<b>PvP</b> (не в меню — лише командами) — двоє по черзі.\n\n' +
    '<b>За Telegram id:</b>\n<code>/pvp 123456789 987654321</code>\n<code>/pvp 123 vs 987</code>\n\n' +
    '<b>За @username</b> (обидва писали боту):\n<code>/pvp @user1 @user2</code>\n<code>/pvp user1 vs user2</code>\n\n' +
    '<b>За номером</b> (кожен: <code>/pvp_contact</code> → поділитися номером):\n' +
    '<code>/pvp +380671112233 +380501112200</code>\n<code>/pvp 0671112233 vs 0501112200</code>\n\n' +
    '<b>Скасувати:</b> учасник — <code>/pvp_stop</code> · адмін — <code>/pvp_stop id1 id2</code> або один <code>/pvp_stop</code>, якщо лише одна сесія.' +
    extraErrLine
  );
}

async function handlePvpStart(ctx) {
  const r = resolvePvpPairFromText(ctx.message?.text || '');
  if (!r.ids) {
    const errBlock = r.error ? `\n\n⚠️ ${escapeHtml(r.error)}` : '';
    await ctx.reply(pvpHelpHtml(errBlock), { parse_mode: 'HTML' });
    return;
  }
  const [id1, id2] = r.ids;
  for (const pid of [id1, id2]) {
    if (getPvpSessionByUser(pid)) {
      await ctx.reply(`Користувач \`${pid}\` уже в іншому PvP.`, { parse_mode: 'Markdown' });
      return;
    }
    if (isMatchActive(getMatch(pid))) {
      await ctx.reply(`Користувач \`${pid}\` зараз у матчі /fifa.`, { parse_mode: 'Markdown' });
      return;
    }
    if (penaltyByUser.has(pid)) {
      await ctx.reply(`Користувач \`${pid}\` у серії пенальті.`, { parse_mode: 'Markdown' });
      return;
    }
  }
  const sid = `pvp_${Date.now()}`;
  const session = {
    sessionId: sid,
    playerIds: [id1, id2],
    scores: [0, 0],
    currentIdx: 0,
    moveNum: 0,
    maxTurns: MAX_TURNS,
    possession: 'you',
    liveAnimMsgByPlayer: new Map(),
  };
  pvpSessions.set(sid, session);
  pvpUserToSession.set(id1, sid);
  pvpUserToSession.set(id2, sid);

  const n1h = formatPlayerLabelHtml(id1);
  const n2h = formatPlayerLabelHtml(id2);
  const intro =
    `⚔️ <b>PvP</b>\n${n1h} <b>vs</b> ${n2h}\nХодів: <b>${MAX_TURNS}</b> (по черзі).\n\n` +
    `Перший хід: ${n1h}\nТі самі дії: /pass, /cross, /shoot, /tackle, /block, /mark або кнопки нижче.\n` +
    `Скасувати: <code>/pvp_stop</code> (учасник) або <code>/pvp_stop ${id1} ${id2}</code> (адмін).`;

  await ctx.reply(`✅ Старт PvP відправлено обом гравцям.\n\n${intro}`, { parse_mode: 'HTML' });

  const turnLine = `Хід <b>1/${MAX_TURNS}</b> — обери кнопкою або команду:`;
  try {
    await postPvpMatchLiveBoard(
      ctx.telegram,
      session,
      id1,
      `${intro}\n\n${turnLine}`,
      { ...pvpMoveKeyboard() }
    );
  } catch {
    await ctx.reply(
      `Не вдалося написати першому гравцю (<code>${id1}</code>). Нехай він напише боту /start.`,
      { parse_mode: 'HTML' }
    );
    destroyPvpSession(session);
    return;
  }
  try {
    await postPvpMatchLiveBoard(
      ctx.telegram,
      session,
      id2,
      `${intro}\n\n<i>Очікуй хід суперника (${n1h}).</i>`,
      {}
    );
  } catch {
    try {
      await ctx.telegram.sendMessage(
        id1,
        '⚔️ <b>PvP скасовано:</b> другий гравець не отримує повідомлення від бота (не натиснув /start або заблокував бота).',
        { parse_mode: 'HTML' }
      );
    } catch {
      /* ignore */
    }
    destroyPvpSession(session);
    await ctx.reply(
      `Другому гравцю (<code>${id2}</code>) <b>не вдалося надіслати</b> повідомлення — матч <b>не</b> стартує.\n` +
        'Нехай він відкриє чат із ботом і надішле <b>/start</b>, після чого повтори <code>/pvp …</code>.',
      { parse_mode: 'HTML' }
    );
  }
}

async function playTurnPvP(ctx, action) {
  const uid = ctx.from.id;
  const session = getPvpSessionByUser(uid);
  if (!session) {
    await ctx.reply('Немає активного PvP. Дивись /pvp (id або номер після /pvp_contact).');
    return;
  }
  const myIdx = session.playerIds[0] === uid ? 0 : 1;
  if (myIdx !== session.currentIdx) {
    await ctx.reply('Зараз не твій хід — дочекайся суперника.');
    return;
  }
  const oppIdx = 1 - myIdx;
  const ease = matchEaseCombined(uid);
  const result = resolveTurn(action, 0, ease);
  session.scores[myIdx] += result.you;
  session.scores[oppIdx] += result.them;
  session.moveNum += 1;
  session.possession = decideNextPossession(action, result, session.possession);
  session.currentIdx = oppIdx;
  const pidOther = session.playerIds[session.currentIdx];
  const nOtherHtml = formatPlayerLabelHtml(pidOther);

  let msg =
    `${escapeHtml(result.text)}\n` +
    `Рахунок: <b>${escapeHtml(formatPvPScore(session))}</b>. Хвилина ~${minuteLabel(session.moveNum)}.\n` +
    `${escapeHtml(possessionLabel(session))}`;

  if (session.moveNum >= session.maxTurns) {
    const [a, b] = session.playerIds;
    const [s0, s1] = session.scores;
    destroyPvpSession(session);
    let finale = '';
    if (s0 > s1) {
      finale = `\n🏆 <b>Переможець:</b> ${formatPlayerLabelHtml(a)} (<b>${s0} : ${s1}</b>)`;
      addCoins(a, 25);
      addCoins(b, 8);
    } else if (s1 > s0) {
      finale = `\n🏆 <b>Переможець:</b> ${formatPlayerLabelHtml(b)} (<b>${s0} : ${s1}</b>)`;
      addCoins(b, 25);
      addCoins(a, 8);
    } else {
      finale = `\n🤝 <b>Нічия</b> ${s0} : ${s1}`;
      addCoins(a, 14);
      addCoins(b, 14);
    }
    const tail = '\n\n+монети за PvP нараховано.';
    await ctx.reply(msg + finale + tail, { parse_mode: 'HTML' });
    try {
      await ctx.telegram.sendMessage(pidOther, msg + finale + tail, { parse_mode: 'HTML' });
    } catch {
      /* ignore */
    }
    return;
  }

  const nextNum = session.moveNum + 1;
  await postPvpMatchLiveBoard(
    ctx.telegram,
    session,
    ctx.from.id,
    `${msg}\n\nХід передається <b>${nOtherHtml}</b> (наступний ${nextNum}/${session.maxTurns}).`,
    {}
  );
  try {
    await postPvpMatchLiveBoard(
      ctx.telegram,
      session,
      pidOther,
      `${msg}\n\n⚡ <b>Твій хід</b> ${nextNum}/${session.maxTurns}`,
      { ...pvpMoveKeyboard() }
    );
  } catch {
    await ctx.reply(`Не вдалося написати ${nOtherHtml} — нехай відкриє чат із ботом.`, { parse_mode: 'HTML' });
  }
}

async function dispatchMove(ctx, action) {
  if (getPvpSessionByUser(ctx.from.id)) {
    await playTurnPvP(ctx, action);
    return;
  }
  await playTurn(ctx, action);
}

async function playTurn(ctx, action) {
  const userId = ctx.from.id;
  const state = getMatch(userId);
  if (!isMatchActive(state)) {
    await ctx.reply('Немає активного матчу. Почни: /fifa або кнопку «Новий матч».');
    return;
  }

  const botStr = state.tournament?.strength ?? state.league?.strength ?? state.playerSeason?.strength ?? 0;
  const ease = matchEaseCombined(userId);
  const result = resolveTurn(action, botStr, ease);
  state.you += result.you;
  state.them += result.them;
  state.turn += 1;
  state.possession = decideNextPossession(action, result, state.possession);

  let msg =
    `${result.text}\n` +
    `Рахунок: ${formatScore(state)}. Хвилина ~${minuteLabel(state.turn)}.\n` +
    `${possessionLabel(state)}.`;

  if (state.turn >= state.maxTurns) {
    const draw = state.you === state.them;
    const regYou = state.you;
    const regThem = state.them;
    const tour = state.tournament ? { ...state.tournament } : null;
    const leagueSnap = state.league ? { ...state.league, regYou, regThem } : null;
    const psSnap = state.playerSeason ? { ...state.playerSeason, regYou, regThem } : null;
    fifaMatchByUser.delete(userId);

    if (draw) {
      msg += `\n🤝 **Нічия** ${formatScore({ you: regYou, them: regThem })} у основний час.\nДалі — серія пенальті!`;
      await ctx.reply(msg, { parse_mode: 'Markdown' });
      await startPenaltySeries(ctx, {
        fromMatchDraw: true,
        tournamentMeta: tour,
        leagueMeta: leagueSnap,
        playerSeasonMeta: psSnap,
      });
      return;
    }

    if (tour) {
      const def = getTournamentDef(tour.defId);
      if (def && state.you > state.them) {
        const nextIdx = tour.stageIndex + 1;
        msg += `\n⚽ **${formatScore(state)}** — ти проходиш **${tour.label}**!`;
        if (nextIdx >= def.stages.length) {
          tournamentProgressByUser.delete(userId);
          addCoins(userId, def.finalBonus + 10);
          const tid = trophyIdForTournamentDefId(tour.defId);
          let trophyExtra = '';
          if (tid && grantTrophy(userId, tid)) {
            trophyExtra = `\n🏆 Трофей у /sklad: **${trophyLabelById(tid)}**`;
          }
          msg += `\n\n🏆 **Турнір завершено!** ${def.emoji} ${def.name}\n+${def.finalBonus + 10} 🪙 приз${trophyExtra}\nБаланс: **${getWallet(userId).coins}** 🪙`;
          await ctx.reply(msg, { parse_mode: 'Markdown' });
          bumpCoachOrAgentAfterFriendly(userId, regYou, regThem, leagueSnap, psSnap);
          return;
        }
        tournamentProgressByUser.set(userId, { defId: tour.defId, stageIndex: nextIdx });
        addCoins(userId, 14 + tour.stageIndex * 7);
        msg += `\n+етапні монети. Баланс: **${getWallet(userId).coins}** 🪙`;
        await ctx.reply(msg, { parse_mode: 'Markdown' });
        await beginTournamentRound(ctx, tour.defId, nextIdx);
        bumpCoachOrAgentAfterFriendly(userId, regYou, regThem, leagueSnap, psSnap);
        return;
      }
      if (def && state.them > state.you) {
        tournamentProgressByUser.delete(userId);
        msg += endMessage(state);
        msg += '\n\n**Виліт із турніру.**';
        addCoins(userId, 5);
        msg += `\nБаланс: **${getWallet(userId).coins}** 🪙`;
        await ctx.reply(msg, { parse_mode: 'Markdown' });
        bumpCoachOrAgentAfterFriendly(userId, regYou, regThem, leagueSnap, psSnap);
        return;
      }
    }

    if (leagueSnap) {
      msg += endMessage({ you: regYou, them: regThem });
      await ctx.reply(msg, { parse_mode: 'Markdown' });
      await finishLeagueRoundAfterMatch(ctx, userId, regYou, regThem, leagueSnap);
      return;
    }

    if (psSnap) {
      msg += endMessage({ you: regYou, them: regThem });
      await ctx.reply(msg, { parse_mode: 'Markdown' });
      await finishPlayerCareerMatch(ctx, userId, regYou, regThem, psSnap);
      return;
    }

    msg += endMessage(state);
    awardAfterMatch(userId, state.you, state.them);
    msg += `\n\n+монети за матч (баланс: **${getWallet(userId).coins}** 🪙) — /shop /sklad`;
    await ctx.reply(msg, { parse_mode: 'Markdown' });
    bumpCoachOrAgentAfterFriendly(userId, regYou, regThem, leagueSnap, psSnap);
  } else {
    const cap =
      `${escapeHtml(result.text)}\n` +
      `Рахунок: <b>${escapeHtml(formatScore(state))}</b>. Хвилина ~${minuteLabel(state.turn)}.\n` +
      `${escapeHtml(possessionLabel(state))}` +
      `\nХід ${state.turn + 1}/${state.maxTurns} — обери кнопкою:`;
    await postSoloMatchLiveBoard(
      ctx,
      state,
      {
        caption: cap,
        parse_mode: 'HTML',
        ...fifaMoveKeyboard(),
      }
    );
  }
}

bot.command('pass', (ctx) => dispatchMove(ctx, 'pass'));
bot.command('cross', (ctx) => dispatchMove(ctx, 'cross'));
bot.command('shoot', (ctx) => dispatchMove(ctx, 'shoot'));
bot.command('tackle', (ctx) => dispatchMove(ctx, 'tackle'));
bot.command('block', (ctx) => dispatchMove(ctx, 'block'));
bot.command('mark', (ctx) => dispatchMove(ctx, 'mark'));

bot.command('pvp', async (ctx) => {
  await handlePvpStart(ctx);
});

bot.command('pvp_contact', async (ctx) => {
  await ctx.reply(
    '**З ким ділитися номером:** лише з **цим ботом** у цьому чаті (не з другом у листуванні).\n' +
      'Зверху клавіатури — **📱 Поділитися номером**; нижче як завжди **📋 Меню** та інші кнопки (не інлайн під повідомленням).\n\n' +
      'Після натискання **📱** Telegram передасть номер **боту** для PvP за телефоном (`/pvp …`).',
    {
      parse_mode: 'Markdown',
      ...bottomMenuReplyKeyboard({ prependContactRequest: true }),
    }
  );
});

bot.command('pvp_stop', async (ctx) => {
  const uid = ctx.from.id;
  const own = getPvpSessionByUser(uid);
  const rest = (ctx.message?.text || '').replace(/^\/pvp_stop(@[A-Za-z0-9_]+)?\s*/i, '').trim();
  const parts = rest.split(/\s+/).filter(Boolean);

  if (own && parts.length === 0) {
    const [p0, p1] = own.playerIds;
    destroyPvpSession(own);
    await ctx.reply('PvP скасовано.');
    const other = p0 === uid ? p1 : p0;
    try {
      await ctx.telegram.sendMessage(other, '⚔️ Суперник скасував PvP (/pvp_stop).');
    } catch {
      /* ignore */
    }
    return;
  }

  if (isAdminUser(ctx.from) && adminConfigured()) {
    let s = null;
    if (parts.length >= 2) {
      const ra = resolvePvpTargetToken(parts[0]);
      const rb = resolvePvpTargetToken(parts[1]);
      if (ra.id && rb.id) s = findPvpSessionByPair(ra.id, rb.id);
    } else if (pvpSessions.size === 1) {
      s = pvpSessions.values().next().value;
    }
    if (s) {
      const [p0, p1] = s.playerIds;
      destroyPvpSession(s);
      await ctx.reply(`PvP скасовано адміном (**${p0}** vs **${p1}**).`);
      for (const pid of [p0, p1]) {
        try {
          await ctx.telegram.sendMessage(pid, '⚔️ PvP скасовано адміністратором.');
        } catch {
          /* ignore */
        }
      }
      return;
    }
  }

  await ctx.reply(
    'Немає активного PvP для тебе. Учасник: `/pvp_stop` без тексту. Адмін: `/pvp_stop id1 id2` або один `/pvp_stop`, якщо в бота лише одна сесія.',
    { parse_mode: 'Markdown' }
  );
});

bot.action(/^fifa:(pass|cross|shoot|tackle|block|mark)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const action = ctx.match[1];
  await dispatchMove(ctx, action);
});

bot.action(/^pvp:(pass|cross|shoot|tackle|block|mark)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await dispatchMove(ctx, ctx.match[1]);
});

bot.command('list', async (ctx) => {
  if (!isAdminUser(ctx.from)) return;
  if (!adminConfigured()) {
    await ctx.reply('У .env не задано ADMIN_ID (число або @username, через кому можна кілька).');
    return;
  }
  if (!knownUsersById.size) {
    await ctx.reply('Поки немає записів (ніхто не писав боту після останнього перезапуску).');
    return;
  }
  const rows = [...knownUsersById.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, u]) => {
      const un = u.username ? `@${u.username}` : '—';
      return `${id}\t${un}\t${u.first_name || ''}`.trimEnd();
    });
  await ctx.reply(`Відомих користувачів: ${knownUsersById.size}\n\n${rows.join('\n')}`);
});

bot.command('write', async (ctx) => {
  if (!isAdminUser(ctx.from)) return;
  if (!adminConfigured()) {
    await ctx.reply('У .env не задано ADMIN_ID.');
    return;
  }
  const text = (ctx.message?.text || '')
    .replace(/^\/write(@[A-Za-z0-9_]+)?\s*/i, '')
    .trim();
  if (!text) {
    await ctx.reply('Формат: /write будь-який текст — надішлеться всім, хто колись писав боту.');
    return;
  }
  let ok = 0;
  let fail = 0;
  for (const id of knownUsersById.keys()) {
    try {
      await ctx.telegram.sendMessage(id, `📢 ${text}`);
      ok += 1;
    } catch {
      fail += 1;
    }
  }
  await ctx.reply(`Готово. Доставлено: ${ok}, не вдалося: ${fail}.`);
});

bot.command('transfer', async (ctx) => {
  if (!isAdminUser(ctx.from)) return;
  if (!adminConfigured()) {
    await ctx.reply('У .env не задано ADMIN_ID.');
    return;
  }
  transferExchangeEnabled = !transferExchangeEnabled;
  if (!transferExchangeEnabled) clearTradeExchangeState();
  const text = transferExchangeEnabled
    ? '🔄 **Режим обміну гравцями увімкнено.** Унизу зʼявилась кнопка «Обмін гравцями».'
    : '⏹ Режим обміну гравцями **вимкнено** (чернетки й відкриті заявки скинуто).';
  const { ok, fail } = await broadcastBottomMenuToKnownUsers(ctx.telegram, text);
  await ctx.reply(
    transferExchangeEnabled
      ? `Обмін **увімкнено**. Клавіатуру оновлено: доставлено ${ok}, не вдалося ${fail}.`
      : `Обмін **вимкнено**. Клавіатуру оновлено: ${ok}, не вдалося ${fail}.`
  );
});

bot.command('can', async (ctx) => {
  if (!isAdminUser(ctx.from)) return;
  if (!adminConfigured()) {
    await ctx.reply('У .env не задано ADMIN_ID.');
    return;
  }
  const rest = (ctx.message?.text || '')
    .replace(/^\/can(@[A-Za-z0-9_]+)?\s*/i, '')
    .trim();
  const parts = rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    await ctx.reply(
      'Формат: <code>/can username назва_цепочки</code>\n' +
        'Приклад: <code>/can Max_Misiura vip</code>\n\n' +
        '<b>Цепочки:</b>\n' +
        listChainsHelpHtml(),
      { parse_mode: 'HTML' }
    );
    return;
  }
  const target = resolvePvpTargetToken(parts[0]);
  if (target.err) {
    await ctx.reply(`Не знайдено користувача: ${target.err}`);
    return;
  }
  const chainId = resolveChainId(parts[1]);
  if (!chainId) {
    await ctx.reply(
      `Невідома цепочка «${escapeHtml(parts[1])}».\n\n<b>Доступні назви:</b>\n${listChainsHelpHtml()}`,
      { parse_mode: 'HTML' }
    );
    return;
  }
  const grant = grantChainAccess(target.id, chainId);
  if (!grant.ok) {
    if (grant.err === 'already_public') {
      await ctx.reply(`Цепочка <b>${grant.title}</b> (<code>${grant.chainId}</code>) і так відкрита для всіх.`, {
        parse_mode: 'HTML',
      });
      return;
    }
    await ctx.reply('Помилка видачі доступу.');
    return;
  }
  const label = formatPlayerLabel(target.id);
  await ctx.reply(
    `✅ <b>${escapeHtml(label)}</b> (id <code>${target.id}</code>) отримав доступ до цепочки <b>${grant.title}</b> (<code>${grant.chainId}</code>).`,
    { parse_mode: 'HTML' }
  );
  try {
    await ctx.telegram.sendMessage(
      target.id,
      `🎁 Власник бота відкрив тобі цепочку <b>${grant.title}</b> (<code>${grant.chainId}</code>).\nВідкрий «🔗 Цепочка» у меню.`,
      { parse_mode: 'HTML' }
    );
  } catch {
    /* ignore */
  }
});

bot.command('add', async (ctx) => {
  if (!isAdminUser(ctx.from)) return;
  if (!adminConfigured()) {
    await ctx.reply('У .env не задано ADMIN_ID.');
    return;
  }
  const rest = (ctx.message?.text || '')
    .replace(/^\/add(@[A-Za-z0-9_]+)?\s*/i, '')
    .trim();
  const parts = rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    await ctx.reply('Формат: /add username число\nПриклад: /add oleksandr 100 (username без @ теж ок)');
    return;
  }
  const rawName = parts[0].replace(/^@/, '');
  const amount = parseInt(parts[1], 10);
  if (!Number.isFinite(amount)) {
    await ctx.reply('Другий аргумент має бути цілим числом монет.');
    return;
  }
  let targetId = null;
  let foundName = null;
  for (const [id, info] of knownUsersById.entries()) {
    if (info.username && info.username.toLowerCase() === rawName.toLowerCase()) {
      targetId = id;
      foundName = info.username;
      break;
    }
  }
  if (targetId == null) {
    await ctx.reply(
      'Користувача з таким username не знайдено. Він має хоч раз написати боту після перезапуску (щоб зʼявився в /list).'
    );
    return;
  }
  addCoins(targetId, amount);
  const atUser = escapeMarkdownV1(`@${foundName}`);
  await ctx.reply(
    `OK: **+${amount}** 🪙 → ${atUser} (id \`${targetId}\`)\nНовий баланс: **${getWallet(targetId).coins}** 🪙`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('win', async (ctx) => {
  if (!isAdminUser(ctx.from)) return;
  if (!adminConfigured()) {
    await ctx.reply('У .env не задано ADMIN_ID.');
    return;
  }
  const rest = (ctx.message?.text || '')
    .replace(/^\/win(@[A-Za-z0-9_]+)?\s*/i, '')
    .trim();
  const parts = rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    const list = TROPHY_ITEMS.map((t) => `• \`${t.id}\` — ${t.emoji} ${t.name}`).join('\n');
    await ctx.reply(
      'Формат: `/win username id_трофею`\nМожна **Telegram id** замість username.\n\nДоступні трофеї:\n' +
        list,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  const rawTarget = parts[0].replace(/^@/, '');
  const trophyId = parts[1];
  if (!TROPHY_ITEMS.some((t) => t.id === trophyId)) {
    await ctx.reply('Невідомий id трофею. Надішли `/win` без аргументів — побачиш список.', { parse_mode: 'Markdown' });
    return;
  }
  let targetId = null;
  let foundName = null;
  if (/^\d+$/.test(rawTarget)) {
    const idNum = parseInt(rawTarget, 10);
    if (knownUsersById.has(idNum)) {
      targetId = idNum;
      const info = knownUsersById.get(idNum);
      foundName = info?.username || String(idNum);
    }
  } else {
    for (const [id, info] of knownUsersById.entries()) {
      if (info.username && info.username.toLowerCase() === rawTarget.toLowerCase()) {
        targetId = id;
        foundName = info.username;
        break;
      }
    }
  }
  if (targetId == null) {
    await ctx.reply(
      'Користувача не знайдено. Він має хоч раз написати боту (щоб зʼявився в базі), або перевір username / id.'
    );
    return;
  }
  getWallet(targetId);
  grantTrophy(targetId, trophyId);
  const who = foundName ? escapeMarkdownV1(`@${foundName}`) : `\`${targetId}\``;
  await ctx.reply(
    `OK: перемога зарахована — **${trophyLabelById(trophyId)}** → ${who} (id \`${targetId}\`)\n/sklad у користувача.`,
    { parse_mode: 'Markdown' }
  );
  try {
    await ctx.telegram.sendMessage(
      targetId,
      `🏆 **Перемога зафіксована!**\nУ твій інвентар додано: **${trophyLabelById(trophyId)}**\nПодивись /sklad → розділ «Трофеї».`,
      { parse_mode: 'Markdown' }
    );
  } catch {
    /* ignore */
  }
});

bot.catch((err, ctx) => {
  console.error('Помилка бота:', err);
  return ctx.reply('Сталася помилка. Спробуй ще раз або перезапусти бота.').catch(() => {});
});

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
