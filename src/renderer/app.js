'use strict';
/* global I18N, api */

// ============================================================ state
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const JS_DAY = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
// zigbee-herdsman adapter type -> chip family and common dongles that use it.
const ADAPTERS = {
  ember: 'Silicon Labs (SONOFF ZBDongle-E, Dongle Lite/Max MG24, ZBT-1)',
  zstack: 'Texas Instruments (SONOFF ZBDongle-P, SMLIGHT SLZB-06)',
  deconz: 'dresden elektronik (ConBee II/III, RaspBee II)',
  zigate: 'ZiGate (USB, USB-TTL, PiZiGate)',
  zboss: 'Nordic nRF52840 (experimental)',
};
const SETTINGS_SECTIONS = {
  comfort: ['hysteresis_low', 'hysteresis_high', 'local_temperature_calibration', 'frost_protection_temperature', 'open_window'],
  control: ['child_lock', 'temperature_sensor_select', 'external_temperature_input'],
  display: ['active_brightness', 'standby_brightness', 'night_mode', 'night_mode_period', 'night_brightness'],
  radar: ['radar_detection', 'radar_sensitivity', 'radar_do_not_disturb', 'radar_do_not_disturb_period'],
  outputs: ['boiler_dry_contact_output', 'hydronic_underfloor_heating_relay_output', 'ntc_temperature', 'ntc_overheat_protection', 'ntc_overheat_protection_temperature'],
  advanced: ['bluetooth_pairing'],
};
// Properties handled by dedicated pages, never shown in the generic settings list.
const HANDLED_ELSEWHERE = new Set([
  'occupied_heating_setpoint', 'local_temperature', 'system_mode', 'running_state', 'open_window_detected',
  'schedule_active_group', 'schedule_group_to_edit', 'temporary_mode_mode', 'temporary_mode_duration',
  'temporary_mode_target_temperature', 'read_temperature_control_history', 'temperature_control_history',
  'factory_reset', 'linkquality', ...DAYS.map((d) => `weekly_schedule_${d}`),
]);

const S = {
  lang: 'en',
  page: 'home',
  config: {},
  status: { status: 'stopped', message: '' },
  devices: [],
  ieee: undefined,
  exposeMap: {},
  state: {},
  logs: [],
  permitJoin: { permitted: false, end: undefined },
  draft: {}, // day -> compact schedule string (unsaved)
  quick: { pauseMinutes: 120, pauseTemp: 5, timerMinutes: 60, timerTemp: 20, boostMinutes: 30 },
  history: { type: 'day', date: '', result: undefined, waiting: false, start: '', showTable: false, error: '' },
  ports: [],
  dataDir: '',
  deferred: new Set(),
};

// ============================================================ helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function t(path, vars) {
  const pick = (lang) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), I18N[lang]);
  let s = pick(S.lang);
  if (s === undefined) s = pick('en');
  if (s === undefined) return path;
  if (vars && typeof s === 'string') s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  return s;
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtNum(v, digits = 1) {
  if (v === undefined || v === null || Number.isNaN(Number(v))) return t('common.unknown');
  const n = Number(v);
  return n.toLocaleString(S.lang === 'it' ? 'it-IT' : 'en-GB', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.className = 'toast'), isError ? 5000 : 2200);
}

function dev() {
  return S.ieee ? S.state : {};
}

async function send(payload, { quiet = false } = {}) {
  if (!S.ieee) return false;
  const res = await api.set(S.ieee, payload);
  if (!res.ok) {
    toast(t('errors.send', { e: res.error }), true);
    return false;
  }
  if (!quiet) toast(t('common.saved'));
  return true;
}

function confirmDialog(message) {
  return new Promise((resolve) => {
    const d = $('#dialog');
    d.innerHTML = `<p>${esc(message)}</p><div class="actions"><button class="btn" data-r="0">${esc(t('common.cancel'))}</button><button class="btn primary" data-r="1">${esc(t('common.yes'))}</button></div>`;
    d.onclick = (e) => {
      const r = e.target.closest('[data-r]');
      if (!r) return;
      d.close();
      resolve(r.dataset.r === '1');
    };
    d.onclose = () => resolve(false);
    d.showModal();
  });
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function isoLocal(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// ============================================================ schedule parsing
function parseSchedule(str) {
  if (!str || typeof str !== 'string') return [];
  const out = [];
  for (const part of str.trim().split(/\s+/)) {
    const m = part.match(/^(\d{1,2}):(\d{2})\/(\d+(?:\.\d+)?)$/);
    if (!m) continue;
    const min = Number(m[1]) * 60 + Number(m[2]);
    const temp = Number(m[3]);
    // The thermostat pads the list to 12 entries by repeating the last one: drop those.
    if (out.length === 0 || min > out[out.length - 1].min) out.push({ min, temp });
  }
  return out;
}

function formatSchedule(list) {
  return list.map((x) => `${pad(Math.floor(x.min / 60))}:${pad(x.min % 60)}/${Number(x.temp)}`).join(' ');
}

function minToHHMM(min) {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

function scheduleFor(day) {
  return parseSchedule(S.draft[day] ?? dev()[`weekly_schedule_${day}`]);
}

function validateSchedule(list) {
  if (list.length === 0 || list[0].min !== 0) return t('schedule.errFirst');
  if (list.length > 12) return t('schedule.errMax');
  for (let i = 1; i < list.length; i++) if (!(list[i].min > list[i - 1].min)) return t('schedule.errOrder');
  for (const x of list) if (!(x.temp >= 5 && x.temp <= 30) || Math.round(x.temp * 2) !== x.temp * 2) return t('schedule.errTemp');
  return '';
}

function tempColor(temp) {
  const r = Math.max(0, Math.min(1, (temp - 5) / 25));
  const hue = 210 - r * 195;
  return `hsl(${hue.toFixed(0)} 65% ${(48 - r * 4).toFixed(0)}%)`;
}

function nextChange() {
  const st = dev();
  if (String(st.schedule_group_to_edit) !== String(st.schedule_active_group)) return undefined;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (let offset = 0; offset < 8; offset++) {
    const day = JS_DAY[(now.getDay() + offset) % 7];
    const list = parseSchedule(st[`weekly_schedule_${day}`]);
    for (const x of list) {
      if (offset === 0 && x.min <= nowMin) continue;
      if (offset > 0 || x.min > nowMin) {
        const label = offset === 0 ? minToHHMM(x.min) : `${t(`daysShort.${day}`)} ${minToHHMM(x.min)}`;
        return { label, temp: x.temp };
      }
    }
  }
  return undefined;
}

// ============================================================ rendering core
function applyStaticI18n() {
  document.documentElement.lang = S.lang;
  $$('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  $$('.lang button').forEach((b) => b.classList.toggle('active', b.dataset.lang === S.lang));
  document.title = t('appName');
}

function renderStatus() {
  const pill = $('#statusPill');
  pill.className = `status-pill ${S.status.status}`;
  $('#statusText').textContent = t(`status.${S.status.status}`);
  pill.title = S.status.message || '';
}

function showPage(page) {
  S.page = page;
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  renderPage(page, true);
}

const RENDERERS = {};

function renderPage(page = S.page, force = false) {
  const root = $(`#page-${page}`);
  if (!root) return;
  const active = document.activeElement;
  const editing = active && root.contains(active) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName);
  if (editing && !force) {
    S.deferred.add(page);
    return;
  }
  S.deferred.delete(page);
  RENDERERS[page](root);
}

document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (S.deferred.has(S.page)) renderPage(S.page);
  }, 0);
});

