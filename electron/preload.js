const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('decklink', {
    enumerateDevices: () => ipcRenderer.invoke('decklink:enumerate'),
    startOutput: (opts) => ipcRenderer.invoke('decklink:startOutput', opts),
    startPassthrough: (opts) => ipcRenderer.invoke('decklink:startPassthrough', opts),
    stop: () => ipcRenderer.invoke('decklink:stop'),
    getStatus: () => ipcRenderer.invoke('decklink:status'),
    pushCDP: (buffer) => ipcRenderer.invoke('decklink:pushCDP', buffer),
    clearCaptions: () => ipcRenderer.invoke('decklink:clearCaptions'),
    // Flag so renderer knows DeckLink is available
    available: true
});
