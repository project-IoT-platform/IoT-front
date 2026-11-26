const TELEGRAM_BOT_URL = 'https://t.me/IoT_NotifierBot';

// Адрес API (CORS на бэкенде разрешает страницы с localhost:3001 и 127.0.0.1:3001)
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
  $('screen-startup').hidden = true;
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
async function api(method, path, body, signal) {
  const options = { method, headers: {}, signal };
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

/* ---------------- сессия ---------------- */

const getUserId = () => localStorage.getItem('userId');

function logout() {
  localStorage.removeItem('userId');
  devState.ticket++;
  devState.items = [];
  workspace.id = null;
  workspace.renderedDevice = null;
  workspace.ready = false;
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

let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === 'register';
  $('auth-title').textContent = registering ? 'Регистрация' : 'Вход в IoT Core';
  $('auth-subtitle').textContent = registering ? 'Создайте аккаунт в IoT Core.' : 'Войдите, чтобы открыть свои устройства.';
  $('auth-submit').textContent = registering ? 'Зарегистрироваться' : 'Войти';
  $('register-btn').textContent = registering ? 'Вернуться ко входу' : 'Зарегистрироваться';
  $('auth-repeat-field').hidden = !registering;
  $('forgot-password').hidden = registering;
  $('auth-password').autocomplete = registering ? 'new-password' : 'current-password';
  $('auth-password').value = '';
  $('auth-repeat').value = '';
  setMessage($('auth-message'), '');
}

function openAuth(message, kind = 'error') {
  $('login-form').reset();
  setAuthMode('login');
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
  if (authMode === 'register') { await registerAccount(creds); return; }

  try {
    const r = await api('POST', '/api/login', creds);
    $('auth-password').value = '';
    if (r.status === 200 && r.data && r.data.id) {
      localStorage.setItem('userId', r.data.id);
      await enterMain();
    } else if (r.status === 401) {
      setMessage($('auth-message'), 'Неверная почта или пароль');
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

$('register-btn').addEventListener('click', () => {
  setAuthMode(authMode === 'login' ? 'register' : 'login');
  $('auth-email').focus();
});

async function registerAccount(creds) {
  if (creds.password.length < 8) {
    setMessage($('auth-message'), 'Пароль должен содержать минимум 8 символов');
    return;
  }
  if (creds.password !== $('auth-repeat').value) {
    setMessage($('auth-message'), 'Пароли не совпадают');
    return;
  }

  try {
    const r = await api('POST', '/api/users', creds);
    $('auth-password').value = '';
    $('auth-repeat').value = '';
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
}

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

$('confirm-submit').addEventListener('click', () => {
  const id = $('confirm-id').value.trim();
  const pending = sessionStorage.getItem('pendingUserId');
  if (!pending) { openAuth(); return; }
  if (!id) { setMessage($('confirm-message'), 'Введите ID'); return; }

  // Сверяем ID из письма перед возвратом к форме входа.
  if (id.toLowerCase() !== pending.toLowerCase()) {
    setMessage($('confirm-message'), 'Неверный ID. Проверьте письмо и попробуйте ещё раз');
    return;
  }

  sessionStorage.removeItem('pendingUserId');
  openAuth('ID совпадает. Войдите с почтой и паролем.', 'ok');
});

$('confirm-cancel').addEventListener('click', async () => {
  await cancelPending();
  openAuth();
});

/* ---------------- экран 3: главная ---------------- */

async function enterMain() {
  const userId = getUserId();
  if (!userId) { openAuth(); return; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await api('GET', '/api/users/' + encodeURIComponent(userId), undefined, controller.signal);
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
  } finally {
    clearTimeout(timeout);
  }
  showScreen('main');
  showView('devices');
}

function setUserEmail(email) {
  $('user-email').textContent = email || '';
  $('sidebar-name').textContent = currentUser?.username || 'Профиль';
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

$('top-nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (button) showView(button.dataset.view);
});

$('sidebar-account').addEventListener('click', () => showView('profile'));

function showView(name) {
  if (name === 'users' && !isAdmin()) name = 'devices';   // НОВОЕ: чужим вкладку не открываем
  for (const [key, node] of Object.entries(views)) node.hidden = key !== name;
  document.querySelectorAll('.nav-item[data-view]').forEach((b) => {
    const active = b.dataset.view === name;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $('topbar-title').textContent = VIEW_TITLES[name] || '';
  closeDrawer();
  window.scrollTo(0, 0);
  if (name === 'devices') { syncRooms(); loadDevices(); startTilesPolling(); } else { stopTilesPolling(); }
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

  const room = selectedRoom();
  const ticket = ++devState.ticket;
  if (room) {
    try {
      const devices = await readDeviceCatalogue(userId, () => ticket === devState.ticket);
      if (ticket !== devState.ticket || userId !== getUserId()) return;
      const memberIds = new Set(room.devices);
      const query = devState.search?.toLocaleLowerCase() ?? '';
      devState.items = devices.filter(device => memberIds.has(device.deviceId) &&
        (device.name ?? '').toLocaleLowerCase().includes(query));
      renderDevices();
    } catch (error) {
      if (ticket === devState.ticket) {
        renderDevices();
        fail(error, 'Не удалось загрузить устройства группы');
      }
    }
    return;
  }
  const params = new URLSearchParams({ userId });
  if (devState.search) {
    params.set('search', devState.search);
  } else {
    params.set('limit', String(PAGE_SIZE + 1));
    params.set('offset', String(devState.offset));
  }

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

const workspace = { id: null, ticket: 0, chartTicket: 0, averageTicket: 0, inspectorTicket: 0, renderedDevice: null, limits: [], ready: false };

function activeDevice() {
  return devState.items.find(device => device.deviceId === workspace.id);
}

function renderDevices() {
  const list = $('devices-grid');
  const room = selectedRoom();
  list.replaceChildren();
  const device = activeDevice() || devState.items[0];
  workspace.id = device?.deviceId ?? null;
  $('devices-empty').hidden = Boolean(device);
  $('devices-empty-text').textContent = devState.search
    ? 'Устройств с таким названием не найдено.'
    : selectedRoom() ? 'В этой группе пока нет устройств.' : 'У вас пока нет устройств.';
  $('empty-room-add').hidden = !selectedRoom() || Boolean(device) || Boolean(devState.search);
  $('more-btn').hidden = !devState.hasMore;
  $('device-workspace').hidden = !device;
  for (const item of devState.items) {
    const selected = item.deviceId === workspace.id;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'device-list-item';
    button.setAttribute('aria-pressed', String(selected));
    const label = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = dash(item.name);
    const id = document.createElement('code');
    id.textContent = item.deviceId;
    id.title = item.deviceId;
    label.append(name, id);
    button.append(icon('cpu'), label);
    button.addEventListener('click', () => {
      if (selected) return;
      workspace.id = item.deviceId;
      renderDevices();
      list.querySelector('[aria-pressed="true"]')?.focus();
    });
    if (room) {
      const row = document.createElement('div');
      row.className = 'room-device-row';
      const remove = actionButton('', 'room-device-remove', () => removeRoomDevice(room, item), 'x');
      remove.setAttribute('aria-label', 'Убрать «' + dash(item.name) + '» из группы');
      remove.title = 'Убрать из группы';
      row.append(button, remove);
      list.append(row);
    } else {
      list.append(button);
    }
  }
  const changedDevice = workspace.renderedDevice !== workspace.id;
  if (changedDevice) {
    workspace.renderedDevice = workspace.id;
    hideInspector();
    resetAverage();
    workspace.limits = [];
    if (device) loadChartLimits(device.deviceId);
  }
  if (!device) return;

  $('workspace-device').textContent = dash(device.name);
  const id = document.createElement('code');
  id.textContent = device.deviceId;
  $('workspace-id').replaceChildren(id, copyButton(device.deviceId));
  $('workspace-actions').replaceChildren(
    actionButton('Настройки', '', () => openSettings(device), 'sliders')
  );
  if (!changedDevice && workspace.ready) return;
  workspace.ready = false;
  $('workspace-type').replaceChildren();
  $('workspace-reading-cards').replaceChildren();
  $('workspace-chart').replaceChildren();
  $('workspace-stats').replaceChildren();
  $('workspace-chart-message').hidden = false;
  $('workspace-chart-message').textContent = 'Загружаем показания…';
  $('workspace-since-form').querySelector('button').disabled = true;
  refreshWorkspace(device);
}

async function loadChartLimits(id) {
  try {
    const r = await api('GET', '/api/devices/' + encodeURIComponent(id) + '/limits');
    if (workspace.id !== id || !r.ok || !r.data) return;
    workspace.limits = r.data.telemetryLimits ?? r.data.telemetry ?? [];
    if (workspace.ready && workspace.limits.length) refreshWorkspaceChart();
  } catch {
    // The graph remains available when limits cannot be loaded.
  }
}

async function refreshWorkspace(device) {
  const ticket = ++workspace.ticket;
  try {
    const r = await api('GET', '/api/devices/' + encodeURIComponent(device.deviceId) + '/telemetry/latest');
    if (ticket !== workspace.ticket || workspace.id !== device.deviceId) return;
    if (!r.ok || !Array.isArray(r.data)) throw new Error('Не удалось загрузить показания');
    const readings = r.data;
    const cards = $('workspace-reading-cards');
    renderTiles(cards, readings);
    const battery = document.createElement('div');
    battery.className = 'workspace-battery';
    battery.append(textNode('Заряд'), batteryNode(device.batteryLevel));
    cards.append(battery);

    const select = $('workspace-type');
    const previous = select.value;
    const types = readings.map(row => String(row.telemetryType)).sort((a, b) => Number(a) - Number(b));
    select.replaceChildren(...types.map(value => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = typeInfo(Number(value)).name;
      return option;
    }));
    if (types.includes(previous)) select.value = previous;
    if (previous && previous !== select.value) resetAverage();
    updateWorkspaceMetric();
    select.disabled = types.length === 0;
    $('workspace-since-form').querySelector('button').disabled = select.disabled;
    workspace.ready = true;
    refreshWorkspaceChart();
  } catch (err) {
    if (ticket !== workspace.ticket || workspace.id !== device.deviceId || workspace.ready) return;
    $('workspace-chart-message').textContent = 'Не удалось загрузить показания';
  }
}

function svgPart(tag, attrs, value) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, attr] of Object.entries(attrs)) node.setAttribute(name, attr);
  if (value !== undefined) node.textContent = value;
  return node;
}

let chartGeometry;

function drawWorkspaceChart(points, from, to, type, unit) {
  const svg = $('workspace-chart');
  svg.replaceChildren();
  delete svg.dataset.pointIndex;
  const min = Math.min(...points.map(point => point.value));
  const max = Math.max(...points.map(point => point.value));
  const limit = workspace.limits.find(row => Number(row.telemetryType) === Number(type));
  const bounds = [['Мин. порог', limit?.lowerBound], ['Макс. порог', limit?.upperBound]]
    .filter(([, value]) => Number.isFinite(value));
  const lowValue = Math.min(min, ...bounds.map(([, value]) => value));
  const highValue = Math.max(max, ...bounds.map(([, value]) => value));
  const padding = Math.max((highValue - lowValue) * .12, .25);
  const low = lowValue - padding;
  const high = highValue + padding;
  const x = time => 64 + (time - from) / (to - from) * 632;
  const y = value => 218 - (value - low) / (high - low) * 196;
  for (let i = 0; i <= 4; i++) {
    const value = low + (high - low) * i / 4;
    const line = y(value);
    const time = from + (to - from) * i / 4;
    svg.append(svgPart('line', {x1:64, y1:line, x2:696, y2:line, class:'workspace-gridline'}),
      svgPart('text', {x:56, y:line+4, 'text-anchor':'end'}, fmtValue(value, unit)),
      svgPart('text', {x:x(time), y:242, 'text-anchor':i === 4 ? 'end' : i === 0 ? 'start' : 'middle'},
        new Date(time).toLocaleString('ru-RU', {
          ...(new Date(from).toDateString() !== new Date(to).toDateString() ? {day:'2-digit', month:'2-digit'} : {}),
          hour:'2-digit', minute:'2-digit'
        })));
  }
  chartGeometry = {points, x, y, unit};
  const defs = svgPart('defs', {});
  const gradient = svgPart('linearGradient', {id:'workspace-area', x1:'0', y1:'0', x2:'0', y2:'1'});
  gradient.append(svgPart('stop', {offset:'0%', 'stop-color':'#963dff','stop-opacity':'.66'}),
    svgPart('stop', {offset:'100%', 'stop-color':'#963dff','stop-opacity':'.04'}));
  defs.append(gradient);
  const trace = points.map(point => x(point.time) + ',' + y(point.value)).join(' ');
  svg.append(defs,
    svgPart('polygon', {points: x(points[0].time) + ',218 ' + trace + ' ' + x(points.at(-1).time) + ',218', fill:'url(#workspace-area)'}),
    svgPart('polyline', {points:trace, class:'workspace-trace'}),
    svgPart('circle', {cx:x(points.at(-1).time), cy:y(points.at(-1).value), r:4, class:'workspace-point'}));
  for (const [label, value] of bounds) {
    const line = y(value);
    svg.append(svgPart('line', {x1:64, y1:line, x2:696, y2:line, class:'workspace-threshold'}),
      svgPart('text', {x:690, y:line-5, 'text-anchor':'end'}, label + ' ' + fmtValue(value, unit)));
  }
  const stats = $('workspace-stats');
  const mean = points.reduce((sum, point) => sum + point.value, 0) / points.length;
  stats.replaceChildren(...[['Мин.', min], ['Макс.', max], ['Среднее', mean]].map(([label, value]) => {
    const cell = document.createElement('div');
    const reading = document.createElement('strong');
    reading.textContent = fmtValue(value, unit);
    cell.append(textNode(label), reading);
    return cell;
  }));
}

async function refreshWorkspaceChart() {
  const device = activeDevice();
  if (!device) return;
  const type = $('workspace-type').value;
  const chart = $('workspace-chart');
  const message = $('workspace-chart-message');
  const ticket = ++workspace.chartTicket;
  $('workspace-range-note').hidden = true;
  $('workspace-point-tip').hidden = true;
  chartGeometry = null;
  if (type === '') {
    chart.replaceChildren();
    $('workspace-stats').replaceChildren();
    message.hidden = false;
    message.textContent = 'Показаний пока нет';
    return;
  }

  try {
    const path = '/api/devices/' + encodeURIComponent(device.deviceId) + '/telemetry';
    const preset = $('workspace-period').querySelector(':checked');
    const startInput = $('workspace-start');
    const to = Date.now();
    const from = startInput.value ? new Date(startInput.value).getTime() : to - Number(preset.value);
    if (startInput.value && (!Number.isFinite(from) || from >= to)) {
      chart.replaceChildren();
      $('workspace-stats').replaceChildren();
      message.hidden = false;
      message.textContent = 'Укажите дату и время в прошлом';
      return;
    }
    const r = await api('GET', path + '?' + new URLSearchParams({type, limit:'1000'}));
    if (ticket !== workspace.chartTicket || workspace.id !== device.deviceId) return;
    if (!r.ok || !Array.isArray(r.data)) throw new Error('Не удалось загрузить график');

    const points = r.data.map(row => ({time: toDate(row.time).getTime(), value: Number(row.value)}))
      .filter(point => point.time >= from && point.time <= to && Number.isFinite(point.value))
      .sort((a, b) => a.time - b.time);
    const note = $('workspace-range-note');
    note.hidden = r.data.length < 1000 || points.length < 1000;
    if (!note.hidden) note.textContent = 'График показывает до 1000 последних показаний за выбранный период.';
    if (points.length) {
      message.hidden = true;
      drawWorkspaceChart(points, from, to, type, typeInfo(Number(type)).unit);
    } else {
      chart.replaceChildren();
      $('workspace-stats').replaceChildren();
      message.hidden = false;
      message.textContent = 'За выбранный период показаний нет';
    }
  } catch (err) {
    if (ticket !== workspace.chartTicket || workspace.id !== device.deviceId) return;
    chart.replaceChildren();
    $('workspace-stats').replaceChildren();
    message.hidden = false;
    message.textContent = 'Не удалось загрузить график';
  }
}

function showWorkspacePoint(index) {
  const {points, x, y, unit} = chartGeometry;
  const point = points[index];
  const svg = $('workspace-chart');
  const old = svg.querySelector('.workspace-cursor');
  old?.remove();
  svg.append(svgPart('circle', {cx: x(point.time), cy: y(point.value), r: 5, class: 'workspace-cursor'}));
  const tip = $('workspace-point-tip');
  tip.textContent = fmtValue(point.value, unit) + ' · ' + formatDate(new Date(point.time));
  tip.hidden = false;
  tip.style.left = Math.min(82, Math.max(18, x(point.time) / 7.2)) + '%';
  svg.dataset.pointIndex = String(index);
}

function hideWorkspacePoint() {
  $('workspace-point-tip').hidden = true;
  $('workspace-chart').querySelector('.workspace-cursor')?.remove();
}

$('workspace-chart').addEventListener('pointermove', event => {
  if (!chartGeometry) return;
  const svg = event.currentTarget;
  const matrix = svg.getScreenCTM();
  if (!matrix) return;
  const cursor = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  const {points, x} = chartGeometry;
  const nearest = points.reduce((best, point, index) =>
    Math.abs(x(point.time) - cursor.x) < Math.abs(x(points[best].time) - cursor.x) ? index : best, 0);
  showWorkspacePoint(nearest);
});
$('workspace-chart').addEventListener('pointerleave', hideWorkspacePoint);
$('workspace-chart').addEventListener('blur', hideWorkspacePoint);
$('workspace-chart').addEventListener('keydown', event => {
  if (!chartGeometry || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const last = chartGeometry.points.length - 1;
  const index = Number(event.currentTarget.dataset.pointIndex ?? last);
  const next = Math.max(0, Math.min(last, index + (event.key === 'ArrowRight' ? 1 : -1)));
  showWorkspacePoint(next);
});

const chartStart = $('workspace-start');
const clearChartStart = $('workspace-start-clear');
const chartPresets = $('workspace-period');
let lastChartPreset = chartPresets.querySelector(':checked');

function updateChartStart() {
  const custom = chartStart.value !== '';
  clearChartStart.hidden = !custom;
  lastChartPreset.checked = !custom;
  refreshWorkspaceChart();
}

chartStart.addEventListener('focus', () => {
  chartStart.max = toLocalInput(new Date());
});
chartStart.addEventListener('change', updateChartStart);
clearChartStart.addEventListener('click', () => {
  chartStart.value = '';
  updateChartStart();
  chartStart.focus();
});
chartPresets.addEventListener('change', event => {
  lastChartPreset = event.target;
  chartStart.value = '';
  updateChartStart();
});
function resetAverage() {
  workspace.averageTicket++;
  $('workspace-since').value = toLocalInput(new Date(Date.now() - 3600000));
  setMessage($('workspace-since-result'), '');
}

function updateWorkspaceMetric() {
  const selected = $('workspace-type').value;
  const heading = selected ? 'История · ' + typeInfo(Number(selected)).name : 'История показаний';
  $('workspace-chart-title').textContent = heading;
  for (const tile of $('workspace-reading-cards').querySelectorAll('[data-type]')) {
    tile.setAttribute('aria-pressed', String(tile.dataset.type === selected));
  }
}

$('workspace-type').addEventListener('change', () => {
  resetAverage();
  updateWorkspaceMetric();
  refreshWorkspaceChart();
});
$('workspace-since').addEventListener('input', () => {
  workspace.averageTicket++;
  setMessage($('workspace-since-result'), '');
});

/* среднее с выбранного времени */
$('workspace-since-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const device = activeDevice();
  const type = $('workspace-type').value;
  if (!device || !type) return;
  const ticket = ++workspace.averageTicket;
  const out = $('workspace-since-result');
  const value = $('workspace-since').value;
  if (!value) { setMessage(out, 'Укажите время'); return; }
  const since = new Date(value);   // datetime-local трактуется в часовом поясе браузера
  if (Number.isNaN(since.getTime())) { setMessage(out, 'Некорректное время'); return; }
  if (since.getTime() > Date.now()) { setMessage(out, 'Время не может быть в будущем'); return; }

  setMessage(out, 'Рассчитываем среднее…', 'ok');
  try {
    const r = await api('GET', '/api/devices/' + encodeURIComponent(device.deviceId) +
      `/telemetry/average?type=${Number(type)}&since=${encodeURIComponent(since.toISOString())}`);
    if (ticket !== workspace.averageTicket) return;
    if (r.status === 200 && r.data) {
      const unit = typeInfo(Number(type)).unit;
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
    if (ticket === workspace.averageTicket) setMessage(out, 'Не удалось получить среднее');
  }
});

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

/** Плитки последних показаний переключают тип на встроенном графике. */
function renderTiles(box, list) {
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
    tile.title = info.name + ': показать на графике';

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
    tile.dataset.type = String(item.telemetryType);
    tile.addEventListener('click', () => {
      $('workspace-type').value = tile.dataset.type;
      $('workspace-type').dispatchEvent(new Event('change'));
    });
    box.append(tile);
  }
}

let tilesTimer = null;
function startTilesPolling() {
  stopTilesPolling();
  tilesTimer = setInterval(() => {
    if (document.hidden || views.devices.hidden) return;
    const device = activeDevice();
    if (device) refreshWorkspace(device);
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
  if (selectedRoom()) { openRoomPicker(); return; }
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
function renderDeviceDetails(d) {
  currentDevice = d;
  $('dd-title').textContent = dash(d.name);
  fillKv($('dd-card'), [
    ['ID', { text: d.deviceId, copy: true }],
    ['Заряд', d.batteryLevel === null || d.batteryLevel === undefined ? '—' : d.batteryLevel + '%'],
    ['Производитель', dash(d.manufacturer)],
    ['Геолокация', dash(d.geolocation)],
    ['Последние данные', formatDate(d.lastDataTime)]
  ]);
}

function hideInspector() {
  workspace.inspectorTicket++;
  const dialog = $('device-settings');
  if (dialog.open) dialog.close();
}

$('device-settings').addEventListener('cancel', event => {
  event.preventDefault();
  hideInspector();
});
$('dd-close').addEventListener('click', hideInspector);

$('dd-delete').addEventListener('click', async () => {
  if (!currentDevice) return;
  const ok = await deleteDevice(currentDevice.deviceId, currentDevice.name);
  if (ok) hideInspector();
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
  const type = document.createElement('select');
  type.setAttribute('aria-label', 'Тип телеметрии');
  type.add(new Option('Выберите тип', ''));
  const types = new Set(Object.keys(TELEMETRY_TYPES));
  if (limit.telemetryType != null) types.add(String(limit.telemetryType));
  for (const id of types) {
    const info = typeInfo(id);
    type.add(new Option(info.unit ? info.name + ' · ' + info.unit : info.name, id));
  }
  type.value = limit.telemetryType == null ? '' : String(limit.telemetryType);
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

function fillSettings(data) {
  const battery = data.batteryLimit ?? data.batteryLowerBound;
  const telemetry = data.telemetryLimits ?? data.telemetry ?? [];
  $('st-battery').value = battery === null || battery === undefined ? '' : String(battery);
  $('st-list').replaceChildren();
  for (const l of telemetry) addLimitRow(l, false);
  updateLimitsEmpty();
  setMessage($('st-message'), '');
}

async function openSettings(device) {
  const ticket = ++workspace.inspectorTicket;
  settingsDevice = null;
  renderDeviceDetails(device);
  $('settings-form').hidden = true;
  setMessage($('settings-load'), 'Загружаем пороги…', 'ok');
  const dialog = $('device-settings');
  dialog.showModal();
  dialog.scrollTop = 0;
  const path = '/api/devices/' + encodeURIComponent(device.deviceId);
  const isCurrent = () => dialog.open && ticket === workspace.inspectorTicket;
  api('GET', path).then(response => {
    if (isCurrent() && response.ok && response.data) renderDeviceDetails(response.data);
  }).catch(error => console.error('Загрузка сведений об устройстве', error));
  try {
    const r = await api('GET', path + '/limits');
    if (!isCurrent()) return;
    if (r.ok && r.data) {
      settingsDevice = device;
      fillSettings(r.data);
      setMessage($('settings-load'), '');
      $('settings-form').hidden = false;
    } else {
      setMessage($('settings-load'), formatErrors(r.data, 'Не удалось загрузить пороги'));
    }
  } catch (error) {
    console.error(error);
    if (isCurrent()) setMessage($('settings-load'), 'Не удалось загрузить пороги');
  }
}

$('st-add').addEventListener('click', () => addLimitRow({}, true));
$('st-cancel').addEventListener('click', hideInspector);

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!settingsDevice) return;
  const editedDevice = settingsDevice;
  const ticket = workspace.inspectorTicket;

  const battery = parseOptional($('st-battery').value);
  if (battery !== null && (!Number.isInteger(battery) || battery < 0 || battery > 100)) {
    setMessage($('st-message'), 'Нижняя граница заряда: целое число от 0 до 100 или «—»');
    return;
  }

  const telemetryLimits = [];
  const seen = new Set();
  for (const rowEl of $('st-list').children) {
    const typeIn = rowEl.querySelector('select');
    const [lowerIn, upperIn] = rowEl.querySelectorAll('input');
    const lower = parseOptional(lowerIn.value);
    const upper = parseOptional(upperIn.value);
    if (typeIn.value.trim() === '' && lower === null && upper === null) continue; // пустая строка
    const type = parseOptional(typeIn.value);
    if (type === null || !Number.isInteger(type) || type < -32768 || type > 32767) {
      setMessage($('st-message'), 'Выберите тип телеметрии');
      return;
    }
    if (seen.has(type)) {
      setMessage($('st-message'), `Тип «${typeInfo(type).name}» указан дважды`);
      return;
    }
    seen.add(type);
    if ((lower !== null && !Number.isFinite(lower)) || (upper !== null && !Number.isFinite(upper))) {
      setMessage($('st-message'), `${typeInfo(type).name}: границы должны быть числами или «—»`);
      return;
    }
    if (lower !== null && upper !== null && lower > upper) {
      setMessage($('st-message'), `${typeInfo(type).name}: нижняя граница больше верхней`);
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
      '/api/devices/' + encodeURIComponent(editedDevice.deviceId) + '/limits', body);
    if (ticket !== workspace.inspectorTicket || !$('device-settings').open) return;
    if (r.status === 200 && r.data) {
      fillSettings(r.data);
      workspace.limits = r.data.telemetryLimits ?? r.data.telemetry ?? [];
      refreshWorkspaceChart();
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
  const hasData = currentUser?.id === getUserId();
  $('profile-card').hidden = editing || !hasData;
  $('profile-actions').hidden = editing || !hasData;
  $('profile-form').hidden = !editing;
  $('change-password').disabled = !hasData;
  $('delete-account').disabled = !hasData;
}

function renderProfile(user) {
  const name = user.username || user.email || 'Ваш аккаунт';
  $('profile-display-name').textContent = name;
  $('profile-display-email').textContent = user.email || '';
  $('profile-initial').textContent = [...name.trim()][0]?.toLocaleUpperCase() || '?';
  const fields = [
    ['Имя пользователя', user.username || 'Не указано', 'user'],
    ['Электронная почта', user.email || 'Не указана', 'mail'],
    ['Телефон', user.phone || 'Не указан', 'phone'],
    ['Дата рождения', user.dateOfBirth ? formatBirthDate(user.dateOfBirth) : 'Не указана', 'calendar']
  ];
  $('profile-card').replaceChildren(...fields.map(([label, value, iconName]) => {
    const tile = document.createElement('div');
    const term = document.createElement('dt');
    const definition = document.createElement('dd');
    term.textContent = label;
    definition.textContent = value;
    tile.append(icon(iconName), term, definition);
    return tile;
  }));
  fillKv($('profile-meta-card'), [
    ['ID', { text: user.id, copy: true }],
    ['Роль', user.role === 'ADMIN' ? 'Администратор' : 'Пользователь']
  ]);
  $('profile-meta').hidden = false;
}

async function loadProfile() {
  const userId = getUserId();
  if (!userId) { openAuth(); return; }
  if (currentUser?.id === userId) renderProfile(currentUser);
  else {
    $('profile-display-name').textContent = 'Ваш аккаунт';
    $('profile-display-email').textContent = '';
    $('profile-initial').textContent = '?';
    $('profile-meta').hidden = true;
  }
  showProfileMode(false);
  setMessage($('profile-message'), '');
  const status = $('profile-load-status');
  setMessage(status, 'Загружаем профиль…', 'ok');
  try {
    const r = await api('GET', '/api/users/' + encodeURIComponent(userId));
    if (getUserId() !== userId) return;
    if (r.ok && r.data) {
      currentUser = r.data;
      applyRole();
      renderProfile(currentUser);
      showProfileMode(!$('profile-form').hidden);
      setMessage(status, '');
    } else if (r.status === 404) {
      logout();
      toast('Пользователь не найден', true);
    } else {
      setMessage(status, formatErrors(r.data, 'Не удалось загрузить профиль'));
    }
  } catch (err) {
    console.error(err);
    if (getUserId() === userId) setMessage(status, 'Не удалось загрузить профиль');
  }
}

$('edit-profile').addEventListener('click', () => {
  if (!currentUser) return;
  $('prof-username').value = currentUser.username ?? '';
  $('prof-phone').value = currentUser.phone ?? '';
  $('prof-dob').value = currentUser.dateOfBirth ?? '';
  $('prof-dob').max = new Date().toISOString().slice(0, 10);
  setMessage($('profile-message'), '');
  showProfileMode(true);
});

$('profile-cancel').addEventListener('click', () => {
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

  if (username && username !== (currentUser.username ?? '')) body.username = username;
  if (phone && phone !== (currentUser.phone ?? '')) {
    if (!/^\+?[0-9]{11}$/.test(phone)) {
      setMessage($('profile-message'), 'Телефон должен содержать 11 цифр и может начинаться с «+»');
      $('prof-phone').focus();
      return;
    }
    body.phone = phone;
  }
  if (dob && dob !== (currentUser.dateOfBirth ?? '')) body.dateOfBirth = dob;

  if (Object.keys(body).length === 0) {
    setMessage($('profile-message'), 'Нет изменений для сохранения');
    return;
  }

  try {
    const r = await api('PUT', '/api/users/' + encodeURIComponent(userId), body);
      if (r.status === 200 && r.data) {
      currentUser = r.data;
      renderProfile(currentUser);
      setUserEmail(currentUser.email);
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

/* ---------------- комнаты ---------------- */

const roomState = { user: null, active: null, rooms: [] };
let pickerTicket = 0;

function roomStorageKey() {
  return 'iot-core.rooms.' + roomState.user;
}

function selectedRoom() {
  return roomState.rooms.find(room => room.id === roomState.active);
}

function syncRooms() {
  const user = getUserId();
  if (roomState.user !== user) {
    roomState.user = user;
    roomState.active = null;
    roomState.rooms = [];
    try {
      roomState.rooms = JSON.parse(localStorage.getItem(roomStorageKey())) ?? [];
    } catch (error) {
      fail(error, 'Не удалось прочитать сохранённые группы');
    }
  }
  renderRoomFilters();
}

function saveRooms(rooms) {
  localStorage.setItem(roomStorageKey(), JSON.stringify(rooms));
  roomState.rooms = rooms;
}

function removeRoomDevice(room, device) {
  if (roomState.active !== room.id) return;
  const current = selectedRoom();
  if (!current?.devices.includes(device.deviceId)) return;
  try {
    const updated = {...current, devices: current.devices.filter(id => id !== device.deviceId)};
    saveRooms(roomState.rooms.map(item => item.id === room.id ? updated : item));
    devState.ticket++;
    devState.items = devState.items.filter(item => item.deviceId !== device.deviceId);
    renderDevices();
    const next = $('devices-grid').querySelector('[aria-pressed="true"]') ?? $('add-device-btn');
    next.focus({preventScroll: true});
    toast('Устройство убрано из группы');
  } catch (error) {
    fail(error, 'Не удалось убрать устройство из группы');
  }
}

function selectRoom(id) {
  roomState.active = id;
  $('search-input').value = '';
  $('search-clear').hidden = true;
  clearTimeout(searchTimer);
  devState.search = null;
  renderRoomFilters(id);
  loadDevices();
}

function renderRoomFilters(focusId) {
  const filters = $('room-filters');
  filters.replaceChildren();
  for (const room of [{id: null, name: 'Все устройства'}, ...roomState.rooms]) {
    const active = room.id === roomState.active;
    const button = actionButton(room.name, 'room-filter', () => selectRoom(room.id));
    button.setAttribute('aria-pressed', String(active));
    const chip = document.createElement('div');
    chip.className = 'room-chip';
    chip.append(button);
    if (room.id !== null) {
      const remove = actionButton('', 'room-remove', () => removeRoom(room), 'x');
      remove.setAttribute('aria-label', 'Удалить группу «' + room.name + '»');
      remove.title = 'Удалить группу';
      chip.append(remove);
    }
    filters.append(chip);
    if (focusId === room.id) button.focus({preventScroll: true});
  }

  const add = $('add-device-btn');
  const inRoom = Boolean(selectedRoom());
  add.replaceChildren(icon('plus'));
  if (!inRoom) add.append(document.createTextNode('Добавить'));
  add.setAttribute('aria-label', inRoom ? 'Добавить устройства в группу' : 'Добавить устройство');
  add.title = add.getAttribute('aria-label');
}

function removeRoom(room) {
  if (!confirm('Удалить группу «' + room.name + '»? Устройства останутся в общем списке.')) return;
  try {
    saveRooms(roomState.rooms.filter(item => item.id !== room.id));
  } catch (error) {
    fail(error, 'Не удалось удалить группу');
    return;
  }

  if (roomState.active === room.id) selectRoom(null);
  else renderRoomFilters(roomState.active);
}

async function readDeviceCatalogue(userId, isCurrent) {
  const devices = new Map();
  const limit = PAGE_SIZE + 1;
  for (let offset = 0; isCurrent(); offset += limit) {
    const params = new URLSearchParams({userId, limit: String(limit), offset: String(offset)});
    const r = await api('GET', '/api/devices?' + params);
    if (!r.ok || !Array.isArray(r.data)) throw new Error('Ответ списка устройств: ' + r.status);
    const count = devices.size;
    for (const device of r.data) devices.set(device.deviceId, device);
    if (r.data.length < limit || devices.size === count) break;
  }
  return [...devices.values()];
}

$('new-room-btn').addEventListener('click', () => {
  $('new-room-form').reset();
  setMessage($('room-name-message'), '');
  $('new-room-dialog').showModal();
});
$('new-room-cancel').addEventListener('click', () => $('new-room-dialog').close());
$('new-room-form').addEventListener('submit', event => {
  event.preventDefault();
  const name = $('room-name').value.trim();
  const message = $('room-name-message');
  if (!name) {
    setMessage(message, 'Введите название группы');
    return;
  }
  if (['Все устройства', ...roomState.rooms.map(room => room.name)]
    .some(existing => existing.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    setMessage(message, 'Это название уже используется');
    return;
  }
  try {
    const room = {id: crypto.randomUUID(), name, devices: []};
    saveRooms([...roomState.rooms, room]);
    $('new-room-dialog').close();
    selectRoom(room.id);
  } catch (error) {
    console.error(error);
    setMessage(message, 'Не удалось сохранить группу в браузере');
  }
});

function filterRoomPicker() {
  const query = $('room-picker-search').value.trim().toLocaleLowerCase();
  const list = $('room-picker-list');
  let found = false;
  for (const row of list.children) {
    row.hidden = !row.dataset.deviceName.includes(query);
    if (!row.hidden) found = true;
  }
  $('room-picker-no-matches').hidden = !query || found;
  list.scrollTop = 0;
}

$('room-picker-search').addEventListener('input', filterRoomPicker);
$('room-picker-search').addEventListener('keydown', event => {
  if (event.key === 'Enter') event.preventDefault();
});

async function openRoomPicker() {
  const room = selectedRoom();
  if (!room) return;
  const user = getUserId();
  const dialog = $('room-picker');
  const ticket = ++pickerTicket;
  const list = $('room-picker-list');
  const message = $('room-picker-message');
  const isCurrent = () => ticket === pickerTicket && dialog.open && getUserId() === user;
  $('room-picker-title').textContent = 'Добавить устройства · ' + room.name;
  const search = $('room-picker-search');
  search.value = '';
  search.disabled = true;
  $('room-picker-no-matches').hidden = true;
  list.replaceChildren();
  $('room-picker-submit').disabled = true;
  setMessage(message, 'Загружаем устройства…', 'ok');
  dialog.showModal();
  try {
    const devices = await readDeviceCatalogue(user, isCurrent);
    if (!isCurrent()) return;
    const existing = new Set(room.devices);
    for (const device of devices) {
      if (existing.has(device.deviceId)) continue;
      const label = document.createElement('label');
      label.dataset.deviceName = dash(device.name).toLocaleLowerCase();
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = device.deviceId;
      const caption = document.createElement('span');
      const id = document.createElement('small');
      id.textContent = device.deviceId;
      caption.append(document.createTextNode(dash(device.name)), id);
      label.append(input, caption);
      list.append(label);
    }
    search.disabled = list.children.length === 0;
    setMessage(message, search.disabled ? 'Нет устройств для добавления' : '', 'ok');
  } catch (error) {
    console.error(error);
    if (isCurrent()) setMessage(message, 'Не удалось загрузить устройства');
  }
}

$('empty-room-add').addEventListener('click', openRoomPicker);
$('room-picker-cancel').addEventListener('click', () => $('room-picker').close());
$('room-picker-list').addEventListener('change', () => {
  $('room-picker-submit').disabled = !$('room-picker-list').querySelector(':checked');
});
$('room-picker-form').addEventListener('submit', event => {
  event.preventDefault();
  const room = selectedRoom();
  const ids = [...$('room-picker-list').querySelectorAll(':checked')].map(input => input.value);
  if (!room || !ids.length) return;
  try {
    const updated = {...room, devices: [...new Set([...room.devices, ...ids])]};
    saveRooms(roomState.rooms.map(item => item.id === room.id ? updated : item));
    $('room-picker').close();
    loadDevices();
  } catch (error) {
    console.error(error);
    setMessage($('room-picker-message'), 'Не удалось сохранить устройства группы');
  }
});

/* ---------------- восстановление и смена пароля ---------------- */

let resetToken = null;

$('forgot-password').addEventListener('click', () => {
  const form = $('recovery-form');
  form.reset();
  $('recovery-email').value = $('auth-email').value.trim();
  setMessage($('recovery-message'), '');
  $('recovery-dialog').showModal();
});
$('recovery-cancel').addEventListener('click', () => $('recovery-dialog').close());
$('recovery-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('[type=submit]');
  const message = $('recovery-message');
  submit.disabled = true;
  try {
    const result = await api('POST', '/api/password/request', {email: $('recovery-email').value.trim()});
    setMessage(message, result.ok
      ? 'Если аккаунт с такой почтой существует, мы отправим ссылку для восстановления.'
      : formatErrors(result.data, 'Не удалось запросить восстановление'), result.ok ? 'ok' : 'error');
  } catch (error) {
    console.error(error);
    setMessage(message, 'Не удалось запросить восстановление');
  } finally {
    submit.disabled = false;
  }
});

function openPasswordDialog(token = null) {
  resetToken = token;
  $('password-form').reset();
  $('password-title').textContent = token ? 'Задать новый пароль' : 'Изменить пароль';
  $('current-password-field').hidden = Boolean(token);
  $('current-password').required = !token;
  setMessage($('password-message'), '');
  $('password-dialog').showModal();
}

$('change-password').addEventListener('click', () => openPasswordDialog());
$('password-cancel').addEventListener('click', () => $('password-dialog').close());
$('password-dialog').addEventListener('close', () => {
  $('password-form').reset();
  resetToken = null;
});
$('password-form').addEventListener('submit', async event => {
  event.preventDefault();
  const password = $('new-password').value;
  const message = $('password-message');
  if (password.length < 8 || password.length > 256) {
    setMessage(message, 'Пароль должен содержать от 8 до 256 символов');
    return;
  }
  if (password !== $('repeat-password').value) {
    setMessage(message, 'Пароли не совпадают');
    $('repeat-password').focus();
    return;
  }
  const token = resetToken;
  const userId = getUserId();
  if (!token && !userId) return;
  const submit = event.currentTarget.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    const result = token
      ? await api('POST', '/api/password/reset', {token, password})
      : await api('PUT', '/api/users/' + encodeURIComponent(userId) + '/password',
          {currentPassword: $('current-password').value, password});
    if (result.ok) {
      $('password-dialog').close();
      if (token) logout();
      toast('Пароль изменён');
    } else {
      setMessage(message, formatErrors(result.data, 'Не удалось изменить пароль'));
    }
  } catch (error) {
    console.error(error);
    setMessage(message, 'Не удалось изменить пароль');
  } finally {
    submit.disabled = false;
  }
});

$('edit-manufacturer').addEventListener('click', () => {
  if (!currentDevice) return;
  $('manufacturer-value').value = currentDevice.manufacturer ?? '';
  setMessage($('manufacturer-message'), '');
  $('manufacturer-dialog').showModal();
});
$('manufacturer-cancel').addEventListener('click', () => $('manufacturer-dialog').close());
$('manufacturer-form').addEventListener('submit', async event => {
  event.preventDefault();
  const id = currentDevice?.deviceId;
  const userId = getUserId();
  if (!id || !userId) return;
  const submit = event.currentTarget.querySelector('[type=submit]');
  const message = $('manufacturer-message');
  submit.disabled = true;
  try {
    const result = await api('PUT', '/api/devices/' + encodeURIComponent(id) + '/manufacturer',
      {userId, manufacturer: $('manufacturer-value').value.trim()});
    if (result.ok && result.data && getUserId() === userId) {
      if (currentDevice?.deviceId === id) renderDeviceDetails(result.data);
      replaceInList(result.data);
      $('manufacturer-dialog').close();
      toast('Производитель обновлён');
    } else {
      setMessage(message, formatErrors(result.data, 'Не удалось изменить производителя'));
    }
  } catch (error) {
    console.error(error);
    setMessage(message, 'Не удалось изменить производителя');
  } finally {
    submit.disabled = false;
  }
});

/* ---------------- старт ---------------- */

$('about-text').textContent = ABOUT_TEXT;
$('telegram-link').href = TELEGRAM_BOT_URL;
renderLegend();        // НОВОЕ: таблица типов телеметрии на вкладке «Описание»
initChannels();        // НОВОЕ: окна Email и Telegram на вкладке «Уведомления»

const recoveryLink = new URLSearchParams(location.hash.slice(1)).get('reset');
if (recoveryLink) {
  history.replaceState(null, '', location.pathname + location.search);
  showScreen('auth');
  openPasswordDialog(recoveryLink);
} else if (getUserId()) {
  enterMain();
} else if (sessionStorage.getItem('pendingUserId')) {
  // страницу обновили посреди подтверждения: возвращаем на экран 2
  setMessage($('confirm-message'), '');
  showScreen('confirm');
} else {
  showScreen('auth');
}
