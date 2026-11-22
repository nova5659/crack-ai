'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('crackDesktop', {
  platform: process.platform,
  setTheme(theme) {
    if (theme === 'light' || theme === 'dark') {
      ipcRenderer.send('crack:set-theme', theme);
    }
  },
});
