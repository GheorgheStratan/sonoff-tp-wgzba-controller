'use strict';
// Zigbee service: drives the USB dongle through zigbee-herdsman and translates
// device messages with zigbee-herdsman-converters. It reproduces the parts of
// Zigbee2MQTT that matter for a single thermostat (receive, publish, onEvent,
// configure) without MQTT, a broker or a web frontend.

const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { Controller, setLogger: zhSetLogger } = require('zigbee-herdsman');
const zhc = require('zigbee-herdsman-converters');

const IGNORED_CLUSTERS = ['genOta', 'genTime', 'genBasic', 'genPollCtrl'];
const LOG_LIMIT = 500;

function isEmpty(obj) {
  return !obj || Object.keys(obj).length === 0;
}

function serializeExpose(e) {
  return JSON.parse(JSON.stringify(e));
}

class ZigbeeService extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.controller = undefined;
    this.definitions = new Map(); // ieee -> zhc definition
    this.state = {}; // ieee -> state object
    this.startCalled = new Set();
    this.configuring = new Set();
    this.configureAttempts = new Map();
    this.logs = [];
    this.status = 'stopped'; // stopped | starting | running | error
    this.statusMessage = '';
    this.coordinator = undefined;
    this.statePath = path.join(dataDir, 'state.json');
    this.saveTimer = undefined;

    const logger = {
      debug: () => {},
      info: (m, ns) => this.log('info', m, ns),
      warning: (m, ns) => this.log('warning', m, ns),
      error: (m, ns) => this.log('error', m, ns),
    };
    this.logger = logger;
    zhSetLogger(logger);
    zhc.setLogger(logger);
    this.loadState();
  }

  // ---------- logging ----------
  log(level, message, namespace = 'app') {
    const text = typeof message === 'function' ? message() : String(message);
    const entry = { time: new Date().toISOString(), level, namespace, message: text };
    this.logs.push(entry);
    if (this.logs.length > LOG_LIMIT) this.logs.shift();
    try {
      fs.appendFileSync(path.join(this.dataDir, 'app.log'), `${entry.time} [${level}] ${namespace}: ${text}\n`);
    } catch {}
    this.emit('log', entry);
  }

  // ---------- state persistence ----------
  loadState() {
    try {
      this.state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch {
      this.state = {};
    }
  }

  scheduleSaveState() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveStateNow(), 2000);
  }

  saveStateNow() {
    clearTimeout(this.saveTimer);
    try {
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 1));
    } catch (e) {
      this.log('error', `Cannot save state: ${e.message}`);
    }
  }

  setState(ieee, payload) {
    if (isEmpty(payload)) return;
    this.state[ieee] = { ...(this.state[ieee] || {}), ...payload };
    this.scheduleSaveState();
    this.emit('state', { ieee, state: this.state[ieee], changed: payload });
  }

  setStatus(status, message = '') {
    this.status = status;
    this.statusMessage = message;
    this.emit('status', { status, message });
  }

  // ---------- lifecycle ----------
  async start(config) {
    if (this.status === 'starting' || this.status === 'running') return;
    this.setStatus('starting');
    this.abort = new AbortController();

    const settings = {
      network: {
        panID: config.panID,
        extendedPanID: config.extendedPanID,
        channelList: [config.channel || 11],
        networkKey: config.networkKey,
      },
      databasePath: path.join(this.dataDir, 'database.db'),
      databaseBackupPath: path.join(this.dataDir, 'database.db.backup'),
      backupPath: path.join(this.dataDir, 'coordinator_backup.json'),
      transport: {
        path: config.port,
        adapter: config.adapter || 'ember',
        baudRate: config.baudRate,
        rtscts: config.rtscts,
      },
      adapter: { disableLED: false },
      acceptJoiningDeviceHandler: async () => true,
    };

    try {
      this.controller = new Controller(settings);
      this.bindControllerEvents();
      const result = await this.controller.start(this.abort.signal);
      this.coordinator = this.controller.getDevicesByType('Coordinator')[0];
      const version = await this.controller.getCoordinatorVersion();
      this.log('info', `Zigbee started (${result}), coordinator firmware ${version?.meta?.revision ?? '?'}`);

      for (const device of this.devices()) {
        await this.resolveDefinition(device);
        this.callOnEvent(device, { type: 'start', data: this.onEventBase(device) }).catch(() => {});
      }
      this.setStatus('running');
      this.emit('devices', this.listDevices());
    } catch (e) {
      this.log('error', `Zigbee start failed: ${e.stack || e.message}`);
      this.setStatus('error', e.message);
      try {
        await this.controller?.stop();
      } catch {}
      this.controller = undefined;
    }
  }

  async stop() {
    if (!this.controller) {
      this.setStatus('stopped');
      return;
    }
    this.abort?.abort();
    for (const device of this.devices()) {
      try {
        await this.callOnEvent(device, { type: 'stop', data: { ieeeAddr: device.ieeeAddr } });
      } catch {}
    }
    try {
      await this.controller.stop();
    } catch (e) {
      this.log('error', `Stop failed: ${e.message}`);
    }
    this.controller = undefined;
    this.saveStateNow();
    this.setStatus('stopped');
  }

  bindControllerEvents() {
    const c = this.controller;
    c.on('message', (data) => this.onMessage(data).catch((e) => this.log('error', `Message handling failed: ${e.message}`)));
    c.on('deviceJoined', async ({ device }) => {
      this.log('info', `Device ${device.ieeeAddr} joined`);
      if (device.meta?.configured !== undefined) {
        delete device.meta.configured;
        device.save();
      }
      await this.resolveDefinition(device);
      await this.callOnEvent(device, { type: 'deviceJoined', data: this.onEventBase(device) }).catch(() => {});
      await this.configure(device);
      this.emit('devices', this.listDevices());
    });
    c.on('deviceInterview', async ({ device, status }) => {
      this.log('info', `Interview of ${device.ieeeAddr}: ${status}`);
      await this.resolveDefinition(device);
      await this.callOnEvent(device, { type: 'deviceInterview', data: { ...this.onEventBase(device), status } }).catch(() => {});
      if (status === 'successful') await this.configure(device);
      this.emit('devices', this.listDevices());
    });
    c.on('deviceAnnounce', async ({ device }) => {
      await this.callOnEvent(device, { type: 'deviceAnnounce', data: this.onEventBase(device) }).catch(() => {});
    });
    c.on('deviceLeave', ({ ieeeAddr }) => {
      this.log('warning', `Device ${ieeeAddr} left the network`);
      this.emit('devices', this.listDevices());
    });
    c.on('lastSeenChanged', ({ device }) => {
      if (device.type === 'Coordinator') return;
      this.configure(device).catch(() => {});
      this.emit('lastSeen', { ieee: device.ieeeAddr, lastSeen: device.lastSeen });
    });
    c.on('permitJoinChanged', (data) => this.emit('permitJoin', { permitted: data.permitted, time: data.time, end: c.getPermitJoinEnd?.() }));
    c.on('adapterDisconnected', () => {
      this.log('error', 'USB dongle disconnected');
      this.controller = undefined;
      this.setStatus('error', 'adapterDisconnected');
    });
  }

  // ---------- devices ----------
  *devices() {
    if (!this.controller) return;
    for (const d of this.controller.getDevicesIterator((x) => x.type !== 'Coordinator')) yield d;
  }

  getDevice(ieee) {
    return this.controller?.getDeviceByIeeeAddr(ieee);
  }

  interviewed(device) {
    return device.interviewState === 'SUCCESSFUL' || device.interviewState === 'FAILED';
  }

  async resolveDefinition(device) {
    if (!this.interviewed(device)) return undefined;
    const cached = this.definitions.get(device.ieeeAddr);
    if (cached && cached.__modelID === device.modelID) return cached;
    const def = await zhc.findByDevice(device, true);
    if (def) {
      def.__modelID = device.modelID;
      this.definitions.set(device.ieeeAddr, def);
    }
    return def;
  }

  exposes(ieee) {
    const device = this.getDevice(ieee);
    const def = this.definitions.get(ieee);
    if (!device || !def) return [];
    const list = typeof def.exposes === 'function' ? def.exposes(device, {}) : def.exposes;
    return list.map(serializeExpose);
  }

  listDevices() {
    return [...this.devices()].map((d) => {
      const def = this.definitions.get(d.ieeeAddr);
      return {
        ieee: d.ieeeAddr,
        type: d.type,
        modelID: d.modelID,
        manufacturer: d.manufacturerName,
        model: def?.model,
        vendor: def?.vendor,
        description: def?.description,
        supported: Boolean(def && !def.generated),
        interviewState: d.interviewState,
        lastSeen: d.lastSeen,
        state: this.state[d.ieeeAddr] || {},
      };
    });
  }

  onEventBase(device) {
    return {
      deviceExposesChanged: () => this.emit('devices', this.listDevices()),
      device,
      state: this.state[device.ieeeAddr] || {},
      options: {},
    };
  }

  async callOnEvent(device, event) {
    const def = this.definitions.get(device.ieeeAddr);
    if (event.type === 'start') {
      this.startCalled.add(device.ieeeAddr);
    } else if (event.type !== 'stop' && !this.startCalled.has(device.ieeeAddr) && def?.onEvent) {
      this.startCalled.add(device.ieeeAddr);
      await def.onEvent({ type: 'start', data: this.onEventBase(device) });
    }
    await zhc.onEvent(event);
    await def?.onEvent?.(event);
    if (event.type === 'stop') this.startCalled.delete(device.ieeeAddr);
  }

  async configure(device, force = false) {
    const def = this.definitions.get(device.ieeeAddr);
    if (!def?.configure || !this.coordinator) return;
    const version = def.version;
    if (!force) {
      if (!this.interviewed(device)) return;
      const should = device.meta?.configured === undefined || (version !== '0.0.0' && device.meta?.configured !== version);
      if (!should) return;
      if ((this.configureAttempts.get(device.ieeeAddr) ?? 0) >= 3) return;
    }
    if (this.configuring.has(device.ieeeAddr)) return;
    this.configuring.add(device.ieeeAddr);
    this.log('info', `Configuring ${device.ieeeAddr}`);
    try {
      await def.configure(device, this.coordinator.getEndpoint(1), def);
      this.configureAttempts.delete(device.ieeeAddr);
      device.meta.configured = version;
      device.save();
      this.log('info', `Configured ${device.ieeeAddr}`);
    } catch (e) {
      this.configureAttempts.set(device.ieeeAddr, (this.configureAttempts.get(device.ieeeAddr) ?? 0) + 1);
      this.log('error', `Configure of ${device.ieeeAddr} failed: ${e.message}`);
      if (force) throw e;
    } finally {
      this.configuring.delete(device.ieeeAddr);
    }
  }

  // ---------- receive (Zigbee -> state) ----------
  async onMessage(data) {
    const device = data.device;
    if (!device || device.type === 'Coordinator') return;
    const def = await this.resolveDefinition(device);
    if (!def || !this.interviewed(device)) return;

    const converters = def.fromZigbee.filter((c) => {
      const typeOk = Array.isArray(c.type) ? c.type.includes(data.type) : c.type === data.type;
      return c.cluster === data.cluster && typeOk;
    });
    if (converters.length === 0) {
      if (!IGNORED_CLUSTERS.includes(data.cluster)) {
        this.log('info', `No converter for cluster ${data.cluster} type ${data.type}`, 'receive');
      }
      return;
    }

    const ieee = device.ieeeAddr;
    const options = {};
    const publish = (payload) => {
      zhc.postProcessConvertedFromZigbeeMessage(def, payload, options, device);
      this.setState(ieee, { ...payload, linkquality: data.linkquality });
    };
    const meta = {
      device,
      logger: this.logger,
      state: this.state[ieee] || {},
      deviceExposesChanged: () => this.emit('devices', this.listDevices()),
    };

    let payload = {};
    for (const converter of converters) {
      try {
        const converted = await converter.convert(def, { ...data, device }, publish, options, meta);
        if (converted) payload = { ...payload, ...converted };
      } catch (e) {
        this.log('error', `fromZigbee converter failed: ${e.message}`, 'receive');
      }
    }
    if (!isEmpty(payload)) publish(payload);
  }

  // ---------- publish (state change request -> Zigbee) ----------
  async set(ieee, message) {
    return this.sendToDevice(ieee, message, 'set');
  }

  async get(ieee, keys) {
    const message = Object.fromEntries(keys.map((k) => [k, '']));
    return this.sendToDevice(ieee, message, 'get');
  }

  async sendToDevice(ieee, message, type) {
    const device = this.getDevice(ieee);
    if (!device) throw new Error(`Unknown device ${ieee}`);
    const def = await this.resolveDefinition(device);
    if (!def) throw new Error('Unsupported device');
    const endpoint = def.endpoint ? device.getEndpoint(def.endpoint(device).default) ?? device.endpoints[0] : device.endpoints[0];
    const used = [];
    const errors = [];
    let optimistic = {};

    for (const [key, value] of Object.entries(message)) {
      const converter = def.toZigbee.find((c) => !c.key || c.key.includes(key));
      if (!converter) {
        errors.push(`${key}: no converter`);
        continue;
      }
      if (type === 'set' && used.includes(converter)) continue;
      const meta = {
        endpoint_name: undefined,
        options: {},
        message: { ...message },
        device,
        state: this.state[ieee] || {},
        membersState: undefined,
        mapped: def,
        deviceExposesChanged: () => this.emit('devices', this.listDevices()),
        publish: (payload) => this.setState(ieee, payload),
      };
      try {
        if (type === 'set' && converter.convertSet) {
          const result = await converter.convertSet(endpoint, key, value, meta);
          if (result?.state) optimistic = { ...optimistic, ...result.state };
        } else if (type === 'get' && converter.convertGet) {
          await converter.convertGet(endpoint, key, meta);
        } else {
          errors.push(`${key}: ${type} not supported`);
          continue;
        }
      } catch (e) {
        errors.push(`${key}: ${e.message}`);
        this.log('error', `${type} '${key}' failed: ${e.message}`, 'publish');
      }
      used.push(converter);
    }
    this.setState(ieee, optimistic);
    if (errors.length) throw new Error(errors.join('; '));
    return true;
  }

  async permitJoin(seconds) {
    if (!this.controller) throw new Error('Zigbee not running');
    await this.controller.permitJoin(seconds);
  }
}

module.exports = { ZigbeeService };