function needsDevice(root) {
  if (S.status.status !== 'running' && !S.ieee) {
    root.innerHTML = `<div class="card empty"><strong>${esc(t('home.notRunning'))}</strong>${esc(t('home.notRunningHint'))}<div style="margin-top:16px"><button class="btn primary" data-goto="network">${esc(t('nav.network'))}</button></div></div>`;
    return true;
  }
  if (!S.ieee) {
    root.innerHTML = `<div class="card empty"><strong>${esc(t('home.noDevice'))}</strong>${esc(t('home.noDeviceHint'))}<div style="margin-top:16px"><button class="btn primary" data-goto="network">${esc(t('nav.network'))}</button></div></div>`;
    return true;
  }
  return false;
}

document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]');
  if (g) showPage(g.dataset.goto);
});

// ============================================================ HOME
const FLAME = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2s5 4.5 5 9.5a5 5 0 0 1-10 0c0-2 1-3.5 1-3.5s.5 2 2 2.5C10 7 12 2 12 2Zm0 20a7 7 0 0 1-7-7c0-1 .2-2 .5-2.8A7 7 0 0 0 12 18a7 7 0 0 0 6.5-5.8c.3.8.5 1.8.5 2.8a7 7 0 0 1-7 7Z"/></svg>';

RENDERERS.home = (root) => {
  if (needsDevice(root)) return;
  const st = dev();
  const mode = st.system_mode;
  const heating = st.running_state === 'heat';
  const sp = st.occupied_heating_setpoint;
  const tmode = st.temporary_mode_mode || 'disabled';
  const nc = nextChange();
  const q = S.quick;
  const lastSeen = S.devices.find((d) => d.ieee === S.ieee)?.lastSeen;
  const notRunning = S.status.status !== 'running';
  const dis = notRunning ? 'disabled' : '';

  root.innerHTML = `
    ${notRunning ? `<div class="banner info">${esc(t('home.notRunning'))}</div>` : ''}
    ${st.open_window_detected ? `<div class="banner">${esc(t('home.windowOpen'))}</div>` : ''}
    <div class="card hero">
      <div class="room">
        <div class="label">${esc(t('home.room'))}</div>
        <div class="big">${esc(fmtNum(st.local_temperature))}<small>°C</small></div>
        <div class="heat-state ${heating ? 'on' : ''}">${heating ? FLAME : ''}${esc(heating ? t('home.heating') : t('home.idle'))}</div>
      </div>
      <div>
        <div class="label">${esc(t('home.target'))}</div>
        <div class="setpoint">
          <button class="btn icon" data-sp="-0.5" ${dis} aria-label="-0.5">−</button>
          <div class="big">${esc(mode === 'off' ? 'OF' : fmtNum(sp))}${mode === 'off' ? '' : '<small>°C</small>'}</div>
          <button class="btn icon" data-sp="0.5" ${dis} aria-label="+0.5">+</button>
        </div>
        <div class="muted small" style="margin-top:14px">${esc(t('home.nextChange'))}: ${nc ? esc(t('home.nextChangeAt', { time: nc.label, temp: fmtNum(nc.temp) })) : esc(t('home.noSchedule'))}</div>
      </div>
    </div>

    <div class="card">
      <div class="label">${esc(t('home.mode'))}</div>
      <div class="segmented">
        <button class="off ${mode === 'off' ? 'active' : ''}" data-mode="off" ${dis}>${esc(t('home.modeOff'))}</button>
        <button class="auto ${mode === 'auto' ? 'active' : ''}" data-mode="auto" ${dis}>${esc(t('home.modeAuto'))}</button>
        <button class="heat ${mode === 'heat' ? 'active' : ''}" data-mode="heat" ${dis}>${esc(t('home.modeHeat'))}</button>
      </div>
      <p class="muted small" style="margin:10px 0 0">${esc(mode === 'off' ? t('home.modeHintOff') : mode === 'auto' ? t('home.modeHintAuto') : mode === 'heat' ? t('home.modeHintHeat') : '')}</p>
    </div>

    <div class="card">
      <div class="row"><h2 style="margin:0">${esc(t('home.quick'))}</h2><span class="spacer"></span>
        <span class="muted small">${esc(tmode === 'disabled' ? t('home.tempDisabled') : t('home.tempActive', { mode: t(`values.${tmode}`) }))}</span>
        ${tmode !== 'disabled' ? `<button class="btn small danger" data-temp-stop ${dis}>${esc(t('home.stopTemp'))}</button>` : ''}
      </div>
      <p class="muted small" style="margin:4px 0 0">${esc(t('home.quickHint'))}</p>
      <div class="quick-grid">
        <div class="quick">
          <h3>${esc(t('home.pause'))}</h3><p>${esc(t('home.pauseHint'))}</p>
          <div class="fields">
            <label>${esc(t('home.duration'))}<select data-q="pauseMinutes">
              ${[30, 60, 120, 180, 240, 360, 480, 720, 1440].map((m) => `<option value="${m}" ${q.pauseMinutes === m ? 'selected' : ''}>${m < 60 ? `${m} ${t('common.minutes')}` : `${m / 60} ${t('common.hours')}`}</option>`).join('')}
            </select></label>
            <label>${esc(t('home.temperature'))}<input type="number" min="5" max="30" step="0.5" value="${q.pauseTemp}" data-q="pauseTemp"></label>
          </div>
          <button class="btn primary" data-quick="pause" ${dis}>${esc(t('home.start'))}</button>
        </div>
        <div class="quick">
          <h3>${esc(t('home.timer'))}</h3><p>${esc(t('values.timer'))} · 1–1440 ${esc(t('common.minutes'))}</p>
          <div class="fields">
            <label>${esc(t('home.duration'))} (${esc(t('common.minutes'))})<input type="number" min="1" max="1440" step="1" value="${q.timerMinutes}" data-q="timerMinutes"></label>
            <label>${esc(t('home.temperature'))}<input type="number" min="5" max="30" step="0.5" value="${q.timerTemp}" data-q="timerTemp"></label>
          </div>
          <button class="btn primary" data-quick="timer" ${dis}>${esc(t('home.start'))}</button>
        </div>
        <div class="quick">
          <h3>${esc(t('home.boost'))}</h3><p>${esc(t('home.boostHint'))}</p>
          <div class="fields">
            <label>${esc(t('home.duration'))} (${esc(t('common.minutes'))})<input type="number" min="1" max="180" step="1" value="${q.boostMinutes}" data-q="boostMinutes"></label>
          </div>
          <button class="btn primary" data-quick="boost" ${dis}>${esc(t('home.start'))}</button>
        </div>
      </div>
    </div>

    <div class="card">
      <dl class="kv">
        <dt>${esc(t('home.group'))}</dt><dd>${esc(st.schedule_active_group ? t('schedule.group', { n: st.schedule_active_group }) : t('common.unknown'))}</dd>
        <dt>${esc(t('home.childLock'))}</dt><dd><label class="switch"><input type="checkbox" data-childlock ${st.child_lock === 'LOCK' ? 'checked' : ''} ${dis}><span></span></label></dd>
        <dt>${esc(t('home.signal'))}</dt><dd>${esc(st.linkquality ?? t('common.unknown'))}</dd>
        <dt>${esc(t('home.lastSeen'))}</dt><dd>${esc(lastSeen ? new Date(lastSeen).toLocaleString(S.lang === 'it' ? 'it-IT' : 'en-GB') : t('common.unknown'))}</dd>
      </dl>
    </div>`;
};

