require('dotenv').config();
const { Telegraf, Markup, Input } = require('telegraf');

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

/**
 * Посилання для завантаження фото НАМИ (не через Telegram URL).
 * Сервери Telegram часто не можуть підтягнути Wikimedia → "failed to get HTTP URL content".
 */
const MATCH_IMAGE_URLS = [
  'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8d/Football_iu_1996.jpg/960px-Football_iu_1996.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/8/8d/Football_iu_1996.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6e/Football_%28soccer_ball%29.svg/512px-Football_%28soccer_ball%29.svg.png',
];

/** @type {ReturnType<typeof Input.fromBuffer> | null} */
let cachedMatchPhoto = null;

async function getMatchPhotoInput() {
  if (cachedMatchPhoto) return cachedMatchPhoto;
  for (const url of MATCH_IMAGE_URLS) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'FifaTelegramBot/1.0 (Node)' },
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200) continue;
      const filename = url.toLowerCase().includes('.png') ? 'match.png' : 'match.jpg';
      cachedMatchPhoto = Input.fromBuffer(buf, filename);
      return cachedMatchPhoto;
    } catch {
      // наступний URL
    }
  }
  return null;
}

/** Надсилає фото як файл (Telegram не робить HTTP до зовнішнього URL). */
async function replyWithMatchPhoto(ctx, extra) {
  const photo = await getMatchPhotoInput();
  if (photo) {
    await ctx.replyWithPhoto(photo, extra);
    return;
  }
  const caption = extra.caption || '';
  await ctx.reply(`${caption}\n\n(Не вдалося завантажити картинку — перевір інтернет і спробуй ще.)`, {
    reply_markup: extra.reply_markup,
  });
}

/** @type {Map<number, { you: number; them: number; turn: number; maxTurns: number; possession: 'you' | 'them' }>} */
const fifaMatchByUser = new Map();

/** PvP: два гравці по черзі в одному матчі. */
/** @type {Map<string, { sessionId: string; playerIds: [number, number]; scores: [number, number]; currentIdx: 0 | 1; moveNum: number; maxTurns: number; possession: 'you' | 'them' }>} */
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

const LEAGUE_POS_BONUS = [200, 130, 90, 65, 50, 40, 32, 25, 18, 12];

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
  { id: 'pack_bronze', name: 'Бронзовий пак', price: 95 },
  { id: 'pack_silver', name: 'Срібний пак', price: 210 },
  { id: 'pack_gold', name: 'Золотий пак', price: 395 },
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

