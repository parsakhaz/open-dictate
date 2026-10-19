// Spoken commands taken off the transcript by rule, not by the LLM, so they behave the same every time. Pure.

/** "press enter" as the very last words, with the commas or dashes before it and the punctuation after it; a whole word, never inside "compress". */
const PRESS_ENTER = /[\s,;:–—-]*(?<![\p{L}\p{N}])press enter[\s.!?]*$/iu;

/**
 * "press enter" at the very end of a dictation (B8): the text without it, and whether Enter should follow the
 * paste. Said alone, it stays as the text: there would be nothing to send.
 */
export function splitPressEnter(text: string): { text: string; enter: boolean } {
  const m = PRESS_ENTER.exec(text);
  if (!m) return { text, enter: false };
  const rest = text.slice(0, m.index).trimEnd();
  return rest ? { text: rest, enter: true } : { text, enter: false };
}
