// Prints "locked" when the desktop is not usable for QA: the lock screen (LockApp in front, or LogonUI running
// on the secure desktop, where the foreground window belongs to no process), else "unlocked (<foreground>)".
const { execSync } = require('node:child_process');
const k = require('../node_modules/koffi');
const u = k.load('user32.dll');
const F = u.func('__stdcall', 'GetForegroundWindow', 'intptr', []);
const P = u.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['intptr', k.out(k.pointer('uint32'))]);
const pid = [0];
P(F(), pid);
const name = pid[0] ? execSync(`tasklist /FI "PID eq ${pid[0]}" /FO CSV /NH`).toString().split(',')[0].replace(/"/g, '') : '';
const logonUi = /LogonUI\.exe/i.test(execSync('tasklist /FI "IMAGENAME eq LogonUI.exe" /FO CSV /NH').toString());
console.log(name === 'LockApp.exe' || !pid[0] || logonUi ? 'locked' : `unlocked (${name})`);
