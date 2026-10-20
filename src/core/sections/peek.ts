// Settings → Agents → Peek (lane L5): the https hosts a peek may show besides localhost and local files. Only the
// person adds hosts here; agents never can. Pure.
import { obj, strings } from './fields';

export interface PeekSettings {
  /** Host names, lower case, e.g. "rungrain.com". */
  hosts: string[];
}

export const DEFAULT_PEEK: PeekSettings = { hosts: ['rungrain.com'] };

const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function parsePeek(x: unknown, d: PeekSettings = DEFAULT_PEEK): PeekSettings {
  const a = obj(x);
  const hosts = Array.isArray(a.hosts) ? a.hosts.map((h) => (typeof h === 'string' ? h.toLowerCase() : h)) : a.hosts;
  return { hosts: strings(hosts, d.hosts, 50, (h) => HOST.test(h)) };
}
