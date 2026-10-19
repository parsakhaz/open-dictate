export type DesktopSession = 'win32' | 'macos' | 'x11' | 'wayland' | 'headless' | 'unsupported';

/** DISPLAY under Wayland only exposes XWayland clients; it does not grant access to native apps. */
export function desktopSession(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): DesktopSession {
  if (platform === 'win32') return 'win32';
  if (platform === 'darwin') return 'macos';
  if (platform !== 'linux') return 'unsupported';
  if (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE?.toLowerCase() === 'wayland') return 'wayland';
  return env.DISPLAY ? 'x11' : 'headless';
}