$('#page-home').addEventListener('click', async (e) => {
  const st = dev();
  const spBtn = e.target.closest('[data-sp]');
  if (spBtn) {
    const base = Number(st.occupied_heating_setpoint ?? 20);
    const next = Math.max(5, Math.min(30, Math.round((base + Number(spBtn.dataset.sp)) * 2) / 2));
    await send({ occupied_heating_setpoint: next }, { quiet: true });
    return;
  }
  const m = e.target.closest('[data-mode]');
  if (m) {
    await send({ system_mode: m.dataset.mode }, { quiet: true });
    return;
  }
  const qb = e.target.closest('[data-quick]');
  if (qb) {
    const q = S.quick;
    const kind = qb.dataset.quick;
    const clampT = (v) => Math.max(5, Math.min(30, Math.round(Number(v) * 2) / 2));
    let payload;
    if (kind === 'pause') payload = { temporary_mode_mode: 'timer', temporary_mode_duration: Number(q.pauseMinutes), temporary_mode_target_temperature: clampT(q.pauseTemp) };
    if (kind === 'timer') payload = { temporary_mode_mode: 'timer', temporary_mode_duration: Math.max(1, Math.min(1440, Math.round(q.timerMinutes))), temporary_mode_target_temperature: clampT(q.timerTemp) };
    if (kind === 'boost') payload = { temporary_mode_mode: 'boost', temporary_mode_duration: Math.max(1, Math.min(180, Math.round(q.boostMinutes))), temporary_mode_target_temperature: 30 };
    await send(payload);
    return;
  }
  if (e.target.closest('[data-temp-stop]')) {
    await send({ temporary_mode_mode: 'disabled' });
  }
});

$('#page-home').addEventListener('change', async (e) => {
  const qi = e.target.closest('[data-q]');
  if (qi) S.quick[qi.dataset.q] = Number(qi.value);
  if (e.target.matches('[data-childlock]')) await send({ child_lock: e.target.checked ? 'LOCK' : 'UNLOCK' });
});

