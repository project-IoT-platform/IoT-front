const TELEGRAM_BOT_URL = 'https://t.me/IoT_NotifierBot';

// Адрес API (CORS на бэкенде разрешает страницы с localhost:3000 и 127.0.0.1:3000)
const API = 'http://localhost:8082';

// 0.0.0.0 — это «слушать на всех интерфейсах», а не адрес для браузера: переходим на localhost
if (location.hostname === '0.0.0.0') {
  location.replace(location.href.replace('0.0.0.0', 'localhost'));
}

const PAGE_SIZE = 10;

/**
 * НОВОЕ: соответствие типа телеметрии (число telemetryType) и названия, единицы и иконки.
 * Здесь же его читает таблица на вкладке «Описание» и подписи в плитках и на графике.
 * ВАЖНО: список ниже составлен как пример. Приведите его в соответствие с тем, что реально шлёт
 * ваш http-адаптер/симулятор (код типа -> параметр -> единица). Неизвестный тип показывается как «Тип N» без единицы.
 * Доступные иконки: thermometer, droplets, gauge, sun, zap, activity.
 */
const TELEMETRY_TYPES = {
  1: { name: 'Температура', unit: '°C', icon: 'thermometer' },
  2: { name: 'Влажность', unit: '%', icon: 'droplets' },
  3: { name: 'Атмосферное давление', unit: 'гПа', icon: 'gauge' },
  4: { name: 'Освещённость', unit: 'лк', icon: 'sun' },
  5: { name: 'Напряжение', unit: 'В', icon: 'zap' },
  6: { name: 'Сила тока', unit: 'А', icon: 'activity' }
};

const TILES_REFRESH_MS = 15000;   // как часто обновлять плитки в списке устройств

const ABOUT_TEXT = 'IoT Platform — учебный проект. Позволяет регистрировать устройства, ' +
  'отслеживать состояние и получать уведомления о низком заряде и отклонениях телеметрии. ' +
  'Уведомления приходят на email и в Telegram-бот.';

const VIEW_TITLES = {
  devices: 'Устройства',
  profile: 'Профиль',
  users: 'Пользователи',
  notifications: 'Уведомления',
  about: 'Описание'
};

const FIELD_LABELS = {
  email: 'Email',
  password: 'Пароль',
  username: 'Имя пользователя',
  phone: 'Телефон',
  dateOfBirth: 'Дата рождения',
  name: 'Название',
  batteryLevel: 'Заряд',
  state: 'Состояние',
  userId: 'Пользователь',
  batteryLimit: 'Нижняя граница заряда',
  batteryLowerBound: 'Нижняя граница заряда',
  emailIntervalSeconds: 'Email',
  telegramIntervalSeconds: 'Telegram',
  type: 'Тип телеметрии',
  since: 'Время',
  requesterId: 'Пользователь'
};

const $ = (id) => document.getElementById(id);

const screens = { auth: $('screen-auth'), confirm: $('screen-confirm'), main: $('screen-main') };
const views = {
  devices: $('view-devices'),
  users: $('view-users'),
  profile: $('view-profile'),
  notifications: $('view-notifications'),
  about: $('view-about')
};

let currentDevice = null;   // устройство, открытое в модалке
let settingsDevice = null;  // устройство, чьи лимиты редактируются
let currentUser = null;     // данные профиля
const devState = { items: [], offset: 0, hasMore: false, search: null, ticket: 0 };
const usrState = { items: [], offset: 0, hasMore: false, search: null, ticket: 0 };   // НОВОЕ: вкладка «Пользователи»

/* ---------------- утилиты ---------------- */

function showScreen(name) {
  for (const [key, node] of Object.entries(screens)) node.hidden = key !== name;
}

let toastTimer = null;
function toast(text, isError = false) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

function setMessage(node, text, kind = 'error') {
  if (!text) { node.hidden = true; node.textContent = ''; return; }
  node.textContent = text;
  node.className = 'message ' + kind;
  node.hidden = false;
}

/** Сетевые/неожиданные ошибки: в консоль и пользователю. */
function fail(err, userText = 'Не удалось связаться с сервером') {
  console.error(err);
  toast(userText, true);
}

/** Запрос к API. HTTP-ошибки не бросают исключение, возвращается {status, ok, data}. */
async function api(method, path, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(API + path, options);
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { status: res.status, ok: res.ok, data };
}

/** {field: "текст"} или {error: "текст"} -> одна строка. */
function formatErrors(data, fallback = 'Ошибка запроса') {
  if (!data || typeof data !== 'object') return fallback;
  if (typeof data.error === 'string') return data.error;
  const parts = Object.entries(data).map(([k, v]) => `${FIELD_LABELS[k] || k}: ${v}`);
  return parts.length ? parts.join('; ') : fallback;
}

function dash(v) {
  return v === null || v === undefined || v === '' ? '—' : String(v);
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('ru-RU');
}

function formatBirthDate(iso) {
  if (!iso) return '—';
  const match = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[3]}.${match[2]}.${match[1]}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('ru-RU');
}

/* ---- НОВОЕ: иконки (спрайт лежит в index.html) и форматирование телеметрии ---- */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** <svg class="i"><use href="#i-имя"/></svg>: иконка в стиле lucide. */
function icon(name, extraClass = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', ('i ' + extraClass).trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

function typeInfo(type) {
  return TELEMETRY_TYPES[type] || { name: 'Тип ' + type, unit: '', icon: 'activity' };
}

const NUM_FMT = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const fmtNum = (v) => NUM_FMT.format(v);
const fmtValue = (v, unit) => fmtNum(v) + (unit ? '\u00a0' + unit : '');

/** Время из API: ISO-строка или число (секунды/миллисекунды) -> Date. */
function toDate(v) {
  if (typeof v === 'number') return new Date(v < 1e11 ? v * 1000 : v);
  return new Date(v);
}

function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function timeAgo(date) {
  const sec = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (sec < 60) return 'только что';
  const min = Math.round(sec / 60);
  if (min < 60) return min + '\u00a0мин назад';
  const h = Math.round(min / 60);
  if (h < 24) return h + '\u00a0ч назад';
  return date.toLocaleDateString('ru-RU');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('ID скопирован');
  } catch (err) {
    console.error(err);
    toast('Не удалось скопировать', true);
  }
}

function copyButton(text) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn small';
  btn.title = 'Скопировать ID';
  btn.setAttribute('aria-label', 'Скопировать ID');
  btn.append(icon('copy'));   // ИЗМЕНЕНО: SVG вместо эмодзи
  btn.addEventListener('click', () => copyText(text));
  return btn;
}

/** Заполняет <dl>. Значение может быть строкой или {text, copy: true} (код + кнопка копирования). */
function fillKv(dl, rows) {
  dl.replaceChildren();
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    if (value && typeof value === 'object' && value.copy) {
      const code = document.createElement('code');
      code.textContent = value.text;
      dd.append(code, copyButton(value.text));
    } else {
      dd.textContent = value;
    }
    dl.append(dt, dd);
  }
}

function stateBadge(state) {
  const span = document.createElement('span');
  span.className = 'badge ' + (state === 'ON' ? 'on' : 'off');
  span.textContent = dash(state);
  return span;
}

/* ---------------- сессия ---------------- */

const getUserId = () => localStorage.getItem('userId');

function logout() {
  localStorage.removeItem('userId');
  sessionStorage.removeItem('pendingUserId');
  currentDevice = null;
  settingsDevice = null;
  currentUser = null;
  stopTilesPolling();
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  applyRole();
  closeDrawer();
  openAuth();
}

