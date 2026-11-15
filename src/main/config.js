'use strict';
// App configuration (serial port + Zigbee network keys) stored in the user data folder.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');

const NETWORK_FILES = ['database.db', 'coordinator_backup.json', 'state.json'];

function configPath(dataDir) {
  return path.join(dataDir, 'config.json');
}

function load(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(configPath(dataDir), 'utf8'));
  } catch {
    return undefined;
  }
}

function save(dataDir, config) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(configPath(dataDir), JSON.stringify(config, null, 1));
}

function isComplete(config) {
  return Boolean(config && config.port && config.networkKey && config.panID !== undefined && config.extendedPanID);
}

function generateNetwork() {
  return {
    panID: crypto.randomInt(1, 0xfffe),
    extendedPanID: Array.from(crypto.randomBytes(8)),
    networkKey: Array.from(crypto.randomBytes(16)),
    channel: 11,
  };
}

/**
 * Import network keys, serial settings, device database and last state from a
 * Zigbee2MQTT "data" folder, so the paired thermostat keeps working without re-pairing.
 */
function importFromZ2M(z2mDataDir, dataDir) {
  const yamlPath = path.join(z2mDataDir, 'configuration.yaml');
  if (!fs.existsSync(yamlPath)) throw new Error('configuration.yaml not found');
  const z2m = yaml.load(fs.readFileSync(yamlPath, 'utf8')) || {};
  const adv = z2m.advanced || {};
  if (!Array.isArray(adv.network_key) || adv.pan_id === undefined || !Array.isArray(adv.ext_pan_id)) {
    throw new Error('Network keys not found (Zigbee2MQTT must have been started at least once)');
  }
  fs.mkdirSync(dataDir, { recursive: true });
  for (const f of NETWORK_FILES) {
    const src = path.join(z2mDataDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dataDir, f));
  }
  const previous = load(dataDir) || {};
  const config = {
    ...previous,
    port: z2m.serial?.port || previous.port,
    adapter: z2m.serial?.adapter || 'ember',
    baudRate: z2m.serial?.baudrate,
    rtscts: z2m.serial?.rtscts,
    channel: adv.channel || 11,
    panID: adv.pan_id,
    extendedPanID: adv.ext_pan_id,
    networkKey: adv.network_key,
  };
  save(dataDir, config);
  return config;
}

module.exports = { load, save, isComplete, generateNetwork, importFromZ2M };
