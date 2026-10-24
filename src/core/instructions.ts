// A few lines of guidance Dictate keeps in the agents' user-level instruction files (~/.claude/CLAUDE.md,
// ~/.codex/AGENTS.md), between its own markers. Only those lines are ever written or removed: every other byte,
// the line endings and any byte order mark stay as they were. Pure: no fs, no Electron.
import { ASKING_RULES } from './agenttools';
import type { Edit } from './registration';

export const BLOCK_BEGIN = '<!-- dictate:begin (managed by Dictate; edits are replaced) -->';
export const BLOCK_END = '<!-- dictate:end -->';
/** Matches the begin marker whatever its note says, so a reworded marker is still found and replaced. */
const BEGIN_PREFIX = '<!-- dictate:begin';

/** The full examples live in the dictate MCP's tool descriptions; this only points agents at them. */
const LINES = [
  '## Dictate',
  "Dictate is this person's local dictation app. When you truly need them, use the dictate MCP's `notify` (urgency `needs_you`) or `ask`. If the dictate tools aren't available, ignore this.",
  ...ASKING_RULES.map((rule) => `- ${rule}`),
  '- Use `approve` for a plan, `lineup` to have them pick among options you made (mockups, images, short texts), and `peek` to show a local page they can point at and talk about.',
  '- A card may wait while they are busy, paused or snoozed. `held` or `snoozed` is not an answer: carry on and check its `card_id` later with `card_status`. A `notify` can be answered by voice: `card_status` then says `answered`, with their words.',
  "The person is juggling many tasks and has lost the thread. In plain words, say what this work is for (the outcome, not the file), what just happened, and what you need from them. If you need a decision, give the options and what each one means. Don't repeat where you are: Dictate adds that.",
];

export function renderBlock(): string[] {
  return [BLOCK_BEGIN, ...LINES, BLOCK_END];
}

const BOM = String.fromCharCode(0xfeff);
const bare = (line: string) => line.replace(/\r$/, '');
const blank = (line: string | undefined) => line === '' || line === '\r';

/** Lines [start, end] of the block, undefined when there is none; throws when the markers don't pair up. */
function findBlock(lines: string[]): { start: number; end: number } | undefined {
  const begins = lines.flatMap((l, i) => (bare(l).trim().startsWith(BEGIN_PREFIX) ? [i] : []));
  const ends = lines.flatMap((l, i) => (bare(l).trim() === BLOCK_END ? [i] : []));
  if (!begins.length && !ends.length) return undefined;
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) throw new Error("has Dictate's markers unpaired or out of order");
  return { start: begins[0], end: ends[0] };
}

/** Whether a file holds the block, and whether it is the one this version writes. Throws on unpaired markers. */
export function instructionsState(text: string | undefined): 'absent' | 'current' | 'outdated' {
  const lines = (text ?? '').split('\n');
  const at = findBlock(lines);
  if (!at) return 'absent';
  const same = lines.slice(at.start, at.end + 1).map(bare).join('\n') === renderBlock().join('\n');
  return same ? 'current' : 'outdated';
}

/** Adds, refreshes or removes the block. Appended at the end when new; replaced where it stands otherwise. */
export function editInstructions(text: string | undefined, enabled: boolean): Edit {
  const current = text ?? '';
  // A byte order mark stays where it is, outside the edit; none is ever added.
  const bom = current.startsWith(BOM) ? BOM : '';
  const body = current.slice(bom.length);
  const lines = body.split('\n');
  let at: ReturnType<typeof findBlock>;
  try {
    at = findBlock(lines);
  } catch (err) {
    return { kind: 'skip', reason: `${(err as Error).message}; left it unchanged` };
  }
  const crlf = body.includes('\r\n');
  const eol = crlf ? '\r\n' : '\n';
  let next: string;
  if (enabled && at) {
    const block = renderBlock().map((l) => (crlf ? `${l}\r` : l));
    // A block that ends the file without a line break keeps ending it that way.
    if (at.end === lines.length - 1) block[block.length - 1] = bare(block[block.length - 1]);
    lines.splice(at.start, at.end - at.start + 1, ...block);
    next = lines.join('\n');
  } else if (enabled) {
    const added = renderBlock().join(eol);
    // A file without a final line break gets none after the block either, so removal can give it back as it was.
    next = !body ? `${added}\n` : body.endsWith('\n') ? `${body}${eol}${added}${eol}` : `${body}${eol}${eol}${added}`;
  } else if (at) {
    const s = at.start;
    lines.splice(s, at.end - s + 1);
    // Take back the blank line that set the block apart: the one before it at the end, a doubled one elsewhere.
    if (s === lines.length) {
      // The block ended the file without a line break: so did the text before it.
      if (s > 0 && blank(lines[s - 1])) {
        lines.splice(s - 1, 1);
        if (lines.length) lines[lines.length - 1] = bare(lines[lines.length - 1]);
      } else lines.push('');
    } else if (s === lines.length - 1 && lines[s] === '') {
      if (s > 0 && blank(lines[s - 1])) lines.splice(s - 1, 1);
    } else if (s < lines.length - 1 && blank(lines[s]) && (s === 0 || blank(lines[s - 1]))) lines.splice(s, 1);
    next = lines.join('\n');
  } else next = body;
  next = bom + next;
  if (next === current) return { kind: 'unchanged' };
  return { kind: 'write', text: next, action: !enabled ? 'removed' : at ? 'updated' : 'added' };
}
