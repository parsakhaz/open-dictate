// The cleanup servers: which ones run (the chain setting, battery mode), warm from start-up, unloaded after
// a long idle on battery and reloaded on the next hotkey press.
import fs from 'node:fs';
import path from 'node:path';
import { type ChainDeps, type ChainStep, type CleanupModel, stepsFor } from '../core/chain';
import { EMBERON_GGUF, GEMMA_GGUF } from '../core/settings';
import { chatRequest } from '../core/templating';
import type { CleanupChain, Settings } from '../core/types';
import { LlamaServer, type Log, type ServerState } from '../engine/llama';

export class Cleanup {
  readonly servers: Record<CleanupModel, LlamaServer>;
  private idleTimer?: ReturnType<typeof setTimeout>;
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
    const out: string[] = [];
    if (!fs.existsSync(this.settings.llamaServer)) out.push(this.settings.llamaServer);
    for (const m of this.needed()) {
      const f = path.join(this.settings.modelsDir, m === 'gemma' ? GEMMA_GGUF : EMBERON_GGUF);
      if (!fs.existsSync(f)) out.push(f);
    }
    return out;
  }

  /** Starts the servers the chain needs and stops the rest. */
  sync(): void {
    const need = this.needed();
    for (const [m, s] of Object.entries(this.servers) as [CleanupModel, LlamaServer][]) {
      if (need.includes(m)) void s.start().catch(() => undefined);
      else if (s.state !== 'stopped') s.stop();
    }
    this.armIdle();
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
      ready: (m) => this.servers[m].whenReady(this.servers[m].state === 'starting' ? 12_000 : 3000),
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
      for (const s of Object.values(this.servers)) s.stop();
    }, min * 60_000);
  }

  stopAll(): void {
    clearTimeout(this.idleTimer);
    for (const s of Object.values(this.servers)) s.stop();
  }
}
