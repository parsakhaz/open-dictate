// libuiohook does not expose Windows' dwExtraInfo marker. Ignore the short tail of our own synthesized
// key events so a Command/Ctrl dictation binding cannot start a new recording during its paste.
let until = 0;
export function silenceGeneratedInput(ms = 100): void { until = performance.now() + ms; }
export function generatedInputActive(): boolean { return performance.now() < until; }
