// Peek's rules: which pages it may show, where they may go, and what the agent's arguments become.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolInputError } from '../src/core/agenttools';
import { checkTarget, hostAllowed, inside, navigation, parsePeekArgs, shortUrl, urlAllowed } from '../src/core/tools/peek';

const cwd = path.resolve('/work/storefront');
const hosts = ['rungrain.com'];

describe('peek targets', () => {
  it('takes localhost and 127.0.0.1 on any port, over http or https', () => {
    for (const url of ['http://localhost:5173/pricing', 'https://localhost/', 'http://127.0.0.1:8080/a?b=1', 'http://[::1]:3000/', 'http://app.localhost:3000/']) {
      const t = checkTarget(url, { cwd, hosts });
      expect(t).toMatchObject({ kind: 'web', local: true });
    }
  });

  it('takes https on an allowed host and its subdomains, and nothing else remote', () => {
    expect(checkTarget('https://rungrain.com/doc/1', { cwd, hosts })).toMatchObject({ kind: 'web', local: false, host: 'rungrain.com' });
    expect(checkTarget('https://app.rungrain.com/doc/1', { cwd, hosts })).toMatchObject({ kind: 'web', host: 'app.rungrain.com' });
    expect(() => checkTarget('https://evil.com/', { cwd, hosts })).toThrow(/not on the person's peek list/);
    expect(() => checkTarget('https://notrungrain.com/', { cwd, hosts })).toThrow(ToolInputError);
    expect(() => checkTarget('http://rungrain.com/', { cwd, hosts })).toThrow(/https only/);
    expect(() => checkTarget('https://user:pw@rungrain.com/', { cwd, hosts })).toThrow(ToolInputError);
  });

  it('refuses file:// and other schemes', () => {
    expect(() => checkTarget('file:///C:/secrets.html', { cwd, hosts })).toThrow(/not a file:\/\/ URL/);
    expect(() => checkTarget('ftp://localhost/x.html', { cwd, hosts })).toThrow(ToolInputError);
    expect(() => checkTarget('javascript://localhost/%0aalert(1)', { cwd, hosts })).toThrow(ToolInputError);
  });

  it('takes an .html file inside the working folder, relative or absolute', () => {
    expect(checkTarget('reports/index.html', { cwd, hosts })).toEqual({ kind: 'file', file: path.join(cwd, 'reports', 'index.html'), root: cwd });
    expect(checkTarget(path.join(cwd, 'a.htm'), { cwd, hosts })).toMatchObject({ kind: 'file' });
  });

  it('refuses a file outside the folder, a non-HTML file, or no folder at all', () => {
    expect(() => checkTarget('../other/index.html', { cwd, hosts })).toThrow(/outside your working folder/);
    expect(() => checkTarget(path.resolve('/etc/passwd.html'), { cwd, hosts })).toThrow(/outside/);
    expect(() => checkTarget('notes.txt', { cwd, hosts })).toThrow(/\.html page/);
    expect(() => checkTarget('index.html', { cwd: '', hosts })).toThrow(/working folder/);
  });

  it('matches hosts exactly or as a parent, never by suffix alone', () => {
    expect(hostAllowed('rungrain.com', hosts)).toBe(true);
    expect(hostAllowed('A.RunGrain.com', hosts)).toBe(true);
    expect(hostAllowed('xrungrain.com', hosts)).toBe(false);
    expect(urlAllowed('data:text/html,hi', hosts)).toBe(false);
    expect(urlAllowed('not a url', hosts)).toBe(false);
  });

  it('knows inside from outside, without being fooled by a shared prefix', () => {
    expect(inside(cwd, path.join(cwd, 'a', 'b.html'))).toBe(true);
    expect(inside(cwd, cwd)).toBe(true);
    expect(inside(cwd, `${cwd}-evil${path.sep}x.html`)).toBe(false);
  });
});

describe('peek navigation', () => {
  it('moves freely within the origin', () => {
    expect(navigation('http://localhost:5173/a', 'http://localhost:5173/b#x')).toBe('go');
  });

  it('asks before another origin, even another port', () => {
    expect(navigation('http://localhost:5173/', 'https://checkout.stripe.com/pay')).toBe('ask');
    expect(navigation('http://localhost:5173/', 'http://localhost:5174/')).toBe('ask');
  });

  it('never goes to file:, data: or javascript:', () => {
    for (const to of ['file:///C:/x', 'data:text/html,x', 'javascript:alert(1)', 'chrome://settings']) expect(navigation('http://localhost/', to)).toBe('refuse');
  });
});

describe('peek arguments', () => {
  it('defaults to waiting 600 s and closing after the answer', () => {
    expect(parsePeekArgs({ title: 'Does Growth stand out?', target: 'http://localhost:5173' })).toMatchObject({ wait: true, keepOpen: false, timeoutS: 600, message: '', ask: '' });
  });

  it('caps the title and timeout, and says when it cut', () => {
    const a = parsePeekArgs({ title: 'x'.repeat(90), target: ' http://localhost ', timeout_s: 9999, wait: false, keep_open: true });
    expect(a.title.length).toBeLessThanOrEqual(60);
    expect(a).toMatchObject({ truncated: true, timeoutS: 600, wait: false, keepOpen: true, target: 'http://localhost' });
  });

  it('needs a title and a target', () => {
    expect(() => parsePeekArgs({ target: 'http://localhost' })).toThrow(ToolInputError);
    expect(() => parsePeekArgs({ title: 'Look' })).toThrow(/target/);
  });

  it('shows a short address', () => {
    expect(shortUrl('http://localhost:5173/pricing')).toBe('localhost:5173/pricing');
    expect(shortUrl('https://rungrain.com/')).toBe('rungrain.com');
    expect(shortUrl('dictate-peek://fabc/reports/index%20page.html')).toBe('index page.html');
  });
});