function openAuth(message, kind = 'error') {
  $('login-form').reset();
  setMessage($('auth-message'), message, kind);
  showScreen('auth');
}

/* ---------------- экран 1: вход / регистрация ---------------- */

function readCredentials() {
  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;
  if (!email || !password) {
    setMessage($('auth-message'), 'Введите email и пароль');
    return null;
  }
  return { email, password };
}

// Войти: POST /api/login
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  setMessage($('auth-message'), '');
  const creds = readCredentials();
  if (!creds) return;

  try {
    const r = await api('POST', '/api/login', creds);
    $('auth-password').value = '';
    if (r.status === 200 && r.data && r.data.id) {
      localStorage.setItem('userId', r.data.id);
      await enterMain();
    } else if (r.status === 401) {
      setMessage($('auth-message'), 'Неверный email или пароль');
    } else if (r.status === 400) {
      setMessage($('auth-message'), formatErrors(r.data));
    } else {
      console.error('Вход: неожиданный ответ', r.status);
      toast('Не удалось войти (код ' + r.status + ')', true);
    }
  } catch (err) {
    fail(err);
  }
});

// Зарегистрироваться: POST /api/users
$('register-btn').addEventListener('click', async () => {
  setMessage($('auth-message'), '');
  const creds = readCredentials();
  if (!creds) return;

  try {
    const r = await api('POST', '/api/users', creds);
    $('auth-password').value = ''; // пароль нигде не храним
    if (r.status === 201 && r.data && r.data.id) {
      sessionStorage.setItem('pendingUserId', r.data.id);
      $('confirm-id').value = '';
      setMessage($('confirm-message'), '');
      showScreen('confirm');
    } else if (r.status === 400 && r.data && r.data.email) {
      if (/существует/i.test(r.data.email)) {
        setMessage($('auth-message'), 'Пользователь с таким email уже есть в системе');
      } else {
        setMessage($('auth-message'), formatErrors(r.data));
      }
    } else if (r.status === 400) {
      setMessage($('auth-message'), formatErrors(r.data));
    } else {
      console.error('Регистрация: неожиданный ответ', r.status);
      toast('Не удалось зарегистрироваться (код ' + r.status + ')', true);
    }
  } catch (err) {
    fail(err);
  }
});

/* ---------------- экран 2: подтверждение ID ---------------- */

async function cancelPending() {
  const pending = sessionStorage.getItem('pendingUserId');
  sessionStorage.removeItem('pendingUserId');
  if (!pending) return;
  try {
    const r = await api('DELETE', '/api/users/' + encodeURIComponent(pending));
    if (!r.ok && r.status !== 404) console.error('Не удалось удалить незавершённую регистрацию', r.status);
  } catch (err) {
    console.error(err);
  }
}

$('confirm-submit').addEventListener('click', async () => {
  const id = $('confirm-id').value.trim();
  const pending = sessionStorage.getItem('pendingUserId');
  if (!pending) { openAuth(); return; }
  if (!id) { setMessage($('confirm-message'), 'Введите ID'); return; }

  // чужой ID подтверждать нельзя: иначе по известному ID можно было бы войти без пароля
  if (id.toLowerCase() !== pending.toLowerCase()) {
    setMessage($('confirm-message'), 'Неверный ID. Проверьте письмо и попробуйте ещё раз');
    return;
  }

  try {
    const r = await api('POST', '/api/users/' + encodeURIComponent(pending) + '/confirm');
    if (r.status === 200) {
      localStorage.setItem('userId', pending);
      sessionStorage.removeItem('pendingUserId');
      await enterMain();
    } else if (r.status === 404) {
      sessionStorage.removeItem('pendingUserId');
      openAuth('Пользователь не найден. Зарегистрируйтесь заново');
    } else {
      console.error('Подтверждение: ответ', r.status);
      toast(formatErrors(r.data, 'Не удалось подтвердить регистрацию'), true);
    }
  } catch (err) {
    fail(err);
  }
});

$('confirm-cancel').addEventListener('click', async () => {
  await cancelPending();
  openAuth();
});

/* ---------------- экран 3: главная ---------------- */

async function enterMain() {
  const userId = getUserId();
  if (!userId) { openAuth(); return; }
  try {
    const r = await api('GET', '/api/users/' + encodeURIComponent(userId));
    if (r.status === 200 && r.data) {
      if (r.data.isConfirmed === false) {
        logout();
        toast('Аккаунт не подтверждён', true);
        return;
      }
      currentUser = r.data;
      applyRole();   // НОВОЕ: вкладка «Пользователи» только для ADMIN
      setUserEmail(r.data.email);
    } else if (r.status === 404 || r.status === 400) {
      logout();
      toast('Пользователь не найден, войдите заново', true);
      return;
    } else {
      toast('Не удалось загрузить пользователя (код ' + r.status + ')', true);
    }
  } catch (err) {
    fail(err);
  }
  showScreen('main');
  showView('devices');
}

function setUserEmail(email) {
  $('user-email').textContent = dash(email);
  $('topbar-email').textContent = dash(email);
}

/* выезжающая панель */
function openDrawer() { setDrawer(true); }
function closeDrawer() { setDrawer(false); }

function setDrawer(open) {
  $('sidebar').classList.toggle('open', open);
  $('scrim').classList.toggle('show', open);
  $('menu-btn').setAttribute('aria-expanded', String(open));
}

$('menu-btn').addEventListener('click', () => {
  setDrawer(!$('sidebar').classList.contains('open'));
});
$('scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
});

$('sidebar').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.view) showView(btn.dataset.view);
  else if (btn.dataset.action === 'logout') logout();
});

function showView(name) {
  if (name === 'users' && !isAdmin()) name = 'devices';   // НОВОЕ: чужим вкладку не открываем
  for (const [key, node] of Object.entries(views)) node.hidden = key !== name;
  document.querySelectorAll('.nav-item[data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === name);
  });
  $('topbar-title').textContent = VIEW_TITLES[name] || '';
  closeDrawer();
  if (name === 'devices') { loadDevices(); startTilesPolling(); } else { stopTilesPolling(); }
  if (name === 'users') loadUsers();
  if (name === 'profile') loadProfile();
  if (name === 'notifications') loadNotificationPrefs();
}

/* ---------------- устройства ---------------- */

/**
 * ИЗМЕНЕНО. Без поиска: страница списка (append=false первая, true следующая; запрашиваем на 1 больше,
 * чтобы знать, есть ли ещё). С поиском: поиск идёт по НАЗВАНИЮ, бэкенд отдаёт все совпадения сразу,
 * поэтому limit/offset не отправляем и кнопки «Показать ещё» нет.
 */
async function loadDevices(append = false) {
  const userId = getUserId();
  if (!userId) { openAuth(); return; }
  if (!append) {
    devState.offset = 0;
    devState.items = [];
    devState.hasMore = false;
  }

  const params = new URLSearchParams({ userId });
  if (devState.search) {
    params.set('search', devState.search);
  } else {
    params.set('limit', String(PAGE_SIZE + 1));
    params.set('offset', String(devState.offset));
  }

  const ticket = ++devState.ticket;   // ответ на устаревший запрос (быстрый набор в поиске) отбрасываем
  try {
    const r = await api('GET', '/api/devices?' + params.toString());
    if (ticket !== devState.ticket) return;
    if (!r.ok || !Array.isArray(r.data)) {
      console.error('Список устройств: ответ', r.status);
      toast(formatErrors(r.data, 'Не удалось загрузить устройства'), true);
      return;
    }
    const page = devState.search ? r.data : r.data.slice(0, PAGE_SIZE);
    devState.items = append ? devState.items.concat(page) : page;
    devState.offset += page.length;
    devState.hasMore = !devState.search && r.data.length > PAGE_SIZE;
    renderDevices();
  } catch (err) {
    fail(err);
  }
}

