import { join } from 'node:path';

export const DESKTOP_RUNTIME_ICON_RELATIVE_PATH = join('dist', 'web', 'desktop-icon.png');
export const DESKTOP_BUILD_ICON_RELATIVE_PATH = join('build', 'desktop-icon.png');
export const DESKTOP_TRAY_TEMPLATE_ICON_RELATIVE_PATH = join('dist', 'web', 'desktop-tray-template.png');
export const DESKTOP_ICON_PUBLIC_PATH = '/desktop-icon.png';

export function getDesktopRuntimeIconPath(appPath: string) {
  return join(appPath, DESKTOP_RUNTIME_ICON_RELATIVE_PATH);
}

export function getDesktopTrayTemplateIconPath(appPath: string) {
  return join(appPath, DESKTOP_TRAY_TEMPLATE_ICON_RELATIVE_PATH);
}

export function getDesktopTrayIconPath(appPath: string, platform = process.platform) {
  return platform === 'darwin'
    ? getDesktopTrayTemplateIconPath(appPath)
    : getDesktopRuntimeIconPath(appPath);
}
