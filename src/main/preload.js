'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const events = ['status', 'state', 'devices', 'log', 'permitJoin', 'lastSeen'];

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('app:init'),
  listPorts: () => ipcRenderer.invoke('ports:list'),
  saveConfig: (partial) => ipcRenderer.invoke('config:save', partial),
  importZ2M: () => ipcRenderer.invoke('config:import'),
  newNetwork: () => ipcRenderer.invoke('config:newNetwork'),
  start: () => ipcRenderer.invoke('zigbee:start'),
  stop: () => ipcRenderer.invoke('zigbee:stop'),
  restart: () => ipcRenderer.invoke('zigbee:restart'),
  permitJoin: (seconds) => ipcRenderer.invoke('zigbee:permitJoin', seconds),
  exposes: (ieee) => ipcRenderer.invoke('device:exposes', ieee),
  set: (ieee, payload) => ipcRenderer.invoke('device:set', ieee, payload),
  get: (ieee, keys) => ipcRenderer.invoke('device:get', ieee, keys),
  on: (event, callback) => {
    if (!events.includes(event)) return;
    ipcRenderer.on(`zigbee:${event}`, (_e, payload) => callback(payload));
  },
});