function batteryNode(level) {
  const wrap = document.createElement('span');
  wrap.className = 'battery';
  if (level === null || level === undefined) {
    wrap.textContent = '—';
    return wrap;
  }
  const bar = document.createElement('span');
  bar.className = 'bar';
  const fill = document.createElement('span');
  fill.className = level < 20 ? 'low' : level < 50 ? 'mid' : '';
  fill.style.width = Math.max(0, Math.min(100, level)) + '%';
  bar.append(fill);
  const label = document.createElement('span');
  label.textContent = level + '%';
  wrap.append(bar, label);
  return wrap;
}

function row(label, valueNode) {
  const div = document.createElement('div');
  div.className = 'dc-row';
  const l = document.createElement('span');
  l.textContent = label;
  div.append(l, valueNode);
  return div;
}

function textNode(text) {
  const s = document.createElement('span');
  s.textContent = text;
  return s;
}

function actionButton(text, cls, handler, iconName) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn small' + (cls ? ' ' + cls : '');
  if (iconName) b.append(icon(iconName));
  b.append(document.createTextNode(text));
  b.addEventListener('click', handler);
  return b;
}

function renderDevices() {
  const grid = $('devices-grid');
  grid.replaceChildren();

  const empty = $('devices-empty');
  if (devState.items.length === 0) {
    $('devices-empty-text').textContent = devState.search
      ? 'Устройств с таким названием не найдено.'
      : 'У вас пока нет устройств. Добавьте первое.';
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }
  $('more-btn').hidden = !devState.hasMore;

  devState.items.forEach((d, i) => {
    const card = document.createElement('article');
    card.className = 'device-card';
    card.style.animationDelay = Math.min(i, 9) * 40 + 'ms';

    const head = document.createElement('div');
    head.className = 'dc-head';
    const name = document.createElement('h3');
    name.className = 'dc-name';
    name.textContent = dash(d.name);
    head.append(name, stateBadge(d.state));

    // НОВОЕ: плитки по типам телеметрии (заполняются отдельным запросом)
    const tiles = document.createElement('div');
    tiles.className = 'tiles';
    tiles.dataset.deviceId = d.deviceId;

    const meta = document.createElement('div');
    meta.className = 'dc-meta';
    const idBox = document.createElement('span');
    idBox.className = 'dc-id';
    const code = document.createElement('code');
    code.textContent = d.deviceId;
    code.title = d.deviceId;
    idBox.append(code, copyButton(d.deviceId));
    meta.append(
      row('Заряд', batteryNode(d.batteryLevel)),
      row('Производитель', textNode(dash(d.manufacturer))),
      row('ID', idBox)
    );

    const actions = document.createElement('div');
    actions.className = 'dc-actions';
    actions.append(
      actionButton('Открыть', '', () => openDevice(d.deviceId), 'cpu'),
      actionButton('Настройки', '', () => openSettings(d), 'sliders'),
      actionButton('Удалить', 'danger', () => deleteDevice(d.deviceId, d.name), 'trash')
    );

    card.append(head, tiles, meta, actions);
    grid.append(card);
    loadTiles(tiles, d);
  });
}

function replaceInList(d) {
  const i = devState.items.findIndex((x) => x.deviceId === d.deviceId);
  if (i >= 0) devState.items[i] = d;
  renderDevices();
}

async function deleteDevice(id, name) {
  if (!confirm(`Удалить устройство «${name ?? ''}»?`)) return false;
  try {
    const r = await api('DELETE', '/api/devices/' + encodeURIComponent(id));
    if (r.status === 204 || r.status === 404) {
      toast('Устройство удалено');
      loadDevices();
      return true;
    }
    console.error('Удаление устройства: ответ', r.status);
    toast(formatErrors(r.data, 'Не удалось удалить устройство'), true);
  } catch (err) {
    fail(err);
  }
  return false;
}

/* ---- НОВОЕ: плитки телеметрии в карточке ---- */

/** Последние показания каждого типа: рисует плитки. Клик по плитке открывает модалку с графиком. */
function renderTiles(box, device, list) {
  box.replaceChildren();
  if (!list.length) {
    const none = document.createElement('div');
    none.className = 'tiles-empty';
    none.textContent = 'Показаний пока нет';
    box.append(none);
    return;
  }
  for (const item of [...list].sort((a, b) => a.telemetryType - b.telemetryType)) {
    const info = typeInfo(item.telemetryType);
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.title = info.name + ': открыть график';

    const name = document.createElement('div');
    name.className = 'tile-name';
    const nameText = document.createElement('span');
    nameText.textContent = info.name;
    name.append(icon(info.icon), nameText);

    const value = document.createElement('div');
    value.className = 'tile-value';
    value.append(document.createTextNode(fmtNum(item.value)));
    if (info.unit) {
      const unit = document.createElement('small');
      unit.textContent = info.unit;
      value.append(unit);
    }

    const time = document.createElement('div');
    time.className = 'tile-time';
    const when = toDate(item.time);
    time.textContent = Number.isNaN(when.getTime()) ? '' : timeAgo(when);

    tile.append(name, value, time);
    tile.addEventListener('click', () => openTelemetry(device, item.telemetryType));
    box.append(tile);
  }
}

async function loadTiles(box, device) {
  try {
    const r = await api('GET', '/api/devices/' + encodeURIComponent(device.deviceId) + '/telemetry/latest');
    if (!box.isConnected) return;   // карточку уже перерисовали
    if (r.status === 200 && Array.isArray(r.data)) {
      renderTiles(box, device, r.data);
    } else if (!box.children.length) {
      renderTiles(box, device, []);
    }
  } catch (err) {
    console.error(err);   // при обновлении по таймеру ошибки не показываем тостом
    if (box.isConnected && !box.children.length) renderTiles(box, device, []);
  }
}

let tilesTimer = null;
function startTilesPolling() {
  stopTilesPolling();
  tilesTimer = setInterval(() => {
    if (document.hidden || views.devices.hidden) return;
    document.querySelectorAll('#devices-grid .tiles').forEach((box) => {
      const d = devState.items.find((x) => x.deviceId === box.dataset.deviceId);
      if (d) loadTiles(box, d);
    });
  }, TILES_REFRESH_MS);
}
function stopTilesPolling() {
  if (tilesTimer) clearInterval(tilesTimer);
  tilesTimer = null;
}

/* ---- поиск по названию (ИЗМЕНЕНО: раньше по ID) ---- */
let searchTimer = null;

function applySearch(value) {
  devState.search = value || null;
  $('search-clear').hidden = !value;
  loadDevices();
}

$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(searchTimer);
  applySearch($('search-input').value.trim());
});

// поиск по мере набора, с небольшой задержкой, чтобы не слать запрос на каждую букву
$('search-input').addEventListener('input', () => {
  const value = $('search-input').value.trim();
  $('search-clear').hidden = !value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if ((devState.search || '') !== value) applySearch(value);
  }, 300);
});

$('search-clear').addEventListener('click', () => {
  clearTimeout(searchTimer);
  $('search-input').value = '';
  applySearch('');
});

$('more-btn').addEventListener('click', () => loadDevices(true));

