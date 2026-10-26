/**
 * Bounded integer capacity overrides from the environment.
 *
 * Capacity knobs are read once at module load: they size long-lived pools and
 * gates, so a live process never resizes them mid-flight. An invalid value
 * keeps the built-in default instead of throwing — a typo in a drop-in must
 * not prevent boot.
 *
 * Mind which process reads a knob: the gateway loads ~/.opensession.env, but
 * the session-kernel and executor services deliberately do not. Their knobs
 * only take effect through a dedicated systemd drop-in (`Environment=`) on
 * that service, never through the application environment file.
 */
export function envCapacity(
  name: string,
  fallback: number,
  min: number,
  max: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.error(
      `[capacity] Ignoring ${name}=${raw}; expected an integer between ${min} and ${max}`,
    );
    return fallback;
  }
  return value;
}