// ============================================================ SCHEDULE
RENDERERS.schedule = (root) => {
  if (needsDevice(root)) return;
  const st = dev();
  const active = String(st.schedule_active_group ?? '');
  const editing = String(st.schedule_group_to_edit ?? '');
  const todayKey = JS_DAY[new Date().getDay()];
  const now = new Date();
  const nowPct = ((now.getHours() * 60 + now.getMinutes()) / 1440) * 100;
  const dirty = Object.keys(S.draft).length > 0;
  const groupOpts = (sel) => ['1', '2', '3'].map((g) => `<option value="${g}" ${sel === g ? 'selected' : ''}>${esc(t('schedule.group', { n: g }))}</option>`).join('');

  const rows = DAYS.map((day) => {
    const list = scheduleFor(day);
    const segs = list.map((x, i) => {
      const end = i + 1 < list.length ? list[i + 1].min : 1440;
      const w = ((end - x.min) / 1440) * 100;
      return `<div class="seg" style="width:${w}%;background:${tempColor(x.temp)}" title="${minToHHMM(x.min)}–${minToHHMM(end % 1440)} · ${fmtNum(x.temp)} °C">${w > 6 ? `${fmtNum(x.temp)}°` : ''}</div>`;
    }).join('');
    return `<div class="day-row ${day === todayKey ? 'today' : ''} ${S.draft[day] !== undefined ? 'dirty' : ''}">
      <div class="day-name">${esc(t(`days.${day}`))}</div>
      <div class="timeline">${segs || `<div class="muted small" style="padding:8px">${esc(t('schedule.loading'))}</div>`}${day === todayKey && editing === active ? `<div class="now" style="left:${nowPct}%"></div>` : ''}</div>
      <div class="day-actions">
        <button class="btn small" data-edit="${day}" ${list.length ? '' : 'disabled'}>${esc(t('schedule.edit'))}</button>
        <select data-copy="${day}" ${list.length ? '' : 'disabled'} aria-label="${esc(t('schedule.copyTo'))}">
          <option value="">${esc(t('schedule.copyTo'))}</option>
          <option value="weekdays">${esc(t('schedule.copyWeekdays'))}</option>
          <option value="weekend">${esc(t('schedule.copyWeekend'))}</option>
          <option value="all">${esc(t('schedule.copyAll'))}</option>
          ${DAYS.filter((d) => d !== day).map((d) => `<option value="${d}">${esc(t(`days.${d}`))}</option>`).join('')}
        </select>
      </div>
    </div>`;
  }).join('');

  root.innerHTML = `
    <h1>${esc(t('schedule.title'))}</h1>
    <p class="intro">${esc(t('schedule.intro'))}</p>
    ${st.system_mode !== 'auto' ? `<div class="banner row">${esc(t('schedule.modeWarn'))}<span class="spacer"></span><button class="btn small" data-switch-auto>${esc(t('schedule.switchAuto'))}</button></div>` : ''}
    <div class="card">
      <div class="sched-controls">
        <label>${esc(t('schedule.activeGroup'))}<select data-active-group>${groupOpts(active)}</select></label>
        <label>${esc(t('schedule.editGroup'))}<select data-edit-group ${dirty ? 'disabled' : ''}>${groupOpts(editing)}</select></label>
        ${editing && active && editing !== active ? `<div class="row"><span class="muted small">${esc(t('schedule.notActive'))}</span><button class="btn small" data-use-this>${esc(t('schedule.useThis'))}</button></div>` : ''}
      </div>
      <div class="ticks"><span></span><div class="scale"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div><span></span></div>
      ${rows}
    </div>
    ${dirty ? `<div class="pending-bar"><strong>${esc(t('schedule.pending'))}</strong><span class="muted small">${Object.keys(S.draft).map((d) => esc(t(`daysShort.${d}`))).join(', ')}</span><span class="spacer"></span><button class="btn" data-discard>${esc(t('schedule.discard'))}</button><button class="btn primary" data-save-sched>${esc(t('schedule.saveAll'))}</button></div>` : ''}`;
};

$('#page-schedule').addEventListener('click', async (e) => {
  if (e.target.closest('[data-switch-auto]')) return void (await send({ system_mode: 'auto' }));
  if (e.target.closest('[data-use-this]')) return void (await send({ schedule_active_group: String(dev().schedule_group_to_edit) }));
  if (e.target.closest('[data-discard]')) {
    S.draft = {};
    return renderPage('schedule', true);
  }
  if (e.target.closest('[data-save-sched]')) {
    const payload = {};
    for (const [day, str] of Object.entries(S.draft)) payload[`weekly_schedule_${day}`] = str;
    const btn = e.target.closest('[data-save-sched]');
    btn.disabled = true;
    btn.textContent = t('common.sending');
    if (await send(payload)) S.draft = {};
    return renderPage('schedule', true);
  }
  const ed = e.target.closest('[data-edit]');
  if (ed) openDayEditor(ed.dataset.edit);
});

$('#page-schedule').addEventListener('change', async (e) => {
  if (e.target.matches('[data-active-group]')) return void (await send({ schedule_active_group: e.target.value }));
  if (e.target.matches('[data-edit-group]')) {
    S.draft = {};
    return void (await send({ schedule_group_to_edit: e.target.value }, { quiet: true }));
  }
  if (e.target.matches('[data-copy]')) {
    const src = e.target.dataset.copy;
    const v = e.target.value;
    if (!v) return;
    const str = formatSchedule(scheduleFor(src));
    const targets = v === 'weekdays' ? DAYS.slice(0, 5) : v === 'weekend' ? DAYS.slice(5) : v === 'all' ? DAYS : [v];
    for (const d of targets) if (d !== src || S.draft[src] !== undefined) setDraft(d, str);
    renderPage('schedule', true);
  }
});

function setDraft(day, str) {
  const original = formatSchedule(parseSchedule(dev()[`weekly_schedule_${day}`]));
  if (str === original) delete S.draft[day];
  else S.draft[day] = str;
}

function openDayEditor(day) {
  const d = $('#dialog');
  let list = scheduleFor(day).map((x) => ({ ...x }));
  const draw = (err = '') => {
    d.innerHTML = `
      <h2>${esc(t('schedule.dayEditor', { day: t(`days.${day}`) }))}</h2>
      <div class="trans-list">
        ${list.map((x, i) => `<div class="trans">
          <span class="idx">${i + 1}</span>
          <input type="time" value="${minToHHMM(x.min)}" data-i="${i}" data-f="time" ${i === 0 ? 'disabled' : ''} aria-label="${esc(t('schedule.from'))}">
          <div class="row" style="flex-wrap:nowrap;gap:4px"><input type="number" min="5" max="30" step="0.5" value="${x.temp}" data-i="${i}" data-f="temp" style="width:80px"><span class="muted small">°C</span></div>
          ${i === 0 ? '<span></span>' : `<button class="btn small" data-del="${i}">${esc(t('schedule.remove'))}</button>`}
        </div>`).join('')}
      </div>
      <button class="btn small" data-add ${list.length >= 12 ? 'disabled' : ''}>+ ${esc(t('schedule.addRow'))}</button>
      <div class="err" style="margin-top:10px">${esc(err)}</div>
      <div class="actions"><button class="btn" data-cancel>${esc(t('common.cancel'))}</button><button class="btn primary" data-ok>${esc(t('common.apply'))}</button></div>`;
  };
  const readInputs = () => {
    $$('input[data-i]', d).forEach((inp) => {
      const i = Number(inp.dataset.i);
      if (inp.dataset.f === 'temp') list[i].temp = Number(inp.value);
      else if (inp.value) {
        const [h, m] = inp.value.split(':').map(Number);
        list[i].min = h * 60 + m;
      }
    });
  };
  d.onclick = (e) => {
    if (e.target.closest('[data-add]')) {
      readInputs();
      const last = list[list.length - 1];
      list.push({ min: Math.min(1439, last.min + 60), temp: last.temp });
      draw();
    } else if (e.target.closest('[data-del]')) {
      readInputs();
      list.splice(Number(e.target.closest('[data-del]').dataset.del), 1);
      draw();
    } else if (e.target.closest('[data-cancel]')) {
      d.close();
    } else if (e.target.closest('[data-ok]')) {
      readInputs();
      list.sort((a, b) => a.min - b.min);
      const err = validateSchedule(list);
      if (err) return draw(err);
      setDraft(day, formatSchedule(list));
      d.close();
      renderPage('schedule', true);
    }
  };
  d.onclose = null;
  draw();
  d.showModal();
}