/* создание устройства: только название и производитель, остальное скрыто */
$('add-device-btn').addEventListener('click', () => {
  $('add-form').reset();
  setMessage($('add-message'), '');
  $('add-dialog').showModal();
});

$('add-cancel').addEventListener('click', () => $('add-dialog').close());

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const userId = getUserId();
  if (!userId) { $('add-dialog').close(); openAuth(); return; }

  const name = $('dev-name').value.trim();
  if (!name) { setMessage($('add-message'), 'Введите название'); return; }

  const dto = {
    deviceId: crypto.randomUUID(),
    userId, // обязательно: по userId бэкенд отправляет письмо о регистрации устройства
    name,
    manufacturer: $('dev-manufacturer').value.trim() || null,
    state: 'OFF'
  };

  try {
    const r = await api('POST', '/api/devices', dto);
    if (r.status === 202) {
      $('add-dialog').close();
      toast('Устройство зарегистрировано');
      loadDevices();
    } else if (r.status === 400) {
      setMessage($('add-message'), formatErrors(r.data));
    } else {
      console.error('Регистрация устройства: ответ', r.status);
      toast(formatErrors(r.data, 'Не удалось зарегистрировать устройство'), true);
    }
  } catch (err) {
    fail(err);
  }
});

/* карточка устройства */
function renderDeviceDialog(d) {
  currentDevice = d;
  $('dd-title').textContent = dash(d.name);
  fillKv($('dd-card'), [
    ['ID', { text: d.deviceId, copy: true }],
    ['Состояние', dash(d.state)],
    ['Заряд', d.batteryLevel === null || d.batteryLevel === undefined ? '—' : d.batteryLevel + '%'],
    ['Производитель', dash(d.manufacturer)],
    ['Геолокация', dash(d.geolocation)],
    ['Последние данные', formatDate(d.lastDataTime)]
  ]);
}

async function openDevice(id) {
  try {
    const r = await api('GET', '/api/devices/' + encodeURIComponent(id));
    if (r.status === 200 && r.data) {
      renderDeviceDialog(r.data);
      $('device-dialog').showModal();
    } else if (r.status === 404) {
      toast('Устройство не найдено', true);
      loadDevices();
    } else {
      console.error('Открытие устройства: ответ', r.status);
      toast(formatErrors(r.data, 'Не удалось загрузить устройство'), true);
    }
  } catch (err) {
    fail(err);
  }
}

$('dd-close').addEventListener('click', () => $('device-dialog').close());

// УБРАНО: ручное переключение состояния (кнопка «Изменить состояние»). Состояние управляется автоматически.

$('dd-status').addEventListener('click', async () => {
  if (!currentDevice) return;
  try {
    const r = await api('GET', '/api/notifications/devices/' +
      encodeURIComponent(currentDevice.deviceId) + '/status');
    if (r.status === 200 && r.data) {
      toast('Статус отправлен: ' + dash(r.data.state));
    } else {
      console.error('Отправка статуса: ответ', r.status);
      toast(formatErrors(r.data, 'Не удалось отправить статус'), true);
    }
  } catch (err) {
    fail(err);
  }
});

$('dd-delete').addEventListener('click', async () => {
  if (!currentDevice) return;
  const ok = await deleteDevice(currentDevice.deviceId, currentDevice.name);
  if (ok) $('device-dialog').close();
});

/* ---------------- настройки (лимиты) устройства ---------------- */

const DASHES = new Set(['-', '—', '–', '−']);

/**
 * ИЗМЕНЕНО (баг настроек): пустое поле ИЛИ прочерк («-», «—») означает «ограничение не задано» -> null.
 * Число -> число, мусор -> NaN (форма покажет ошибку). Принимаются и «1,5», и «1.5».
 * Бэкенд теперь воспринимает null как «снять ограничение», а не «не менять».
 */
function parseOptional(text) {
  const t = text.trim().replace(/\s+/g, '');
  if (t === '' || DASHES.has(t)) return null;
  return Number(t.replace(',', '.'));
}

function limitInput(placeholder, label, value, mode) {
  const input = document.createElement('input');
  input.type = 'text';              // text, а не number: в number-поле нельзя ввести прочерк
  input.inputMode = mode;
  input.autocomplete = 'off';
  input.placeholder = placeholder;
  input.setAttribute('aria-label', label);
  input.value = value === null || value === undefined ? '' : String(value);
  return input;
}

function updateLimitsEmpty() {
  $('st-empty').hidden = $('st-list').children.length > 0;
}

function addLimitRow(limit = {}, isNew = true) {
  const rowEl = document.createElement('div');
  rowEl.className = 'limit-row';
  const type = limitInput('Тип', 'Тип телеметрии', limit.telemetryType, 'numeric');
  type.setAttribute('list', 'st-types');   // подсказки из TELEMETRY_TYPES
  if (!isNew) type.readOnly = true;
  const lower = limitInput('—', 'Нижняя граница', limit.lowerBound, 'decimal');
  const upper = limitInput('—', 'Верхняя граница', limit.upperBound, 'decimal');

  // ИЗМЕНЕНО: крестик есть у каждой строки. Удалённая строка при сохранении снимает все границы этого типа
  const rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'icon-btn small';
  rm.setAttribute('aria-label', 'Убрать строку');
  rm.append(icon('x'));
  rm.addEventListener('click', () => { rowEl.remove(); updateLimitsEmpty(); });

  rowEl.append(type, lower, upper, rm);
  $('st-list').append(rowEl);
  updateLimitsEmpty();
  if (isNew) type.focus();
}

function fillSettings(data, device) {
  const battery = data.batteryLimit ?? data.batteryLowerBound;
  const telemetry = data.telemetryLimits ?? data.telemetry ?? [];
  $('st-title').textContent = 'Настройки: ' + dash(device.name);
  $('st-battery').value = battery === null || battery === undefined ? '' : String(battery);
  $('st-list').replaceChildren();
  for (const l of telemetry) addLimitRow(l, false);
  updateLimitsEmpty();
  setMessage($('st-message'), '');
}

async function openSettings(device) {
  try {
    const r = await api('GET', '/api/devices/' + encodeURIComponent(device.deviceId) + '/limits');
    if (r.status === 200 && r.data) {
      settingsDevice = device;
      fillSettings(r.data, device);
      $('settings-dialog').showModal();
    } else if (r.status === 404) {
      toast('Устройство не найдено', true);
    } else {
      console.error('Загрузка лимитов: ответ', r.status);
      toast(formatErrors(r.data, 'Не удалось загрузить настройки'), true);
    }
  } catch (err) {
    fail(err);
  }
}

