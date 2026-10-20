// A stand-in for Pane's runpane CLI over a throwaway Pane folder (PANE_DIR), for L3's journeys and tests: it keeps
// Sessions, tabs and what was sent to them in <PANE_DIR>/fake-pane.json, and logs every call there. Never real Pane.
//   install(paneDir, { node }) writes <paneDir>/bin/runpane(.cmd) running this script with `node` (an Electron or Node).
// State: { panes: [{ id, name, panels: [{ id, title, agentType }] }], sessions: [Session], panels: { [id]: { running,
// draft, startsOnResume } }, sent: [{ panel, text, asFilePointer }], calls: [[...args]], fail: { "<verb>": message } }.
const fs = require('node:fs');
const path = require('node:path');

function install(paneDir, { node = process.execPath, state = {} } = {}) {
  const bin = path.join(paneDir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const script = __filename;
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'runpane.cmd'), `@echo off\r\n"${node}" "${script}" %*\r\n`);
  else {
    fs.writeFileSync(path.join(bin, 'runpane'), `#!/bin/sh\nexec "${node}" "${script}" "$@"\n`);
    fs.chmodSync(path.join(bin, 'runpane'), 0o755);
  }
  write(paneDir, { panes: [], sessions: [], panels: {}, sent: [], calls: [], fail: {}, ...state });
}

const file = (paneDir) => path.join(paneDir, 'fake-pane.json');
const read = (paneDir) => JSON.parse(fs.readFileSync(file(paneDir), 'utf8'));
function write(paneDir, s) {
  const tmp = `${file(paneDir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, file(paneDir));
}

function main() {
  const paneDir = process.env.PANE_DIR;
  const args = process.argv.slice(2).filter((a) => a !== '--json' && a !== '--yes');
  if (args[0] === 'watch') return setInterval(() => undefined, 60_000);
  const s = read(paneDir);
  s.calls.push(args);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const verb = `${args[0]} ${args[1]}`;
  const out = (o) => {
    write(paneDir, s);
    process.stdout.write(`${JSON.stringify(o)}\n`);
  };
  const fail = (message, code = 'ERR_FAKE') => {
    write(paneDir, s);
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
    process.exitCode = 1;
  };
  if (s.fail[verb]) return fail(s.fail[verb]);
  const panel = (id) => s.panels[id];
  switch (verb) {
    case 'panes list':
      return out({ ok: true, panes: s.panes.map(({ id, name }) => ({ id, name })) });
    case 'panels list': {
      const p = s.panes.find((x) => x.id === opt('--pane'));
      return p ? out({ ok: true, panels: p.panels }) : fail('no such pane');
    }
    case 'sessions list':
      return out({ ok: true, sessions: s.sessions });
    case 'sessions create': {
      const payload = JSON.parse(fs.readFileSync(opt('--from-json'), 'utf8'));
      if (!payload.name) return fail('name: missing', 'ERR_SESSION_PAYLOAD_INVALID');
      const id = `__orchestration_session_fake${s.sessions.length + 1}__`;
      const panelIds = Object.fromEntries(['claude', 'codex', 'cursor'].map((a) => [a, `__orchestration_panel_${id}_${a}`]));
      const session = { id, name: payload.name, archived: false, agent: payload.agent || 'claude', internalSessionId: `${id}terminal__`, panelIds, goal: payload.goal ?? '', profile: payload.profile ?? '' };
      s.sessions.push(session);
      s.panels[panelIds[session.agent]] = { running: false, draft: false, startsOnResume: true };
      return out({ ok: true, session });
    }
    case 'panels screen': {
      const p = panel(opt('--panel'));
      if (!p) return fail('no such panel');
      return out({ ok: true, panelId: opt('--panel'), text: p.draft ? '> half a thought' : '>', state: { initialized: p.running, running: p.running }, composer: { isPresent: p.running, hasUndeliveredText: !!p.draft } });
    }
    case 'panels resume': {
      const p = panel(opt('--panel'));
      if (!p) return fail('no such panel');
      const was = p.running;
      if (p.startsOnResume !== false) p.running = true;
      return out({ ok: true, results: [{ panelId: opt('--panel'), status: was ? 'already-running' : p.running ? 'resumed' : 'failed' }] });
    }
    case 'agents send': {
      const id = opt('--panel');
      const p = panel(id);
      if (!p) return fail('no such panel');
      if (!p.running) return out({ ok: true, delivered: false, blocked: 'not-running' });
      s.sent.push({ panel: id, text: opt('--text'), asFilePointer: args.includes('--as-file-pointer') });
      return out({ ok: true, delivered: true, delivery: 'taken' });
    }
    case 'links open':
      return out({ ok: true });
    default:
      return fail(`unknown command: ${args.join(' ')}`);
  }
}

if (require.main === module) main();

module.exports = { install, read, write };
