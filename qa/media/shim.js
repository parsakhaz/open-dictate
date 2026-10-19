// Stands in for the preload bridge so the real pill and picker pages run inside a media scene.
// The driver calls window.__emit(channel, ...args) to play what main would send.
(() => {
  const handlers = new Map();
  window.dictate = {
    send: () => undefined,
    invoke: async () => null,
    on: (channel, cb) => {
      if (!handlers.has(channel)) handlers.set(channel, []);
      handlers.get(channel).push(cb);
      return () => handlers.set(channel, handlers.get(channel).filter((f) => f !== cb));
    },
  };
  window.__emit = (channel, ...args) => {
    for (const cb of handlers.get(channel) ?? []) cb(...args);
  };
  // The hint above the pill shows only in the first sessions; media shows the pill as people use it daily.
  try {
    localStorage.setItem('dictate.hintSessions', '99');
  } catch {}
})();