$('st-add').addEventListener('click', () => addLimitRow({}, true));
$('st-cancel').addEventListener('click', () => $('settings-dialog').close());

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!settingsDevice) return;

  const battery = parseOptional($('st-battery').value);
  if (battery !== null && (!Number.isInteger(battery) || battery < 0 || battery > 100)) {
    setMessage($('st-message'), 'Нижняя граница заряда: целое число от 0 до 100 или «—»');
    return;
  }

  const telemetryLimits = [];
  const seen = new Set();
  for (const rowEl of $('st-list').children) {
    const [typeIn, lowerIn, upperIn] = rowEl.querySelectorAll('input');
    const lower = parseOptional(lowerIn.value);
    const upper = parseOptional(upperIn.value);
    if (typeIn.value.trim() === '' && lower === null && upper === null) continue; // пустая строка
    const type = parseOptional(typeIn.value);
    if (type === null || !Number.isInteger(type) || type < -32768 || type > 32767) {
      setMessage($('st-message'), 'Тип телеметрии должен быть целым числом');
      return;
    }
    if (seen.has(type)) {
      setMessage($('st-message'), `Тип ${type} указан дважды`);
      return;
    }
    seen.add(type);
    if ((lower !== null && !Number.isFinite(lower)) || (upper !== null && !Number.isFinite(upper))) {
      setMessage($('st-message'), `Тип ${type}: границы должны быть числами или «—»`);
      return;
    }
    if (lower !== null && upper !== null && lower > upper) {
      setMessage($('st-message'), `Тип ${type}: нижняя граница больше верхней`);
      return;
    }
    telemetryLimits.push({ telemetryType: type, lowerBound: lower, upperBound: upper });
  }

  // Теперь это ПОЛНАЯ замена: null = «не задано» (ограничение снимается), типы, которых нет в списке, удаляются.
  // batteryLowerBound и telemetry дублируют новые поля: так их пропускает прокси в IoT Core
  const body = {
    batteryLimit: battery,
    telemetryLimits,
    batteryLowerBound: battery,
    telemetry: telemetryLimits
  };

  try {
    const r = await api('PUT',
      '/api/devices/' + encodeURIComponent(settingsDevice.deviceId) + '/limits', body);
    if (r.status === 200 && r.data) {
      fillSettings(r.data, settingsDevice);
      $('settings-dialog').close();
      toast('Настройки сохранены');
    } else {
      console.error('Сохранение лимитов: ответ', r.status, r.data);
      setMessage($('st-message'), formatErrors(r.data, 'Не удалось сохранить настройки (код ' + r.status + ')'));
    }
  } catch (err) {
    fail(err);
  }
});

/* ---------------- профиль ---------------- */

function showProfileMode(editing) {
  $('profile-card').hidden = editing;
  $('profile-actions').hidden = editing;
  $('profile-form').hidden = !editing;
}

function renderProfile(u) {
  fillKv($('profile-card'), [
    ['ID', { text: u.id, copy: true }],
    ['Email', dash(u.email)],
    ['Имя пользователя', dash(u.username)],
    ['Телефон', dash(u.phone)],
    ['Дата рождения', formatBirthDate(u.dateOfBirth)],
    ['Роль', dash(u.role)]
  ]);
}

async function loadProfile() {
  showProfileMode(false);
  setMessage($('profile-message'), '');
  const userId = getUserId();
  if (!userId) { openAuth(); return; }
  try {
    const r = await api('GET', '/api/users/' + encodeURIComponent(userId));
    if (r.status === 200 && r.data) {
      currentUser = r.data;
      applyRole();
      renderProfile(currentUser);
    } else if (r.status === 404) {
      logout();
      toast('Пользователь не найден', true);
    } else {
      console.error('Профиль: ответ', r.status);
      toast(formatErrors(r.data, 'Не удалось загрузить профиль'), true);
    }
  } catch (err) {
    fail(err);
  }
}

$('edit-profile').addEventListener('click', () => {
  if (!currentUser) return;
  $('prof-username').value = currentUser.username ?? '';
  $('prof-phone').value = currentUser.phone ?? '';
  $('prof-dob').value = currentUser.dateOfBirth ?? '';
  $('prof-dob').max = new Date().toISOString().slice(0, 10);
  $('prof-password').value = '';
  setMessage($('profile-message'), '');
  showProfileMode(true);
});

$('profile-cancel').addEventListener('click', () => {
  $('prof-password').value = '';
  showProfileMode(false);
});

$('profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const userId = getUserId();
  if (!userId || !currentUser) return;

  // отправляем только изменённые поля; пустые не отправляем (бэкенд не меняет поле, если оно не пришло)
  const body = {};
  const username = $('prof-username').value.trim();
  const phone = $('prof-phone').value.trim();
  const dob = $('prof-dob').value;
  const password = $('prof-password').value;

  if (username && username !== (currentUser.username ?? '')) body.username = username;
  if (phone && phone !== (currentUser.phone ?? '')) body.phone = phone;
  if (dob && dob !== (currentUser.dateOfBirth ?? '')) body.dateOfBirth = dob;
  if (password) body.password = password;

  if (Object.keys(body).length === 0) {
    setMessage($('profile-message'), 'Нет изменений для сохранения');
    return;
  }

  try {
    const r = await api('PUT', '/api/users/' + encodeURIComponent(userId), body);
    $('prof-password').value = '';
    if (r.status === 200 && r.data) {
      currentUser = r.data;
      renderProfile(currentUser);
      showProfileMode(false);
      toast('Данные сохранены');
    } else if (r.status === 400) {
      setMessage($('profile-message'), formatErrors(r.data));
    } else if (r.status === 404) {
      logout();
      toast('Пользователь не найден', true);
    } else {
      console.error('Сохранение профиля: ответ', r.status);
      toast(formatErrors(r.data, 'Не удалось сохранить данные'), true);
    }
  } catch (err) {
    fail(err);
  }
});

$('delete-account').addEventListener('click', async () => {
  if (!confirm('Удалить аккаунт? Это действие нельзя отменить.')) return;
  const userId = getUserId();
  try {
    const r = await api('DELETE', '/api/users/' + encodeURIComponent(userId));
    if (r.status === 204 || r.status === 404) {
      logout();
      toast('Аккаунт удалён');
    } else {
      console.error('Удаление аккаунта: код ответа', r.status, r.data);
      toast(formatErrors(r.data, 'Не удалось удалить аккаунт (код ' + r.status + ')'), true);
    }
  } catch (err) {
    fail(err);
  }
});

/* ==========================================================================
   НОВОЕ: модалка телеметрии (график реального времени, норма, средние)
   ========================================================================== */

const TM_POLL_MS = 5000;   // график опрашивает сервер каждые 5 секунд
const TM_POINTS = 60;      // сколько последних показаний рисуем
const tm = { device: null, type: null, lower: null, upper: null, points: [], timer: null, ticket: 0, geom: null };

const isOut = (v) => (tm.lower !== null && v < tm.lower) || (tm.upper !== null && v > tm.upper);

async function openTelemetry(device, type) {
  const info = typeInfo(type);
  tm.device = device;
  tm.type = type;
  tm.lower = null;
  tm.upper = null;
  tm.points = [];
  tm.geom = null;

  $('tm-ico').replaceChildren(icon(info.icon));
  $('tm-title').textContent = info.name + (info.unit ? ', ' + info.unit : '');
  $('tm-sub').textContent = 'Устройство: ' + dash(device.name) + ', тип ' + type;
  $('tm-current').textContent = '—';
  $('tm-current-note').textContent = '';
  $('tm-avg-hour').textContent = '—';
  $('tm-avg-hour-note').textContent = '';
  $('tm-tip').hidden = true;
  updateNormStat();
  $('tm-since').value = toLocalInput(new Date(Date.now() - 3600 * 1000));
  setMessage($('tm-since-result'), '');

  $('tm-dialog').showModal();
  renderChart();
  await loadChartLimits();
  await refreshTelemetry();
  if (!$('tm-dialog').open) return;   // пока грузилось, окно закрыли
  clearInterval(tm.timer);
  tm.timer = setInterval(refreshTelemetry, TM_POLL_MS);
}

function closeTelemetry() {
  clearInterval(tm.timer);
  tm.timer = null;
  tm.ticket++;   // ответы запросов, которые ещё в пути, будут отброшены
}

$('tm-dialog').addEventListener('close', closeTelemetry);
$('tm-close').addEventListener('click', () => $('tm-dialog').close());

