export const KAIRN_VERSION = "0.1.2";

export type KairnBuildInfo = {
  version: string;
  target: string;
  channel: string;
  platformPackage?: string | undefined;
  launcherPackage?: string | undefined;
};

export function detectBuildTarget(platform = process.platform, arch = process.arch): string {
  return `${platform}-${arch}`;
}

export function getKairnBuildInfo(): KairnBuildInfo {
  return {
    version: KAIRN_VERSION,
    target: process.env.KAIRN_BUILD_TARGET || detectBuildTarget(),
    channel: process.env.KAIRN_INSTALL_CHANNEL || process.env.KAIRN_BUILD_CHANNEL || "source",
    platformPackage: process.env.KAIRN_PLATFORM_PACKAGE || undefined,
    launcherPackage: process.env.KAIRN_LAUNCHER_PACKAGE || undefined
  };
}

export function formatKairnVersionText(): string {
  const info = getKairnBuildInfo();
  return [
    info.version,
    `target: ${info.target}`,
    `channel: ${info.channel}`,
    info.platformPackage ? `platform package: ${info.platformPackage}` : "",
    info.launcherPackage ? `launcher package: ${info.launcherPackage}` : ""
  ].filter(Boolean).join("\n");
}
