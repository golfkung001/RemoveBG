'use strict';
/* The only bridge between the page and the app: a fixed list of calls. */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel, fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('removebg', {
  status: () => call('status'),
  setSettings: patch => call('settings:set', patch),
  downloadModel: id => call('model:download', id),
  cancelDownload: () => call('model:cancel'),
  importModel: () => call('model:import'),
  useModel: id => call('model:use', id),
  pickFiles: () => call('files:pick', 'files'),
  pickFolder: () => call('files:pick', 'folder'),
  /* dropped files: the page only sees File objects; their paths come from Electron */
  addDropped: fileList => call('files:add', Array.from(fileList || [], f => webUtils.getPathForFile(f)).filter(Boolean)),
  removeItems: ids => call('files:remove', ids),
  clearItems: which => call('files:clear', which),
  thumb: (id, which) => call('thumb', id, which),
  preview: id => call('preview', id),
  start: ids => call('queue:start', ids),
  stop: () => call('queue:stop'),
  showOutput: id => call('output:show', id),
  pickOutputDir: () => call('output:pickDir'),
  openExternal: key => call('open:external', key),
  openDataFolder: () => call('open:data'),
  onItem: fn => on('item', fn),
  onQueue: fn => on('queue', fn),
  onModelProgress: fn => on('model:progress', fn),
  onStatus: fn => on('status', fn)
});
