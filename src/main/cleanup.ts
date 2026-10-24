// The cleanup servers: which ones run (the chain setting, battery mode), warm from start-up, unloaded after
// a long idle on battery and reloaded on the next hotkey press. A background check keeps them running.
import fs from 'node:fs';
import path from 'node:path';
import { type ChainDeps, type ChainStep, type CleanupModel, stepsFor } from '../core/chain';
import { EMBERON_GGUF, GEMMA_GGUF } from '../core/settings';
import { chatRequest } from '../core/templating';
import type { CleanupChain, Settings } from '../core/types';
import { LlamaServer, type Log, type ServerState } from '../engine/llama';

/** How often the background check looks at the servers. */
const HEAL_MS = 30_000;

export class Cleanup {
  readonly servers: Record<CleanupModel, LlamaServer>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  /** Stopped on purpose (battery idle, a download, quit): the background check leaves the servers alone until the next sync. */
  private parked = false;
  onBattery = false;
  /** Called on any server state change. */
  onChange: () => void = () => undefined;

  constructor(
    private settings: Settings,
    private readonly v3Template: string,
    private readonly log: Log,
    private readonly adopt?: (pid: number) => void,
  ) {
    this.servers = this.makeServers();
    setInterval(() => this.heal(), HEAL_MS).unref();
  }

  private makeServers(): Record<CleanupModel, LlamaServer> {
    const steps = () => stepsFor('gemma-emberon', this.v3Template, this.settings.vocabulary);
    const mk = (model: CleanupModel, gguf: string, i: number) => {
      const s = new LlamaServer(model, {
        exe: this.settings.llamaServer,
        gguf: path.join(this.settings.modelsDir, gguf),
        // The real system prompt, so the first dictation finds it cached.
        warmup: () => chatRequest(steps()[i].system, 'okay so this is a quick warm up sentence'),
        log: this.log,
        adopt: this.adopt,
      });
      s.onState = () => this.onChange();
      return s;
    };
    return { gemma: mk('gemma', GEMMA_GGUF, 0), emberon: mk('emberon', EMBERON_GGUF, 1) };
  }

  /** The chain in effect now: on battery, optionally Emberon only. */
  chain(): CleanupChain {
    const c = this.settings.cleanup;
    return this.onBattery && this.settings.batteryEmberonOnly && c !== 'off' ? 'emberon' : c;
  }

  steps(): ChainStep[] {
    return stepsFor(this.chain(), this.v3Template, this.settings.vocabulary);
  }

  private needed(): CleanupModel[] {
    return [...new Set(this.steps().map((s) => s.model))];
  }

  missingFiles(): string[] {
    if (!this.needed().length) return [];
    const out: string[] = [];
    if (!fs.existsSync(this.settings.llamaServer)) out.push(this.settings.llamaServer);
    for (const m of this.needed()) {
      const f = path.join(this.settings.modelsDir, m === 'gemma' ? GEMMA_GGUF : EMBERON_GGUF);
      if (!fs.existsSync(f)) out.push(f);
    }
    return out;
  }

  /** The hardware check times a chain the settings may not use yet: its steps, with its servers started. */
  async trial(chain: CleanupChain): Promise<ChainStep[]> {
    const steps = stepsFor(chain, this.v3Template, this.settings.vocabulary);
    for (const m of new Set(steps.map((s) => s.model))) {
      void this.servers[m].start().catch(() => undefined);
      // A cold load on a slow disk can take far longer than a dictation would wait.
      await this.servers[m].whenReady(90_000);
    }
    return steps;
  }

  private installed(m: CleanupModel): boolean {
    return fs.existsSync(this.settings.llamaServer) && fs.existsSync(path.join(this.settings.modelsDir, m === 'gemma' ? GEMMA_GGUF : EMBERON_GGUF));
  }

  /** Starts the servers the chain needs and stops the rest. */
  sync(): void {
    this.parked = false;
    const need = this.needed();
    for (const [m, s] of Object.entries(this.servers) as [CleanupModel, LlamaServer][]) {
      if (need.includes(m) && this.installed(m)) void s.start().catch(() => undefined);
      else if (s.state !== 'stopped') s.stop();
    }
    this.armIdle();
  }

  /**
   * The background check: a needed server that is not running starts once its files are there (after a swap or
   * a download), and one whose binary or model changed on disk restarts. Crashes restart on their own (LlamaServer).
   */
  heal(): void {
    if (this.parked) return;
    for (const m of this.needed()) {
      const s = this.servers[m];
      if (!this.installed(m)) continue;
      if (s.state === 'stopped') {
        this.log('warn', `${m}: not running; starting`);
        void s.start().catch(() => undefined);
      } else if (s.changed()) s.restart('llama-server or model changed on disk');
    }
  }

  /** Settings changed: paths or prompt changes need fresh servers; the chain only needs a sync. */
  update(next: Settings): void {
    const restart = next.llamaServer !== this.settings.llamaServer || next.modelsDir !== this.settings.modelsDir;
    this.settings = next;
    if (restart) {
      for (const s of Object.values(this.servers)) s.stop();
      Object.assign(this.servers, this.makeServers());
    }
    this.sync();
  }

  /** True when a needed server is not ready yet (the pill says "warming up"). */
  warming(): boolean {
    return this.needed().some((m) => this.servers[m].state !== 'ready');
  }

  states(): Record<CleanupModel, ServerState> {
    return { gemma: this.servers.gemma.state, emberon: this.servers.emberon.state };
  }

  deps(): ChainDeps {
    return {
      // A server still loading (battery reload, crash restart) gets a moment; one that cannot come up is skipped.
      ready: (m, maxMs) => this.servers[m].whenReady(Math.min(maxMs ?? Number.POSITIVE_INFINITY, this.servers[m].state === 'starting' ? 12_000 : 3000)),
      complete: (m, body, signal) => this.servers[m].complete(body, signal),
    };
  }

  /** A hotkey press or a dictation: reload if unloaded, and restart the battery idle countdown. */
  touch(): void {
    if (this.needed().some((m) => this.servers[m].state === 'stopped')) {
      this.log('info', 'loading cleanup models');
      this.sync();
    } else this.armIdle();
  }

  setBattery(on: boolean): void {
    if (on === this.onBattery) return;
    this.onBattery = on;
    this.log('info', on ? 'on battery' : 'on AC power');
    this.sync();
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    const min = this.settings.batteryUnloadMinutes;
    if (!this.onBattery || min <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (!this.onBattery) return;
      this.log('info', `idle ${min} min on battery: unloading cleanup models`);
      this.parked = true;
      for (const s of Object.values(this.servers)) s.stop();
    }, min * 60_000);
  }

  stopAll(): void {
    this.parked = true;
    clearTimeout(this.idleTimer);
    for (const s of Object.values(this.servers)) s.stop();
  }
}
