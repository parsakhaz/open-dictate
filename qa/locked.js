const k = require('../node_modules/koffi');
const u = k.load('user32.dll');
const F = u.func('__stdcall', 'GetForegroundWindow', 'intptr', []);
const P = u.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['intptr', k.out(k.pointer('uint32'))]);
const pid = [0]; P(F(), pid);
const name = require('child_process').execSync(`tasklist /FI "PID eq ${pid[0]}" /FO CSV /NH`).toString().split(',')[0].replace(/"/g, '');
console.log(name === 'LockApp.exe' ? 'locked' : `unlocked (${name})`);
