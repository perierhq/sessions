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
      selfTestAt: "2026-10-22T10:00:00.000Z",
    });
    expect(lines[0]).toBe(
      "Image localhost/opensession-sandbox:0123456789abcdef",
    );
    expect(lines[1]).toBe("4 GB memory · 4096 processes");
    expect(lines.join("\n")).not.toContain("CPU not limited");
    expect(lines.at(-1)).toStartWith("Self-test passed ");
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