// ============================================================ SETTINGS
function exposeLabel(prop) {
  const l = t(`labels.${prop}`);
  if (Array.isArray(l)) return { name: l[0], desc: l[1] };
  return { name: prop.replace(/_/g, ' '), desc: S.exposeMap[prop]?.description || '' };
}

function valueLabel(v) {
  const s = t(`values.${v}`);
  return s === `values.${v}` ? String(v).replace(/_/g, ' ') : s;
}

function settingControl(e) {
  const prop = e.property;
  const v = dev()[prop];
  const canSet = (e.access & 2) !== 0;
  const ro = canSet ? '' : 'disabled';
  if (e.type === 'binary') {
    return `<label class="switch"><input type="checkbox" data-prop="${prop}" ${v === e.value_on ? 'checked' : ''} ${ro}><span></span></label>`;
  }
  if (e.type === 'enum') {
    if (!canSet) return `<span>${esc(valueLabel(v ?? t('common.unknown')))}</span>`;
    return `<select data-prop="${prop}">${v === undefined ? '<option value=""></option>' : ''}${e.values.map((x) => `<option value="${esc(x)}" ${String(v) === String(x) ? 'selected' : ''}>${esc(valueLabel(x))}</option>`).join('')}</select>`;
  }
  if (e.type === 'numeric') {
    if (!canSet) return `<span>${esc(fmtNum(v))}</span><span class="unit">${esc(e.unit || '')}</span>`;
    const hasRange = e.value_min !== undefined && e.value_max !== undefined;
    return `<div class="numctl">
      <div class="row"><input type="number" data-prop="${prop}" ${hasRange ? `min="${e.value_min}" max="${e.value_max}"` : ''} step="${e.value_step ?? 'any'}" value="${v ?? ''}"><span class="unit">${esc(e.unit || '')}</span></div>
      ${hasRange ? `<input type="range" data-range="${prop}" min="${e.value_min}" max="${e.value_max}" step="${e.value_step ?? 1}" value="${v ?? e.value_min}" aria-label="${esc(exposeLabel(prop).name)}">` : ''}
    </div>`;
  }
  if (e.type === 'text') {
    if (!canSet) return `<span>${esc(valueLabel(v ?? t('common.unknown')))}</span>`;
    return `<input type="text" data-prop="${prop}" value="${esc(v ?? '')}" ${prop.endsWith('_period') ? `placeholder="00:00-06:00" title="${esc(t('settings.periodHint'))}"` : ''}>`;
  }
  return `<span class="muted">${esc(JSON.stringify(v))}</span>`;
}

RENDERERS.settings = (root) => {
  if (needsDevice(root)) return;
  const listed = new Set(Object.values(SETTINGS_SECTIONS).flat());
  const others = Object.values(S.exposeMap)
    .filter((e) => e.property && !listed.has(e.property) && !HANDLED_ELSEWHERE.has(e.property) && ['binary', 'enum', 'numeric', 'text'].includes(e.type))
    .map((e) => e.property);
  const sections = { ...SETTINGS_SECTIONS, other: others };

  const html = Object.entries(sections).map(([key, props]) => {
    const items = props.map((p) => S.exposeMap[p]).filter(Boolean);
    if (!items.length) return '';
    return `<div class="card"><h2>${esc(t(`settings.sections.${key}`))}</h2>${items.map((e) => {
      const l = exposeLabel(e.property);
      return `<div class="setting"><div><div class="name">${esc(l.name)}${(e.access & 2) === 0 ? ` <span class="muted small">(${esc(t('settings.readonly'))})</span>` : ''}</div>${l.desc ? `<div class="desc">${esc(l.desc)}</div>` : ''}</div>
        <div class="control">${settingControl(e)}<span class="flash" data-flash="${e.property}"></span></div></div>`;
    }).join('')}</div>`;
  }).join('');

  root.innerHTML = `<h1>${esc(t('settings.title'))}</h1>${html}
    ${S.exposeMap.factory_reset ? `<div class="card"><h2>${esc(t('settings.sections.advanced'))}</h2><div class="setting"><div><div class="name">${esc(t('settings.reset'))}</div><div class="desc">${esc(t('settings.resetConfirm'))}</div></div><div class="control"><button class="btn danger" data-factory-reset>${esc(t('settings.reset'))}</button></div></div></div>` : ''}`;
};

async function applySetting(prop, value) {
  const flash = $(`[data-flash="${prop}"]`);
  if (flash) {
    flash.textContent = '…';
    flash.className = 'flash';
  }
  const res = await api.set(S.ieee, { [prop]: value });
  if (flash) {
    flash.textContent = res.ok ? '✓' : '✗';
    flash.className = `flash ${res.ok ? 'ok' : 'ko'}`;
    flash.title = res.ok ? '' : res.error;
  }
  if (!res.ok) toast(t('errors.send', { e: res.error }), true);
}

$('#page-settings').addEventListener('input', (e) => {
  if (e.target.matches('[data-range]')) {
    const num = $(`input[type=number][data-prop="${e.target.dataset.range}"]`);
    if (num) num.value = e.target.value;
  }
});

