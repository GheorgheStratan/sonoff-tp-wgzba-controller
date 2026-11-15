'use strict';
const path = require('node:path');
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const config = require('./config');
const { ZigbeeService } = require('./zigbee');

if (!app.requestSingleInstanceLock()) {
  // The dongle can only be opened by one process at a time.
  app.quit();
  process.exit(0);
}

const dataDir = path.join(app.getPath('userData'), 'zigbee');
let win;
let zigbee;
let quitting = false;

function currentConfig() {
  return config.load(dataDir) || {};
}

function publicConfig() {
  const c = currentConfig();
  return {
    port: c.port || '',
    adapter: c.adapter || 'ember',
    channel: c.channel || 11,
    language: c.language || (app.getLocale().toLowerCase().startsWith('it') ? 'it' : 'en'),
    complete: config.isComplete(c),
    hasNetwork: Boolean(c.networkKey),
  };
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 760,
    minHeight: 600,
    title: 'Sonoff Thermostat',
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    backgroundColor: '#0f1419',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  if (process.env.SMOKE_SHOT) win.webContents.once('did-finish-load', () => smokeScreenshots(process.env.SMOKE_SHOT));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// Development aid: SMOKE_SHOT=<folder> saves a screenshot of every page, then quits.
async function smokeScreenshots(dir) {
  const fs = require('node:fs');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  fs.mkdirSync(dir, { recursive: true });
  await wait(Number(process.env.SMOKE_WAIT || 4000));
  const langs = (process.env.SMOKE_LANGS || 'it').split(',');
  for (const lang of langs) {
    await win.webContents.executeJavaScript(`setLanguage(${JSON.stringify(lang)})`);
    for (const page of ['home', 'schedule', 'settings', 'history', 'network', 'log']) {
      await win.webContents.executeJavaScript(`showPage(${JSON.stringify(page)})`);
      await wait(400);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(dir, `${lang}-${page}.png`), img.toPNG());
    }
  }
  app.quit();
}

function wireZigbee() {
  zigbee = new ZigbeeService(dataDir);
  for (const ev of ['status', 'state', 'devices', 'log', 'permitJoin', 'lastSeen']) {
    zigbee.on(ev, (payload) => send(`zigbee:${ev}`, payload));
  }
}

async function startZigbee() {
  const c = currentConfig();
  if (!config.isComplete(c)) return;
  await zigbee.start(c);
}

function registerIpc() {
  ipcMain.handle('app:init', () => ({
    config: publicConfig(),
    status: { status: zigbee.status, message: zigbee.statusMessage },
    devices: zigbee.listDevices(),
    logs: zigbee.logs,
    permitJoin: { permitted: zigbee.controller?.getPermitJoin?.() ?? false, end: zigbee.controller?.getPermitJoinEnd?.() },
    dataDir,
    version: app.getVersion(),
  }));

  ipcMain.handle('ports:list', async () => {
    const { autoDetect } = require('@serialport/bindings-cpp');
    const ports = await autoDetect().list();
    return ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer || '', vendorId: p.vendorId, productId: p.productId }));
  });

  ipcMain.handle('config:save', async (_e, partial) => {
    const allowed = {};
    if (typeof partial.port === 'string') allowed.port = partial.port;
    if (['ember', 'zstack', 'deconz', 'zigate', 'zboss'].includes(partial.adapter)) allowed.adapter = partial.adapter;
    if (['it', 'en'].includes(partial.language)) allowed.language = partial.language;
    const next = { ...currentConfig(), ...allowed };
    config.save(dataDir, next);
    return publicConfig();
  });

  ipcMain.handle('config:import', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Zigbee2MQTT data folder',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    await zigbee.stop();
    config.importFromZ2M(res.filePaths[0], dataDir);
    zigbee.loadState();
    return { canceled: false, config: publicConfig() };
  });

  ipcMain.handle('config:newNetwork', async () => {
    await zigbee.stop();
    const next = { ...currentConfig(), ...config.generateNetwork() };
    config.save(dataDir, next);
    return publicConfig();
  });

  ipcMain.handle('zigbee:start', () => startZigbee());
  ipcMain.handle('zigbee:stop', () => zigbee.stop());
  ipcMain.handle('zigbee:restart', async () => {
    await zigbee.stop();
    await startZigbee();
  });

  ipcMain.handle('device:exposes', (_e, ieee) => zigbee.exposes(ieee));
  ipcMain.handle('device:set', async (_e, ieee, payload) => {
    try {
      await zigbee.set(ieee, payload);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('device:get', async (_e, ieee, keys) => {
    try {
      await zigbee.get(ieee, keys);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('zigbee:permitJoin', async (_e, seconds) => {
    try {
      await zigbee.permitJoin(Math.max(0, Math.min(254, Number(seconds) || 0)));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

app.whenReady().then(() => {
  wireZigbee();
  registerIpc();
  createWindow();
  startZigbee();
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('before-quit', async (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  try {
    await zigbee?.stop();
  } finally {
    app.exit(0);
  }
});

app.on('window-all-closed', () => app.quit());
