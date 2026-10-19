// Native N-API modules ship prebuilds for every target below; smoke tests load them in Electron.
const buildArch = process.argv.includes('--arm64') ? 'arm64' : process.argv.includes('--x64') ? 'x64' : process.arch;
const signedMac = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
module.exports = {
  appId: 'org.dictate.Dictate',
  productName: 'Dictate',
  directories: { output: 'dist', buildResources: 'build' },
  files: ['out/**/*', 'defaults/**/*', 'LICENSE', 'package.json'],
  asar: true,
  asarUnpack: [
    'node_modules/**/*.{node,dll,dylib,so,so.*}',
    'node_modules/sherpa-onnx-*/**/*',
    'node_modules/uiohook-napi/prebuilds/**/*',
    'node_modules/uiohook-napi/build/Release/**/*',
    'node_modules/koffi/build/**/*',
  ],
  npmRebuild: false,
  // Builds always run with --publish never; the release job publishes after every native check passes.
  // This only tells the app (app-update.yml) and latest*.yml where releases live, for auto-update (C6).
  publish: { provider: 'github', owner: 'parsakhaz', repo: 'open-dictate', releaseType: 'release' },
  win: {
    target: ['nsis'],
    artifactName: 'Dictate-${version}-windows-${arch}-setup.${ext}',
    executableName: 'Dictate',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: false,
    createStartMenuShortcut: true,
    runAfterFinish: true,
    // Asks before deleting settings, history and models on uninstall.
    include: 'build/installer.nsh',
  },
  mac: {
    target: ['zip', 'dmg'],
    artifactName: 'Dictate-${version}-macos-${arch}.${ext}',
    category: 'public.app-category.productivity',
    identity: signedMac ? undefined : '-',
    hardenedRuntime: signedMac,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    extendInfo: { NSMicrophoneUsageDescription: 'Dictate uses your microphone to transcribe speech locally when you start dictation.' },
    notarize: Boolean(signedMac && ((process.env.APPLE_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD) || process.env.APPLE_API_KEY)),
  },
  linux: {
    target: ['AppImage', 'deb'],
    artifactName: 'Dictate-${version}-linux-' + buildArch + '.${ext}',
    executableName: 'dictate',
    category: 'Utility',
    maintainer: 'parsakhaz',
    syncDesktopName: true,
    desktop: { entry: { Name: 'Dictate', Comment: 'Local speech-to-text dictation', StartupWMClass: 'org.dictate.Dictate', Keywords: 'dictation;speech;transcription;' } },
  },
  deb: { depends: ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libasound2', 'libxkbcommon0', 'libxt6', 'libxrandr2', 'xdotool', 'x11-utils'] },
};