$('#page-settings').addEventListener('change', async (e) => {
  const el = e.target;
  if (el.matches('[data-range]')) return applySetting(el.dataset.range, Number(el.value));
  if (!el.matches('[data-prop]')) return;
  const prop = el.dataset.prop;
  const ex = S.exposeMap[prop];
  if (!ex) return;
  let value;
  if (ex.type === 'binary') value = el.checked ? ex.value_on : ex.value_off;
  else if (ex.type === 'numeric') {
    value = Number(el.value);
    if (Number.isNaN(value)) return;
    if (ex.value_min !== undefined) value = Math.max(ex.value_min, Math.min(ex.value_max, value));
    const range = $(`[data-range="${prop}"]`);
    if (range) range.value = value;
  } else value = el.value;
  await applySetting(prop, value);
});

$('#page-settings').addEventListener('click', async (e) => {
  if (e.target.closest('[data-factory-reset]') && (await confirmDialog(t('settings.resetConfirm')))) {
    await send({ factory_reset: 'reset' });
  }
});

function refreshSettingsValues() {
  const root = $('#page-settings');
  const st = dev();
  $$('[data-prop]', root).forEach((el) => {
    if (el === document.activeElement) return;
    const ex = S.exposeMap[el.dataset.prop];
    const v = st[el.dataset.prop];
    if (!ex || v === undefined) return;
    if (ex.type === 'binary') el.checked = v === ex.value_on;
    else el.value = v;
  });
  $$('[data-range]', root).forEach((el) => {
    const v = st[el.dataset.range];
    if (v !== undefined && el !== document.activeElement) el.value = v;
  });
}

