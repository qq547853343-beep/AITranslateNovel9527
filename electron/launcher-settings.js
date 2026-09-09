export const LAUNCHER_SETTINGS_KEY = 'launcher';
export const LAUNCHER_MANAGEMENT_PORT = 7000;
export const DEFAULT_LAUNCHER_SETTINGS = Object.freeze({
  launcherPort: LAUNCHER_MANAGEMENT_PORT,
  servicePort: 6501,
  autoStartLauncher: true,
  autoStartService: true,
  startHidden: true,
  autoRestartService: false
});

export function normalizeLauncherSettings(input = {}) {
  const servicePort = Number(input.servicePort);
  return {
    launcherPort: LAUNCHER_MANAGEMENT_PORT,
    servicePort: Number.isInteger(servicePort) && servicePort >= 1 && servicePort <= 65535 && servicePort !== LAUNCHER_MANAGEMENT_PORT ? servicePort : 6501,
    autoStartLauncher: input.autoStartLauncher == null ? true : Boolean(input.autoStartLauncher),
    autoStartService: input.autoStartService == null ? true : Boolean(input.autoStartService),
    startHidden: input.startHidden == null ? true : Boolean(input.startHidden),
    autoRestartService: Boolean(input.autoRestartService),
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : null
  };
}

export class LauncherSettingsStore {
  constructor(repository) { this.repository = repository; }
  read() { return normalizeLauncherSettings(this.repository.get(LAUNCHER_SETTINGS_KEY, DEFAULT_LAUNCHER_SETTINGS)); }
  save(input) {
    const value = { ...normalizeLauncherSettings(input), launcherPort: LAUNCHER_MANAGEMENT_PORT, updatedAt: new Date().toISOString() };
    this.repository.set(LAUNCHER_SETTINGS_KEY, value);
    return value;
  }
}
