// Choosing an entry in the history picker: paste it (cleaned or raw) through the same sink as dictation, or
// copy it only. No Electron imports, so the integration test drives it with a fake sink.
import type { HistoryStore } from '../core/history';
import type { Delivery, OutputSink } from './pipeline';

export interface PickRequest {
  id: string;
  /** Paste the raw transcript instead of the cleaned text. */
  raw: boolean;
  /** Copy to the clipboard, do not paste. */
  copyOnly: boolean;
}

export async function pickFromHistory(history: HistoryStore, req: PickRequest, sink: OutputSink): Promise<Delivery | undefined> {
  const e = history.get(req.id);
  if (!e) return undefined;
  const text = req.raw ? e.raw : e.text;
  return sink.deliver(text, req.copyOnly ? 'clipboard' : 'paste');
}
