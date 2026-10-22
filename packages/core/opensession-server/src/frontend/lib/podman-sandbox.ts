/** The This machine (container) Sandbox card (Settings → Sandboxes). */

/** Providers connected without an account credential: a paired Runner (Mac
 *  VM) or this server itself. Mirrors the server's
 *  CREDENTIAL_FREE_SANDBOX_PROVIDERS. */
const CREDENTIAL_FREE_PROVIDERS = new Set(["tart", "podman"]);

export function providerNeedsCredential(provider: string): boolean {
  return !CREDENTIAL_FREE_PROVIDERS.has(provider);
}

/** What the server reports for a qualified This machine (container). */
export interface PodmanConnectionSummary {
  imageTag: string;
  memoryMb: number;
  pidsLimit: number;
  /** False when this host cannot apply a CPU limit. */
  cpuLimited: boolean;
  /** When the full isolation self-test last passed. */
  selfTestAt?: string;
}

function memory(mb: number): string {
  return mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`;
}

/** The card's detail lines, in display order. */
export function podmanSummaryLines(summary: PodmanConnectionSummary): string[] {
  return [
    `Image ${summary.imageTag}`,
    `${memory(summary.memoryMb)} memory · ${summary.pidsLimit} processes`,
    ...(summary.cpuLimited ? [] : ["CPU not limited on this host"]),
    ...(summary.selfTestAt && Date.parse(summary.selfTestAt) > 0
      ? [`Self-test passed ${new Date(summary.selfTestAt).toLocaleString()}`]
      : []),
  ];
}
