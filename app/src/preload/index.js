'use strict';

/** 所有窗口共用的一座小桥：只暴露 send / invoke / on 三个动作。 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aqua', {
  init: () => ipcRenderer.invoke('init'),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, fn) => {
    const sub = (_event, ...args) => fn(...args);
    ipcRenderer.on(channel, sub);
    return () => ipcRenderer.removeListener(channel, sub);
  },
});
