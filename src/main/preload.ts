// One preload for every dictate window: a small, channel-checked bridge, plus the STT audio port for the pill.
import { contextBridge, ipcRenderer } from 'electron';

const ok = (channel: string) => channel.startsWith('dictate:');

contextBridge.exposeInMainWorld('dictate', {
  send: (channel: string, ...args: unknown[]) => ok(channel) && ipcRenderer.send(channel, ...args),
  invoke: (channel: string, ...args: unknown[]) => (ok(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error('bad channel'))),
  on: (channel: string, cb: (...args: unknown[]) => void) => {
    if (!ok(channel)) return () => undefined;
    const l = (_e: unknown, ...args: unknown[]) => cb(...args);
    ipcRenderer.on(channel, l);
    return () => ipcRenderer.removeListener(channel, l);
  },
});

// MessagePorts cannot cross the context bridge; hand the port to the page with window.postMessage.
ipcRenderer.on('dictate:stt-port', (e) => {
  window.postMessage('dictate:stt-port', '*', e.ports);
});
