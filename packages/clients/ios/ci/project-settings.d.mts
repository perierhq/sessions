export const PROJECT_FILE: string;
export function scalarPaths(source: string): Map<string, string>;
export function targetSetting(
  source: string,
  target: string,
  setting: string,
  config?: string,
): string | undefined;
export function readTargetSetting(
  target: string,
  setting: string,
  config?: string,
): string | undefined;