/** Границы нормы берём из тех же настроек устройства, что и в окне «Настройки». */
async function loadChartLimits() {
  try {
    const r = await api('GET', '/api/devices/' + encodeURIComponent(tm.device.deviceId) + '/limits');
    if (r.status === 200 && r.data) {
      const list = r.data.telemetryLimits ?? r.data.telemetry ?? [];
      const mine = list.find((l) => Number(l.telemetryType) === Number(tm.type));
      tm.lower = mine && mine.lowerBound !== null && mine.lowerBound !== undefined ? Number(mine.lowerBound) : null;
      tm.upper = mine && mine.upperBound !== null && mine.upperBound !== undefined ? Number(mine.upperBound) : null;
    }
  } catch (err) {
    console.error(err);
  }
  updateNormStat();
}

function updateNormStat() {
  const unit = typeInfo(tm.type).unit;
  let text = 'не задана';
  if (tm.lower !== null && tm.upper !== null) text = `${fmtNum(tm.lower)} … ${fmtValue(tm.upper, unit)}`;
  else if (tm.lower !== null) text = 'от ' + fmtValue(tm.lower, unit);
  else if (tm.upper !== null) text = 'до ' + fmtValue(tm.upper, unit);
  $('tm-norm').textContent = text;
  $('tm-norm-note').textContent = tm.lower === null && tm.upper === null ? 'Задаётся в настройках устройства' : '';
}

async function refreshTelemetry() {
  if (!$('tm-dialog').open) return;
  const ticket = ++tm.ticket;
  const id = encodeURIComponent(tm.device.deviceId);
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  try {
    const [series, avg] = await Promise.all([
      api('GET', `/api/devices/${id}/telemetry?type=${tm.type}&limit=${TM_POINTS}`),
      api('GET', `/api/devices/${id}/telemetry/average?type=${tm.type}&since=${encodeURIComponent(hourAgo)}`)
    ]);
    if (ticket !== tm.ticket || !$('tm-dialog').open) return;   // устаревший ответ
    if (series.status === 200 && Array.isArray(series.data)) {
      tm.points = series.data
        .map((p) => ({ t: toDate(p.time).getTime(), v: Number(p.value) }))
        .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
      updateCurrent();
      renderChart();
    }
    if (avg.status === 200 && avg.data) updateHourAverage(avg.data);
  } catch (err) {
    console.error(err);   // опрос идёт в фоне: тостами не спамим
  }
}

function updateCurrent() {
  const unit = typeInfo(tm.type).unit;
  const last = tm.points[tm.points.length - 1];
  const box = $('tm-current').parentElement;
  if (!last) {
    $('tm-current').textContent = '—';
    $('tm-current-note').textContent = 'Показаний пока нет';
    box.classList.remove('out');
    return;
  }
  $('tm-current').textContent = fmtValue(last.v, unit);
  $('tm-current-note').textContent = isOut(last.v) ? 'Вне нормы, ' + timeAgo(new Date(last.t)) : timeAgo(new Date(last.t));
  box.classList.toggle('out', isOut(last.v));
}

function updateHourAverage(data) {
  const unit = typeInfo(tm.type).unit;
  if (data.average === null || data.average === undefined) {
    $('tm-avg-hour').textContent = '—';
    $('tm-avg-hour-note').textContent = 'За последний час показаний нет';
    return;
  }
  $('tm-avg-hour').textContent = fmtValue(Number(data.average), unit);
  const n = Number(data.count) || 0;
  $('tm-avg-hour-note').textContent = `по ${n} ${plural(n, 'показанию', 'показаниям', 'показаниям')}`;
}

/* среднее с выбранного времени */
$('tm-since-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('tm-since-result');
  const value = $('tm-since').value;
  if (!value) { setMessage(out, 'Укажите время'); return; }
  const since = new Date(value);   // datetime-local трактуется в часовом поясе браузера
  if (Number.isNaN(since.getTime())) { setMessage(out, 'Некорректное время'); return; }
  if (since.getTime() > Date.now()) { setMessage(out, 'Время не может быть в будущем'); return; }

  try {
    const r = await api('GET', '/api/devices/' + encodeURIComponent(tm.device.deviceId) +
      `/telemetry/average?type=${tm.type}&since=${encodeURIComponent(since.toISOString())}`);
    if (r.status === 200 && r.data) {
      const unit = typeInfo(tm.type).unit;
      const from = since.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
      if (r.data.average === null || r.data.average === undefined) {
        setMessage(out, `С ${from} показаний нет`);
      } else {
        const n = Number(r.data.count) || 0;
        setMessage(out, `Среднее с ${from}: ${fmtValue(Number(r.data.average), unit)} (${n} ${plural(n, 'показание', 'показания', 'показаний')})`, 'ok');
      }
    } else {
      setMessage(out, formatErrors(r.data, 'Не удалось получить среднее'));
    }
  } catch (err) {
    fail(err);
  }
});

/* ---- график: самодельный SVG, без библиотек ---- */

function axisFormatter(range) {
  const digits = range >= 20 ? 0 : range >= 2 ? 1 : 2;
  return (v) => v.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function renderChart() {
  const svg = $('tm-chart');
  const W = Math.max(300, Math.round($('tm-chart-wrap').clientWidth || 640));
  const H = W < 480 ? 240 : 290;
  const m = { l: 50, r: 14, t: 16, b: 30 };
  const pts = tm.points;
  const unit = typeInfo(tm.type).unit;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  $('tm-empty').hidden = pts.length > 0;

  // диапазон по Y включает и линии нормы, чтобы они всегда были видны
  let lo = Infinity, hi = -Infinity;
  const take = (v) => { if (v !== null && Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } };
  pts.forEach((p) => take(p.v));
  take(tm.lower);
  take(tm.upper);
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12;
  lo -= pad; hi += pad;

  let t0 = pts.length ? pts[0].t : Date.now() - 3600 * 1000;
  let t1 = pts.length ? pts[pts.length - 1].t : Date.now();
  if (t1 - t0 < 60 * 1000) { t0 -= 30 * 60 * 1000; t1 += 30 * 60 * 1000; }   // одна точка: рисуем по центру
  const X = (t) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const fmtY = axisFormatter(hi - lo);

  let g = '<defs>'
    + '<linearGradient id="tm-area" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#22e4ff" stop-opacity=".32"/><stop offset="1" stop-color="#22e4ff" stop-opacity="0"/>'
    + '</linearGradient></defs>';

  // сетка и подписи оси Y
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4;
    const y = Y(v);
    g += `<line class="ch-grid" x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}"/>`;
    g += `<text class="ch-axis" x="${m.l - 8}" y="${y + 4}" text-anchor="end">${fmtY(v)}</text>`;
  }
  if (unit) g += `<text class="ch-axis" x="${m.l - 8}" y="${m.t - 5}" text-anchor="end">${unit}</text>`;

  // ось X
  const span = t1 - t0;
  const ticks = W < 480 ? 3 : 5;
  for (let i = 0; i < ticks; i++) {
    const t = t0 + (span * i) / (ticks - 1);
    const d = new Date(t);
    const label = span > 24 * 3600 * 1000
      ? d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const anchor = i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle';
    g += `<text class="ch-axis" x="${X(t)}" y="${H - 8}" text-anchor="${anchor}">${label}</text>`;
  }

  // линии границ нормы
  if (tm.upper !== null) {
    const y = Y(tm.upper);
    g += `<line class="ch-limit-up" x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}"/>`;
    g += `<text class="ch-tag-up" x="${W - m.r - 4}" y="${y - 5}" text-anchor="end">верхняя граница ${fmtNum(tm.upper)}</text>`;
  }
  if (tm.lower !== null) {
    const y = Y(tm.lower);
    g += `<line class="ch-limit-lo" x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}"/>`;
    g += `<text class="ch-tag-lo" x="${W - m.r - 4}" y="${y + 14}" text-anchor="end">нижняя граница ${fmtNum(tm.lower)}</text>`;
  }

  // линия, заливка, точки
  if (pts.length >= 2) {
    const line = pts.map((p, i) => (i ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.v).toFixed(1)).join(' ');
    const base = H - m.b;
    g += `<path d="${line} L${X(pts[pts.length - 1].t).toFixed(1)} ${base} L${X(pts[0].t).toFixed(1)} ${base} Z" fill="url(#tm-area)"/>`;
    g += `<path class="ch-line" d="${line}"/>`;
  }
  pts.forEach((p) => {
    g += `<circle class="ch-dot${isOut(p.v) ? ' out' : ''}" cx="${X(p.t).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="2.6"/>`;
  });
  if (pts.length) {
    const last = pts[pts.length - 1];
    g += `<circle class="ch-ring" cx="${X(last.t).toFixed(1)}" cy="${Y(last.v).toFixed(1)}" r="4"/>`;
    g += `<circle class="ch-last" cx="${X(last.t).toFixed(1)}" cy="${Y(last.v).toFixed(1)}" r="4.5"/>`;
  }
  g += `<g id="tm-hover" class="ch-hover" hidden><line y1="${m.t}" y2="${H - m.b}"/><circle r="5"/></g>`;

  svg.innerHTML = g;
  tm.geom = { W, H, m, X, Y, pts };
}

