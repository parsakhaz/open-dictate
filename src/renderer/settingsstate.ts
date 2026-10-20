// What main sends the Settings window: the whole state its pages draw from.
import type { GainSpec } from '../core/agc';
import type { MicDevice } from '../core/mics';
import type { CleanupChain, Settings } from '../core/types';

export interface State {
  settings: Settings;
  labels: { hotkey: string; hotkeys: string[]; toggle: string; picker: string };
  devices: MicDevice[];
  mic: MicDevice | null;
  defaultMicLabel: string;
  gain: GainSpec;
  micBluetooth: boolean;
  stt: 'ready' | 'error' | 'loading';
  sttError: string;
  servers: { gemma: string; emberon: string };
  effectiveChain: CleanupChain;
  onBattery: boolean;
  missing: string[];
  history: { count: number; samples: number; median: number | null };
  logFile: string;
  version: string;
  platform: { platform: string; displayServer: string; globalHotkeys: boolean; canSwallowKeys: boolean; automaticPaste: boolean; accessibilityRequired: boolean; accessibilityGranted: boolean; reason?: string };
  microphonePermission: string;
  setup: { phase: string; kind?: string; file?: string; received?: number; total?: number; message?: string; overallReceived?: number; overallTotal?: number; bytesPerSecond?: number; etaSeconds?: number; step?: number; steps?: number };
  speechInstalled: boolean;
  essentialsReady: boolean;
  gemmaInstalled: boolean;
  sizes: { essentials: number; gemma: number };
  hardwareRunning: boolean;
  hardwareError: string;
  dataDir: string;
  update: { status: 'off' | 'disabled' | 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error'; mode: 'install' | 'notify' | 'off'; version?: string; url?: string; percent?: number; message?: string; checkedAt?: string };
  shortcutRegistered: boolean;
  shortcutRequested: boolean;
  startupError: string;
  recording: boolean;
  automation: boolean;
  agents: AgentsState | null;
  /** Each surface feature's own part (main's FeatureHost.state), for its section of Settings → Agents. */
  surfaces: Record<string, unknown>;
}

export interface AgentsState {
  channel: boolean;
  pane: { installed: boolean; attached: boolean };
  registration: { agent: 'claude' | 'codex' | 'cursor'; found: boolean; registered: boolean; ownedByDictate: boolean; handWritten: boolean; error?: string }[];
  instructions: { agent: 'claude' | 'codex'; file: string; found: boolean; state: 'absent' | 'current' | 'outdated'; error?: string }[];
  registrationAllowed: boolean;
  snippets: { agent: string; file: string; text: string; note?: string }[];
  sessions: { id: string; client: string; inPane: boolean; connectedAt: number }[];
  grants: { sessionId: string; source: string; client: string; grantedAt: number; expiresAt: number }[];
  accessLog: { at: string; source: string; client: string; query: string; hours: number; limit: number; includeRaw: boolean; outcome: string; count: number }[];
}
