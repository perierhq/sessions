import { describe, expect, test } from "bun:test";
import { matchSections } from "./settings-search";
import { podmanSummaryLines, providerNeedsCredential } from "./podman-sandbox";

describe("This machine (container) card", () => {
  test("connects without a credential, like a Mac VM host", () => {
    expect(providerNeedsCredential("podman")).toBe(false);
    expect(providerNeedsCredential("tart")).toBe(false);
    expect(providerNeedsCredential("daytona")).toBe(true);
    expect(providerNeedsCredential("box")).toBe(true);
  });

  test("summarizes the image, limits and the last self-test", () => {
    const lines = podmanSummaryLines({
      imageTag: "localhost/opensession-sandbox:0123456789abcdef",
      memoryMb: 4096,
      pidsLimit: 4096,
      cpuLimited: true,
      cpu: 2,
      selfTestAt: "2026-10-22T10:00:00.000Z",
    });
    expect(lines[0]).toBe(
      "Image localhost/opensession-sandbox:0123456789abcdef",
    );
    expect(lines[1]).toBe("4 GB memory · 4096 processes");
    expect(lines[2]).toBe("2 CPUs");
    expect(lines.join("\n")).not.toContain("CPU not limited");
    expect(lines.at(-1)).toStartWith("Self-test passed ");
  });

  test("states the CPU limit a sandbox actually gets", () => {
    const base = {
      imageTag: "localhost/opensession-sandbox:0123456789abcdef",
      memoryMb: 4096,
      pidsLimit: 4096,
      cpuLimited: true,
    };
    expect(podmanSummaryLines({ ...base, cpu: 1 })[2]).toBe("1 CPU");
    expect(podmanSummaryLines({ ...base, cpu: 0.5 })[2]).toBe("0.5 CPUs");
    expect(podmanSummaryLines(base)[2]).toBe("CPU not limited on this host");
  });

  test("says when the host cannot limit CPU", () => {
    const lines = podmanSummaryLines({
      imageTag: "localhost/opensession-sandbox:0123456789abcdef",
      memoryMb: 1536,
      pidsLimit: 512,
      cpuLimited: false,
    });
    expect(lines).toContain("CPU not limited on this host");
    expect(lines[1]).toBe("1536 MB memory · 512 processes");
    expect(lines.join("\n")).not.toContain("Self-test");
  });

  test("counts the checks the last self-test passed", () => {
    const lines = podmanSummaryLines({
      imageTag: "localhost/opensession-sandbox:0123456789abcdef",
      memoryMb: 4096,
      pidsLimit: 4096,
      cpuLimited: true,
      cpu: 2,
      selfTestAt: "2026-10-22T10:00:00.000Z",
      selfTestProbes: 24,
    });
    expect(lines.at(-1)).toEndWith(" · 24 checks");
  });

  test("ends with the disk warnings", () => {
    const lines = podmanSummaryLines({
      imageTag: "localhost/opensession-sandbox:0123456789abcdef",
      memoryMb: 4096,
      pidsLimit: 4096,
      cpuLimited: true,
      selfTestAt: "2026-10-22T10:00:00.000Z",
      diskWarnings: ["Session a uses 11.0 GiB (stops at 20.0 GiB)"],
    });
    expect(lines.at(-1)).toBe("Session a uses 11.0 GiB (stops at 20.0 GiB)");
  });

  test("settings search finds the sandboxes page by container words", () => {
    const sections = [
      { key: "sandboxes", label: "Sandboxes", group: "Workspace" },
      { key: "deploys", label: "Deploys", group: "Workspace" },
    ];
    for (const query of ["container", "podman"])
      expect(matchSections(sections, query).map((hit) => hit.item.key)).toEqual(
        ["sandboxes"],
      );
  });
});
