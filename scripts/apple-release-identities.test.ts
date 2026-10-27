import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  readTargetSetting,
  targetSetting,
} from "../packages/clients/ios/ci/project-settings.mjs";

// The Apple release path takes its identities from project.yml,
// electron-builder.yml and repository variables (AGENTS.md "Release
// workflows"). Upstream's own account must not come back with a port.
const root = join(import.meta.dir, "..");
const RELEASE_FILES = [
  ".github/workflows/os1-ios-testflight.yml",
  ".github/workflows/os1-ios-testflight-status.yml",
  ".github/workflows/os1-mac-testflight.yml",
  ".github/workflows/os1-mac-release.yml",
  ".github/workflows/os1-chrome-release.yml",
  "packages/clients/ios/project.yml",
  "packages/clients/ios/ci/fetch-provisioning-profile.mjs",
  "packages/clients/ios/ci/project-settings.mjs",
  "packages/clients/ios/ci/testflight-status.mjs",
  "packages/clients/mac/electron-builder.yml",
  "packages/clients/mac/build/entitlements.mac.plist",
  "packages/clients/mac/build/entitlements.mac.applinks.plist",
  "packages/clients/mac/native/DictationHelper-Info.plist",
  "packages/clients/mac/native/KeychainHelper-Info.plist",
  "packages/clients/mac/native/VoiceAudioHelper-Info.plist",
];
// Upstream's Apple team id, bundle-id prefix, certificate holder, host and
// Chrome extension id.
const UPSTREAM_IDENTITIES = [
  /6GUXT43C8B/,
  /paoolggkbjkobjblpjgncolaaikcmboe/,
  /dev\.tella\b/,
  /Tella HQ/i,
  /\btella\.dev\b/,
];

describe("Apple release identities", () => {
  test("release workflows and signing files carry none of upstream's", () => {
    for (const file of RELEASE_FILES) {
      const source = readFileSync(join(root, file), "utf8");
      for (const pattern of UPSTREAM_IDENTITIES) {
        expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  test("no Apple team id is committed; workflows pass APPLE_TEAM_ID", () => {
    const project = readFileSync(
      join(root, "packages/clients/ios/project.yml"),
      "utf8",
    );
    for (const team of project.matchAll(/DEVELOPMENT_TEAM:\s*(\S+)/g)) {
      expect(team[1]).toBe("${APPLE_TEAM_ID}");
    }
    for (const name of [
      "os1-ios-testflight.yml",
      "os1-mac-testflight.yml",
      "os1-mac-release.yml",
    ]) {
      const source = readFileSync(
        join(root, ".github/workflows", name),
        "utf8",
      );
      expect(source).toContain("APPLE_TEAM_ID: ${{ vars.APPLE_TEAM_ID }}");
      expect(source, `${name} must not default the team`).not.toMatch(
        /vars\.APPLE_TEAM_ID\s*\|\|/,
      );
      expect(source, `${name} must not default the server`).not.toMatch(
        /vars\.OS1_SERVER_URL\s*\|\|/,
      );
    }
  });

  test("the signing targets resolve from project.yml", () => {
    const app = readTargetSetting("OS1", "PRODUCT_BUNDLE_IDENTIFIER");
    expect(app).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    expect(readTargetSetting("OS1Widgets", "PRODUCT_BUNDLE_IDENTIFIER")).toBe(
      `${app}.widgets`,
    );
    // Universal purchase: the native Mac target shares the iOS record.
    expect(readTargetSetting("OS1Mac", "PRODUCT_BUNDLE_IDENTIFIER")).toBe(app);
    for (const target of ["OS1", "OS1Widgets", "OS1Mac"]) {
      expect(
        readTargetSetting(target, "PROVISIONING_PROFILE_SPECIFIER", "Release"),
        target,
      ).toBeTruthy();
    }
    // The Electron shell is a different Mac app, so a different id.
    const builder = readFileSync(
      join(root, "packages/clients/mac/electron-builder.yml"),
      "utf8",
    );
    expect(builder).toMatch(new RegExp(`^appId: ${app}\\.shell$`, "m"));
    for (const helper of ["DictationHelper", "VoiceAudioHelper"]) {
      const plist = readFileSync(
        join(root, `packages/clients/mac/native/${helper}-Info.plist`),
        "utf8",
      );
      expect(plist, helper).toContain(`<string>${app}.shell.`);
    }
    // Live Activity pushes are addressed to the app's bundle id.
    const liveActivities = readFileSync(
      join(
        root,
        "packages/core/opensession-server/src/server/live-activities.ts",
      ),
      "utf8",
    );
    expect(liveActivities).toContain(
      `OPENSESSION_APNS_BUNDLE_ID?.trim() || "${app}"`,
    );
  });

  test("a config value wins over base; comments and list items are skipped", () => {
    const source = [
      "targets:",
      "  App:",
      "    sources:",
      "      - path: App",
      "        excludes:",
      "          - README.md",
      "    settings:",
      "      base:",
      "        # PRODUCT_BUNDLE_IDENTIFIER: wrong",
      "        PRODUCT_BUNDLE_IDENTIFIER: test.acme.app # trailing note",
      '        CODE_SIGN_STYLE: "Automatic"',
      "      configs:",
      "        Release:",
      "          CODE_SIGN_STYLE: Manual",
      "          PROVISIONING_PROFILE_SPECIFIER: Acme App Store",
      "  Other:",
      "    settings:",
      "      base:",
      "        PRODUCT_BUNDLE_IDENTIFIER: test.acme.other",
    ].join("\n");
    expect(targetSetting(source, "App", "PRODUCT_BUNDLE_IDENTIFIER")).toBe(
      "test.acme.app",
    );
    expect(targetSetting(source, "App", "CODE_SIGN_STYLE")).toBe("Automatic");
    expect(targetSetting(source, "App", "CODE_SIGN_STYLE", "Release")).toBe(
      "Manual",
    );
    expect(targetSetting(source, "App", "CODE_SIGN_STYLE", "Debug")).toBe(
      "Automatic",
    );
    expect(
      targetSetting(source, "App", "PROVISIONING_PROFILE_SPECIFIER", "Release"),
    ).toBe("Acme App Store");
    expect(
      targetSetting(source, "App", "PROVISIONING_PROFILE_SPECIFIER"),
    ).toBeUndefined();
    expect(targetSetting(source, "Other", "PRODUCT_BUNDLE_IDENTIFIER")).toBe(
      "test.acme.other",
    );
  });
});