function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('▶️ Новий матч', 'fifa:new')],
    [Markup.button.callback('🏆 Турнір (сітка)', 'tour:menu')],
    [Markup.button.callback('📊 Чемпіонат (ліга)', 'league:menu')],
    [
      Markup.button.callback('🥅 Пенальті', 'pen:new'),
      Markup.button.callback('🛒 Магазин', 'shop:open'),
    ],
    [Markup.button.callback('👥 Склад команди', 'sklad:open')],
  ]);
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
  if (hasActiveLeague(userId)) {
    await ctx.reply(
      'У тебе йде **чемпіонат (ліга)**. Продовжи через «📊 Чемпіонат» або /championship, або скинь: /league_stop.',
      { parse_mode: 'Markdown' }
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
  await replyWithMatchPhoto(ctx, {
    caption,
    ...fifaMoveKeyboard(),
  });
}

async function startPenaltySeries(ctx, options = {}) {
  const { fromMatchDraw = false, tournamentMeta = null, leagueMeta = null } = options;
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
  await replyWithMatchPhoto(ctx, {
    caption: cap,
    parse_mode: 'HTML',
    ...fifaMoveKeyboard(),
  });
}

async function showLeaguePanel(ctx) {
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
  if (hasActiveLeague(userId)) {
    await ctx.reply('Спочатку заверши чемпіонат (ліга) або /league_stop.');
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
  await replyWithMatchPhoto(ctx, {
    caption,
    parse_mode: 'Markdown',
    ...fifaMoveKeyboard(),
  });
}

async function showTournamentPanel(ctx) {
  const userId = ctx.from.id;
  if (hasActiveLeague(userId)) {
    await ctx.reply('У тебе йде **чемпіонат (ліга)**. Заверши /league_stop або продовжи через /championship.', {
      parse_mode: 'Markdown',
    });
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
    '**Чемпіонат:** «📊 Чемпіонат» або /championship — 10 команд, 9 турів\n' +
    'Зупинити свій матч: /fifa_stop, /penalty_stop, /tournament_stop, /league_stop\n\n' +
    'Захист у матчі: «Відбір», «Блок», «Пресинг» або /tackle, /block, /mark.\n\n' +
    '🔽 **Кнопки меню знизу** — швидкий доступ (наступне повідомлення).';
  await replyWithMatchPhoto(ctx, {
    caption,
    parse_mode: 'Markdown',
    ...mainMenuKeyboard(),
  });
  await ctx.reply('⌨️ Меню знизу екрана:', bottomMenuReplyKeyboard());
});

bot.command('menu', async (ctx) => {
  await ctx.reply('Обери дію:', { parse_mode: 'Markdown', ...mainMenuKeyboard() });
  await ctx.reply('⌨️ Меню знизу екрана:', bottomMenuReplyKeyboard());
});

bot.hears(/^📋 Меню$/, async (ctx) => {
  await ctx.reply('Головне меню:', { parse_mode: 'Markdown', ...mainMenuKeyboard() });
  await ctx.reply('⌨️ Меню знизу екрана:', bottomMenuReplyKeyboard());
});

bot.hears(/^▶️ Матч$/, async (ctx) => {
  await handleFifaStart(ctx);
});

bot.hears(/^🏆 Турнір$/, async (ctx) => {
  await showTournamentPanel(ctx);
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
  leagueByUser.delete(ctx.from.id);
  fifaMatchByUser.delete(ctx.from.id);
  ctx.reply('Чемпіонат (лігу) скинуто. /championship — почати знову.');
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
  leagueByUser.set(userId, { rows: createLeagueRows(userId), round: 0, finished: false });
  await beginLeagueRound(ctx);
});

bot.action('league:play', async (ctx) => {
  await ctx.answerCbQuery();
  await beginLeagueRound(ctx);
});

bot.action('league:reset', async (ctx) => {
  await ctx.answerCbQuery();
  leagueByUser.delete(ctx.from.id);
  fifaMatchByUser.delete(ctx.from.id);
  await ctx.reply('Лігу скинуто.');
});

bot.action(/^tour:start:([\w]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const defId = ctx.match[1];
  if (!getTournamentDef(defId)) {
    await ctx.reply('Невідомий турнір.');
    return;
  }
  const userId = ctx.from.id;
  if (hasActiveLeague(userId)) {
    await ctx.reply('Спочатку заверши чемпіонат (ліга) або /league_stop.');
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
  if (hasActiveLeague(userId)) {
    await ctx.reply('Спочатку заверши чемпіонат (ліга) або /league_stop.');
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
    await ctx.telegram.sendMessage(id1, `${intro}\n\n${turnLine}`, {
      parse_mode: 'HTML',
      ...pvpMoveKeyboard(),
    });
  } catch {
    await ctx.reply(
      `Не вдалося написати першому гравцю (<code>${id1}</code>). Нехай він напише боту /start.`,
      { parse_mode: 'HTML' }
    );
    destroyPvpSession(session);
    return;
  }
  try {
    await ctx.telegram.sendMessage(
      id2,
      `${intro}\n\n<i>Очікуй хід суперника (${n1h}).</i>`,
      { parse_mode: 'HTML' }
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
  const ease = squadEaseStrength(uid);
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
  await ctx.reply(
    `${msg}\n\nХід передається <b>${nOtherHtml}</b> (наступний ${nextNum}/${session.maxTurns}).`,
    { parse_mode: 'HTML' }
  );
  try {
    await ctx.telegram.sendMessage(
      pidOther,
      `${msg}\n\n⚡ <b>Твій хід</b> ${nextNum}/${session.maxTurns}`,
      { parse_mode: 'HTML', ...pvpMoveKeyboard() }
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

  const botStr = state.tournament?.strength ?? state.league?.strength ?? 0;
  const ease = squadEaseStrength(userId);
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
    fifaMatchByUser.delete(userId);

    if (draw) {
      msg += `\n🤝 **Нічия** ${formatScore({ you: regYou, them: regThem })} у основний час.\nДалі — серія пенальті!`;
      await ctx.reply(msg, { parse_mode: 'Markdown' });
      await startPenaltySeries(ctx, {
        fromMatchDraw: true,
        tournamentMeta: tour,
        leagueMeta: leagueSnap,
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
          return;
        }
        tournamentProgressByUser.set(userId, { defId: tour.defId, stageIndex: nextIdx });
        addCoins(userId, 14 + tour.stageIndex * 7);
        msg += `\n+етапні монети. Баланс: **${getWallet(userId).coins}** 🪙`;
        await ctx.reply(msg, { parse_mode: 'Markdown' });
        await beginTournamentRound(ctx, tour.defId, nextIdx);
        return;
      }
      if (def && state.them > state.you) {
        tournamentProgressByUser.delete(userId);
        msg += endMessage(state);
        msg += '\n\n**Виліт із турніру.**';
        addCoins(userId, 5);
        msg += `\nБаланс: **${getWallet(userId).coins}** 🪙`;
        await ctx.reply(msg, { parse_mode: 'Markdown' });
        return;
      }
    }

    if (leagueSnap) {
      msg += endMessage({ you: regYou, them: regThem });
      await ctx.reply(msg, { parse_mode: 'Markdown' });
      await finishLeagueRoundAfterMatch(ctx, userId, regYou, regThem, leagueSnap);
      return;
    }

    msg += endMessage(state);
    awardAfterMatch(userId, state.you, state.them);
    msg += `\n\n+монети за матч (баланс: **${getWallet(userId).coins}** 🪙) — /shop /sklad`;
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  } else {
    msg += `\nХід ${state.turn + 1}/${state.maxTurns} — обери кнопкою:`;
    await ctx.reply(msg, fifaMoveKeyboard());
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

void getMatchPhotoInput().catch(() => {});
bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