// подсказка при наведении: ближайшая точка по оси X
$('tm-chart').addEventListener('pointermove', (e) => {
  const g = tm.geom;
  if (!g || !g.pts.length) return;
  const rect = $('tm-chart').getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * g.W;
  let best = g.pts[0], dist = Infinity;
  for (const p of g.pts) {
    const d = Math.abs(g.X(p.t) - x);
    if (d < dist) { dist = d; best = p; }
  }
  const cx = g.X(best.t), cy = g.Y(best.v);
  const hover = $('tm-chart').querySelector('#tm-hover');
  if (hover) {
    hover.removeAttribute('hidden');
    const line = hover.querySelector('line');
    line.setAttribute('x1', cx); line.setAttribute('x2', cx);
    const dot = hover.querySelector('circle');
    dot.setAttribute('cx', cx); dot.setAttribute('cy', cy);
  }
  const tip = $('tm-tip');
  tip.textContent = fmtValue(best.v, typeInfo(tm.type).unit) + ', ' +
    new Date(best.t).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'medium' });
  tip.style.left = Math.min(Math.max((cx / g.W) * 100, 14), 86) + '%';
  tip.style.top = (cy / g.H) * 100 + '%';
  tip.hidden = false;
});
$('tm-chart').addEventListener('pointerleave', () => {
  $('tm-tip').hidden = true;
  const hover = $('tm-chart').querySelector('#tm-hover');
  if (hover) hover.setAttribute('hidden', '');
});
window.addEventListener('resize', () => { if ($('tm-dialog').open) renderChart(); });

/* ==========================================================================
   НОВОЕ: вкладка «Пользователи» (только для админов)
   ========================================================================== */

const isAdmin = () => !!currentUser && currentUser.role === 'ADMIN';

/** Показывает вкладку «Пользователи» только админу. */
function applyRole() {
  $('nav-users').hidden = !isAdmin();
}

/** Те же правила, что у списка устройств: страницами по PAGE_SIZE («Показать ещё») и поиск (здесь по email). */
async function loadUsers(append = false) {
  const userId = getUserId();
  if (!userId) { openAuth(); return; }
  if (!isAdmin()) return;
  if (!append) {
    usrState.offset = 0;
    usrState.items = [];
    usrState.hasMore = false;
  }
  const params = new URLSearchParams({
    requesterId: userId,
    limit: String(PAGE_SIZE + 1),   // на 1 больше, чтобы знать, есть ли следующая страница
    offset: String(usrState.offset)
  });
  if (usrState.search) params.set('search', usrState.search);

  const ticket = ++usrState.ticket;
  try {
    const r = await api('GET', '/api/users?' + params.toString());
    if (ticket !== usrState.ticket) return;
    if (r.status === 403) {
      toast('Раздел доступен только администраторам', true);
      showView('devices');
      return;
    }
    if (!r.ok || !Array.isArray(r.data)) {
      console.error('Список пользователей: ответ', r.status);
      toast(formatErrors(r.data, 'Не удалось загрузить пользователей'), true);
      return;
    }
    const page = r.data.slice(0, PAGE_SIZE);
    usrState.items = append ? usrState.items.concat(page) : page;
    usrState.offset += page.length;
    usrState.hasMore = r.data.length > PAGE_SIZE;
    renderUsers();
  } catch (err) {
    fail(err);
  }
}

function badge(text, cls) {
  const s = document.createElement('span');
  s.className = 'badge ' + cls;
  s.textContent = text;
  return s;
}

function renderUsers() {
  const list = $('users-list');
  list.replaceChildren();
  if (usrState.items.length === 0) {
    $('users-empty-text').textContent = usrState.search
      ? 'Пользователей с такой почтой не найдено.'
      : 'Пользователей пока нет.';
    $('users-empty').hidden = false;
  } else {
    $('users-empty').hidden = true;
  }
  $('users-more-btn').hidden = !usrState.hasMore;

  usrState.items.forEach((u, i) => {
    const rowEl = document.createElement('article');
    rowEl.className = 'user-row';
    rowEl.style.animationDelay = Math.min(i, 9) * 30 + 'ms';

    const ava = document.createElement('span');
    ava.className = 'ur-ava';
    ava.append(icon(u.role === 'ADMIN' ? 'shield' : 'user'));

    const main = document.createElement('div');
    main.className = 'ur-main';
    const email = document.createElement('strong');
    email.textContent = dash(u.email);
    const name = document.createElement('span');
    name.className = 'muted small';
    name.textContent = dash(u.username);
    main.append(email, name);

    const badges = document.createElement('div');
    badges.className = 'ur-badges';
    const confirmed = u.isConfirmed ?? u.confirmed;
    badges.append(
      badge(u.role === 'ADMIN' ? 'Админ' : 'Гость', u.role === 'ADMIN' ? 'admin' : 'off'),
      confirmed === false ? badge('Не подтверждён', 'warn') : badge('Подтверждён', 'on')
    );

    const idBox = document.createElement('div');
    idBox.className = 'ur-id';
    const code = document.createElement('code');
    code.textContent = u.id;
    code.title = u.id;
    idBox.append(code, copyButton(u.id));

    rowEl.append(ava, main, badges, idBox);
    list.append(rowEl);
  });
}

let usersSearchTimer = null;
function applyUsersSearch(value) {
  usrState.search = value || null;
  $('users-search-clear').hidden = !value;
  loadUsers();
}
$('users-search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(usersSearchTimer);
  applyUsersSearch($('users-search-input').value.trim());
});
$('users-search-input').addEventListener('input', () => {
  const value = $('users-search-input').value.trim();
  $('users-search-clear').hidden = !value;
  clearTimeout(usersSearchTimer);
  usersSearchTimer = setTimeout(() => {
    if ((usrState.search || '') !== value) applyUsersSearch(value);
  }, 300);
});
$('users-search-clear').addEventListener('click', () => {
  clearTimeout(usersSearchTimer);
  $('users-search-input').value = '';
  applyUsersSearch('');
});
$('users-more-btn').addEventListener('click', () => loadUsers(true));