// ============================================================ HISTORY
RENDERERS.history = (root) => {
  if (needsDevice(root)) return;
  const h = S.history;
  if (!h.date) {
    const d = new Date();
    h.date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const inputType = h.type === 'day' ? 'date' : 'month';
  const inputValue = h.type === 'day' ? h.date : h.date.slice(0, 7);
  const r = h.result;
  let body = '';
  if (h.waiting) body = `<p class="muted">${esc(t('history.waiting'))}</p>`;
  else if (h.error) body = `<p class="err">${esc(h.error)}</p>`;
  else if (r) body = historyChart(r) + (h.showTable ? historyTable(r) : '');

  root.innerHTML = `
    <h1>${esc(t('history.title'))}</h1>
    <p class="intro">${esc(t('history.intro'))}</p>
    <div class="card">
      <div class="row" style="margin-bottom:16px">
        <div class="segmented">${['day', 'month', 'half_year'].map((x) => `<button data-htype="${x}" class="${h.type === x ? 'active auto' : ''}">${esc(t(`history.${x}`))}</button>`).join('')}</div>
        <input type="${inputType}" value="${esc(inputValue)}" data-hdate aria-label="${esc(t('history.date'))}">
        <button class="btn primary" data-hread ${h.waiting || S.status.status !== 'running' ? 'disabled' : ''}>${esc(t('history.read'))}</button>
        <span class="spacer"></span>
        ${r ? `<label class="row small muted"><input type="checkbox" data-htable ${h.showTable ? 'checked' : ''}> ${esc(t('history.table'))}</label>` : ''}
      </div>
      ${body}
    </div>`;
};

function historyRange() {
  const h = S.history;
  const [y, m, d] = h.date.split('-').map(Number);
  let start;
  let end;
  if (h.type === 'day') {
    start = new Date(y, m - 1, d, 0, 0, 0);
    end = new Date(y, m - 1, d, 23, 59, 59);
  } else if (h.type === 'month') {
    start = new Date(y, m - 1, 1, 0, 0, 0);
    end = new Date(y, m, 0, 23, 59, 59);
  } else {
    start = new Date(y, m - 1, 1, 0, 0, 0);
    end = new Date(y, m - 1 + 6, 0, 23, 59, 59);
  }
  return { start: isoLocal(start), end: isoLocal(end) };
}

function historyLabel(iso) {
  const d = new Date(iso);
  const loc = S.lang === 'it' ? 'it-IT' : 'en-GB';
  if (S.history.result?.type === 'day') return `${pad(d.getHours())}:00`;
  if (S.history.result?.type === 'month') return String(d.getDate());
  return d.toLocaleDateString(loc, { month: 'short' });
}

function historyRows(r) {
  const map = new Map();
  const add = (list, key) => (list || []).forEach((x) => {
    const row = map.get(x.start_time) || { start: x.start_time };
    row[key] = x.value;
    map.set(x.start_time, row);
  });
  add(r.temperature_data, 'temp');
  add(r.target_temperature_data, 'target');
  add(r.heat_percentage_data, 'heat');
  return [...map.values()].sort((a, b) => new Date(a.start) - new Date(b.start));
}

function historyChart(r) {
  const rows = historyRows(r);
  if (!rows.length) return `<p class="muted">${esc(t('history.none'))}</p>`;
  const W = 960, H = 320, L = 44, R = 44, T = 14, B = 30;
  const temps = rows.flatMap((x) => [x.temp, x.target]).filter((v) => typeof v === 'number');
  let lo = Math.floor(Math.min(...temps, 15) - 1);
  let hi = Math.ceil(Math.max(...temps, 22) + 1);
  if (hi - lo < 4) hi = lo + 4;
  const n = rows.length;
  const bw = (W - L - R) / n;
  const x = (i) => L + bw * i + bw / 2;
  const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const yp = (p) => T + (H - T - B) * (1 - Math.min(100, Math.max(0, p)) / 100);
  const line = (key) => {
    let d = '';
    rows.forEach((row, i) => {
      if (typeof row[key] !== 'number') return;
      d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(row[key]).toFixed(1)}`;
    });
    return d;
  };
  const step = Math.max(1, Math.ceil(n / 12));
  const ticks = [];
  for (let v = lo; v <= hi; v += Math.max(1, Math.round((hi - lo) / 5))) ticks.push(v);
  const svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(t('history.title'))}">
    ${ticks.map((v) => `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}°</text>`).join('')}
    ${[0, 50, 100].map((p) => `<text x="${W - R + 6}" y="${yp(p) + 4}">${p}%</text>`).join('')}
    ${rows.map((row, i) => (typeof row.heat === 'number' ? `<rect class="bar" x="${(L + bw * i + bw * 0.15).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" y="${yp(row.heat).toFixed(1)}" height="${(H - B - yp(row.heat)).toFixed(1)}"><title>${esc(historyLabel(row.start))} · ${fmtNum(row.heat)}%</title></rect>` : '')).join('')}
    <path class="target" d="${line('target')}"/>
    <path class="temp" d="${line('temp')}"/>
    ${rows.map((row, i) => (i % step === 0 ? `<text x="${x(i)}" y="${H - 10}" text-anchor="middle">${esc(historyLabel(row.start))}</text>` : '')).join('')}
  </svg>`;
  return `${svg}<div class="legend"><span><i style="background:var(--accent)"></i>${esc(t('history.temperature'))}</span><span><i style="background:var(--heat)"></i>${esc(t('history.target'))}</span><span><i style="background:var(--heat);opacity:.3;height:10px"></i>${esc(t('history.heat'))} (%)</span></div>`;
}

function historyTable(r) {
  const rows = historyRows(r);
  if (!rows.length) return '';
  return `<table style="margin-top:16px"><thead><tr><th>${esc(t('history.time'))}</th><th class="num">${esc(t('history.temperature'))}</th><th class="num">${esc(t('history.target'))}</th><th class="num">${esc(t('history.heat'))}</th></tr></thead>
    <tbody>${rows.map((row) => `<tr><td>${esc(historyLabel(row.start))}</td><td class="num">${esc(fmtNum(row.temp))} °C</td><td class="num">${esc(fmtNum(row.target))} °C</td><td class="num">${esc(fmtNum(row.heat))} %</td></tr>`).join('')}</tbody></table>`;
}

$('#page-history').addEventListener('click', async (e) => {
  const h = S.history;
  const tb = e.target.closest('[data-htype]');
  if (tb) {
    h.type = tb.dataset.htype;
    h.result = undefined;
    h.error = '';
    return renderPage('history', true);
  }
  if (e.target.closest('[data-hread]')) {
    const { start, end } = historyRange();
    h.waiting = true;
    h.error = '';
    h.result = undefined;
    h.start = start;
    renderPage('history', true);
    const res = await api.set(S.ieee, { read_temperature_control_history: { type: h.type, time_range: { start, end } } });
    if (!res.ok) {
      h.waiting = false;
      h.error = t('errors.send', { e: res.error });
      return renderPage('history', true);
    }
    clearTimeout(h.timer);
    h.timer = setTimeout(() => {
      if (h.waiting) {
        h.waiting = false;
        h.error = t('history.timeout');
        renderPage('history', true);
      }
    }, 30000);
  }
});

$('#page-history').addEventListener('change', (e) => {
  const h = S.history;
  if (e.target.matches('[data-hdate]')) {
    h.date = e.target.value.length === 7 ? `${e.target.value}-01` : e.target.value;
    h.result = undefined;
  }
  if (e.target.matches('[data-htable]')) {
    h.showTable = e.target.checked;
    renderPage('history', true);
  }
});

function onHistoryState(changed) {
  const r = changed.temperature_control_history;
  if (!r) return;
  const h = S.history;
  if (h.waiting && r.time_range?.start === h.start) {
    h.waiting = false;
    h.result = r;
    clearTimeout(h.timer);
    if (S.page === 'history') renderPage('history', true);
  }
}

// ============================================================ NETWORK
RENDERERS.network = (root) => {
  const c = S.config;
  const st = S.status.status;
  const pj = S.permitJoin;
  const left = pj.permitted && pj.end ? Math.max(0, Math.round((pj.end - Date.now()) / 1000)) : 0;
  const portOptions = [...new Set([c.port, ...S.ports.map((p) => p.path)].filter(Boolean))];

  root.innerHTML = `
    <h1>${esc(t('network.title'))}</h1>
    <p class="intro">${esc(t('network.z2mNote'))}</p>
    ${!c.hasNetwork ? `<div class="card"><h2>${esc(t('network.setupTitle'))}</h2><p class="muted">${esc(t('network.setupIntro'))}</p>
      <div class="row"><button class="btn primary" data-import>${esc(t('network.importZ2M'))}</button><button class="btn" data-newnet>${esc(t('network.newNetwork'))}</button></div>
      <p class="muted small">${esc(t('network.importHint'))}</p></div>` : ''}
    <div class="card">
      <div class="form-row"><span class="muted">${esc(t('network.status'))}</span><span><strong>${esc(t(`status.${st}`))}</strong> ${S.status.message ? `<span class="muted small">— ${esc(S.status.message)}</span>` : ''}</span></div>
      <div class="form-row"><label class="muted" for="portSel">${esc(t('network.port'))}</label>
        <div class="row"><select id="portSel">${portOptions.map((p) => {
          const info = S.ports.find((x) => x.path === p);
          return `<option value="${esc(p)}" ${p === c.port ? 'selected' : ''}>${esc(p)}${info?.manufacturer ? ` — ${esc(info.manufacturer)}` : ''}</option>`;
        }).join('')}</select><button class="btn small" data-ports>${esc(t('network.refreshPorts'))}</button></div></div>
      <div class="form-row"><label class="muted" for="adapterSel">${esc(t('network.adapter'))}</label>
        <select id="adapterSel">${Object.entries(ADAPTERS).map(([a, label]) => `<option value="${a}" ${a === c.adapter ? 'selected' : ''}>${a} — ${esc(label)}</option>`).join('')}</select></div>
      <div class="row" style="margin-top:6px">
        <button class="btn primary" data-saverestart ${c.hasNetwork ? '' : 'disabled'}>${esc(t('network.saveRestart'))}</button>
        ${st === 'running' || st === 'starting' ? `<button class="btn" data-disconnect>${esc(t('network.disconnect'))}</button>` : `<button class="btn" data-connect ${c.complete ? '' : 'disabled'}>${esc(t('network.connect'))}</button>`}
      </div>
    </div>
    <div class="card">
      <h2>${esc(t('network.pairing'))}</h2>
      <div class="row">
        ${pj.permitted ? `<button class="btn" data-join="0">${esc(t('network.stopJoin'))}</button><strong>${esc(t('network.joinOpen', { s: left }))}</strong>` : `<button class="btn primary" data-join="254" ${st === 'running' ? '' : 'disabled'}>${esc(t('network.permitJoin'))}</button>`}
      </div>
      <p class="muted small">${esc(t('network.joinHint'))}</p>
    </div>
    <div class="card">
      <h2>${esc(t('network.devices'))}</h2>
      ${S.devices.length ? `<table class="devices"><thead><tr><th>IEEE</th><th>Model</th><th>Type</th><th>Interview</th></tr></thead><tbody>
        ${S.devices.map((d) => `<tr><td>${esc(d.ieee)}</td><td>${esc(d.vendor || d.manufacturer || '')} ${esc(d.model || d.modelID || '')}<div class="muted small">${esc(d.description || '')}</div></td><td>${esc(d.type)}</td><td>${esc(d.interviewState)}</td></tr>`).join('')}
      </tbody></table>` : `<p class="muted">${esc(t('network.none'))}</p>`}
      ${c.hasNetwork ? `<div class="row" style="margin-top:16px"><button class="btn small" data-import>${esc(t('network.importZ2M'))}</button><button class="btn small danger" data-newnet>${esc(t('network.newNetwork'))}</button></div>` : ''}
      <p class="muted small" style="margin-top:12px">${esc(t('network.dataDir'))}: ${esc(S.dataDir)}</p>
    </div>`;
};

async function refreshPorts() {
  try {
    S.ports = await api.listPorts();
  } catch {
    S.ports = [];
  }
  if (S.page === 'network') renderPage('network', true);
}

$('#page-network').addEventListener('click', async (e) => {
  if (e.target.closest('[data-ports]')) return refreshPorts();
  if (e.target.closest('[data-import]')) {
    const res = await api.importZ2M().catch((err) => ({ error: err.message }));
    if (res?.error) return toast(res.error, true);
    if (res?.canceled) return;
    S.config = res.config;
    toast(t('network.imported'));
    renderPage('network', true);
    await api.start();
    return;
  }
  if (e.target.closest('[data-newnet]')) {
    if (!(await confirmDialog(t('network.newNetworkConfirm')))) return;
    S.config = await api.newNetwork();
    renderPage('network', true);
    return;
  }
  if (e.target.closest('[data-saverestart]')) {
    S.config = await api.saveConfig({ port: $('#portSel').value, adapter: $('#adapterSel').value });
    await api.restart();
    return;
  }
  if (e.target.closest('[data-connect]')) return void (await api.start());
  if (e.target.closest('[data-disconnect]')) return void (await api.stop());
  const j = e.target.closest('[data-join]');
  if (j) {
    const res = await api.permitJoin(Number(j.dataset.join));
    if (!res.ok) toast(res.error, true);
  }
});

setInterval(() => {
  if (S.page === 'network' && S.permitJoin.permitted) renderPage('network');
}, 1000);

// ============================================================ LOG
RENDERERS.log = (root) => {
  root.innerHTML = `<div class="row" style="margin-bottom:12px"><h1 style="margin:0">${esc(t('log.title'))}</h1><span class="spacer"></span><button class="btn small" data-logclear>${esc(t('log.clear'))}</button></div>
    <div class="log-list" id="logList">${S.logs.map(logLine).join('')}</div>`;
  const list = $('#logList');
  list.scrollTop = list.scrollHeight;
};

function logLine(l) {
  const time = new Date(l.time).toLocaleTimeString(S.lang === 'it' ? 'it-IT' : 'en-GB');
  return `<div class="${esc(l.level)}"><time>${esc(time)}</time>${esc(l.message)}</div>`;
}

$('#page-log').addEventListener('click', (e) => {
  if (e.target.closest('[data-logclear]')) {
    S.logs = [];
    renderPage('log', true);
  }
});

// ============================================================ data flow
async function selectDevice() {
  const pick = S.devices.find((d) => d.model === 'TP-WGZBA') || S.devices.find((d) => d.supported) || S.devices[0];
  const ieee = pick?.ieee;
  if (ieee !== S.ieee) {
    S.ieee = ieee;
    S.draft = {};
  }
  if (pick) S.state = { ...pick.state, ...S.state };
  if (ieee) {
    const list = await api.exposes(ieee);
    const map = {};
    const walk = (e) => {
      if (e.property) map[e.property] = e;
      (e.features || []).forEach((f) => (e.type === 'composite' ? null : walk(f)));
      if (e.type === 'composite' && e.property) map[e.property] = e;
    };
    list.forEach(walk);
    if (Object.keys(map).length) S.exposeMap = map;
  }
}

function setLanguage(lang) {
  S.lang = lang;
  applyStaticI18n();
  renderStatus();
  renderPage(S.page, true);
  api.saveConfig({ language: lang });
}

async function init() {
  const data = await api.init();
  S.config = data.config;
  S.lang = data.config.language;
  S.status = data.status;
  S.devices = data.devices;
  S.logs = data.logs;
  S.permitJoin = data.permitJoin;
  S.dataDir = data.dataDir;
  await selectDevice();
  applyStaticI18n();
  renderStatus();

  $('#nav').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-page]');
    if (b) showPage(b.dataset.page);
  });
  $$('.lang button').forEach((b) => b.addEventListener('click', () => setLanguage(b.dataset.lang)));

  api.on('status', (s) => {
    S.status = s;
    renderStatus();
    renderPage();
  });
  api.on('devices', async (list) => {
    S.devices = list;
    await selectDevice();
    renderPage();
  });
  api.on('state', ({ ieee, state, changed }) => {
    if (ieee !== S.ieee) return;
    S.state = state;
    onHistoryState(changed);
    if (S.page === 'settings') refreshSettingsValues();
    else if (S.page !== 'history' && S.page !== 'log' && S.page !== 'network') renderPage();
  });
  api.on('lastSeen', ({ ieee, lastSeen }) => {
    const d = S.devices.find((x) => x.ieee === ieee);
    if (d) d.lastSeen = lastSeen;
  });
  api.on('permitJoin', (pj) => {
    S.permitJoin = pj;
    if (S.page === 'network') renderPage('network', true);
  });
  api.on('log', (entry) => {
    S.logs.push(entry);
    if (S.logs.length > 500) S.logs.shift();
    if (S.page === 'log') {
      const list = $('#logList');
      if (list) {
        const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
        list.insertAdjacentHTML('beforeend', logLine(entry));
        if (atBottom) list.scrollTop = list.scrollHeight;
      }
    }
  });

  refreshPorts();
  showPage(data.config.hasNetwork ? 'home' : 'network');
}

init();
