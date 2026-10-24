import { describe, expect, test } from "bun:test";
import { effectiveSandboxDefault } from "./defaults";

describe("sandbox default precedence", () => {
  test("the workspace default applies when the project has none", () => {
    expect(effectiveSandboxDefault("none")).toBe("none");
    expect(effectiveSandboxDefault("daytona", null)).toBe("daytona");
    expect(effectiveSandboxDefault("daytona", undefined)).toBe("daytona");
  });

  test("a project's own default beats it, in either direction", () => {
    expect(effectiveSandboxDefault("none", "daytona")).toBe("daytona");
    expect(effectiveSandboxDefault("daytona", "none")).toBe("none");
  });
});