/* ==========================================================================
   НОВОЕ: вкладка «Уведомления»: частота для Email и Telegram
   ========================================================================== */

const FREQ_PRESETS = [
  { value: '0', label: 'Сразу' },
  { value: '300', label: 'Каждые 5 минут' },
  { value: '1800', label: 'Каждые 30 минут' },
  { value: '3600', label: 'Каждый час' },
  { value: '86400', label: 'Раз в день' },
  { value: 'custom', label: 'Свой интервал…' }
];
const CHANNEL_FIELDS = { email: 'emailIntervalSeconds', telegram: 'telegramIntervalSeconds' };
const MIN_INTERVAL = 60;
const MAX_INTERVAL = 7 * 24 * 3600;   // совпадает с ограничением на бэкенде

/** 300 -> «каждые 5 минут», 3600 -> «каждый час», 0 -> «сразу». */
function intervalText(sec) {
  if (sec === 0) return 'сразу';
  const units = [[86400, 'каждый день', 'день', 'дня', 'дней'], [3600, 'каждый час', 'час', 'часа', 'часов'], [60, 'каждую минуту', 'минуту', 'минуты', 'минут']];
  for (const [size, single, one, few, many] of units) {
    if (sec % size === 0) {
      const n = sec / size;
      return n === 1 ? single : `каждые ${n} ${plural(n, one, few, many)}`;
    }
  }
  return `каждые ${sec} с`;
}

function updateChannelHint(channel, seconds) {
  $(channel + '-hint').textContent = seconds === 0
    ? 'Каждое событие приходит отдельным сообщением.'
    : `События со всех ваших устройств копятся и приходят одним общим сообщением ${intervalText(seconds)}.`;
}

/** Выставляет селект и поля «свой интервал» по числу секунд с сервера. */
function setChannelUi(channel, seconds) {
  const select = $(channel + '-freq');
  const preset = FREQ_PRESETS.find((p) => p.value === String(seconds));
  if (preset) {
    select.value = preset.value;
  } else {
    select.value = 'custom';
    const unit = seconds % 86400 === 0 ? 86400 : seconds % 3600 === 0 ? 3600 : 60;
    $(channel + '-custom-unit').value = String(unit);
    $(channel + '-custom-value').value = String(Math.max(1, Math.round(seconds / unit)));
  }
  $(channel + '-custom').hidden = select.value !== 'custom';
  updateChannelHint(channel, seconds);
}

/** -> число секунд или {error}. */
function readChannelSeconds(channel) {
  const choice = $(channel + '-freq').value;
  if (choice !== 'custom') return Number(choice);
  const n = Number($(channel + '-custom-value').value);
  if (!Number.isInteger(n) || n < 1) return { error: 'Введите целое число больше нуля' };
  const seconds = n * Number($(channel + '-custom-unit').value);
  if (seconds < MIN_INTERVAL || seconds > MAX_INTERVAL) return { error: 'Интервал: от 1 минуты до 7 дней' };
  return seconds;
}

async function loadNotificationPrefs() {
  $('email-target').textContent = currentUser && currentUser.email ? 'Письма приходят на ' + currentUser.email : '';
  const userId = getUserId();
  if (!userId) return;
  try {
    const r = await api('GET', '/api/users/' + encodeURIComponent(userId) + '/notification-preferences');
    if (r.status === 200 && r.data) {
      for (const [channel, field] of Object.entries(CHANNEL_FIELDS)) {
        setChannelUi(channel, Number(r.data[field]) || 0);
        setMessage($(channel + '-message'), '');
      }
    } else {
      console.error('Настройки уведомлений: ответ', r.status);
      toast(formatErrors(r.data, 'Не удалось загрузить настройки уведомлений'), true);
    }
  } catch (err) {
    fail(err);
  }
}

async function saveChannel(channel) {
  const msg = $(channel + '-message');
  setMessage(msg, '');
  const seconds = readChannelSeconds(channel);
  if (typeof seconds === 'object') { setMessage(msg, seconds.error); return; }
  const userId = getUserId();
  if (!userId) { openAuth(); return; }
  try {
    // отправляем только этот канал: второй бэкенд не меняет
    const r = await api('PUT', '/api/users/' + encodeURIComponent(userId) + '/notification-preferences',
      { [CHANNEL_FIELDS[channel]]: seconds });
    if (r.status === 200 && r.data) {
      for (const [ch, field] of Object.entries(CHANNEL_FIELDS)) setChannelUi(ch, Number(r.data[field]) || 0);
      toast('Настройки ' + (channel === 'email' ? 'Email' : 'Telegram') + ' сохранены');
    } else if (r.status === 400) {
      setMessage(msg, formatErrors(r.data));
    } else {
      console.error('Сохранение настроек уведомлений: ответ', r.status);
      toast(formatErrors(r.data, 'Не удалось сохранить настройки'), true);
    }
  } catch (err) {
    fail(err);
  }
}

function initChannels() {
  for (const channel of Object.keys(CHANNEL_FIELDS)) {
    const select = $(channel + '-freq');
    for (const p of FREQ_PRESETS) {
      const opt = document.createElement('option');
      opt.value = p.value;
      opt.textContent = p.label;
      select.append(opt);
    }
    select.addEventListener('change', () => {
      $(channel + '-custom').hidden = select.value !== 'custom';
      if (select.value !== 'custom') updateChannelHint(channel, Number(select.value));
    });
    $(channel + '-save').addEventListener('click', () => saveChannel(channel));
  }
  setChannelUi('email', 0);
  setChannelUi('telegram', 0);
}

/* ==========================================================================
   НОВОЕ: вкладка «Описание»: таблица типов телеметрии; подсказки для окна настроек
   ========================================================================== */

function renderLegend() {
  const body = $('types-table').querySelector('tbody');
  body.replaceChildren();
  for (const [type, info] of Object.entries(TELEMETRY_TYPES)) {
    const tr = document.createElement('tr');
    const code = document.createElement('td');
    code.textContent = type;
    const name = document.createElement('td');
    name.append(icon(info.icon), document.createTextNode(info.name));
    const unit = document.createElement('td');
    unit.textContent = info.unit || '—';
    tr.append(code, name, unit);
    body.append(tr);
  }
}

function fillTypesDatalist() {
  const list = $('st-types');
  list.replaceChildren();
  for (const [type, info] of Object.entries(TELEMETRY_TYPES)) {
    const opt = document.createElement('option');
    opt.value = type;
    opt.label = info.name + (info.unit ? ' (' + info.unit + ')' : '');
    list.append(opt);
  }
}

/* ---------------- старт ---------------- */

$('about-text').textContent = ABOUT_TEXT;
$('telegram-link').href = TELEGRAM_BOT_URL;
renderLegend();        // НОВОЕ: таблица типов телеметрии на вкладке «Описание»
fillTypesDatalist();   // НОВОЕ: подсказки типов в окне настроек
initChannels();        // НОВОЕ: окна Email и Telegram на вкладке «Уведомления»

if (getUserId()) {
  enterMain();
} else if (sessionStorage.getItem('pendingUserId')) {
  // страницу обновили посреди подтверждения: возвращаем на экран 2
  setMessage($('confirm-message'), '');
  showScreen('confirm');
} else {
  showScreen('auth');
}
