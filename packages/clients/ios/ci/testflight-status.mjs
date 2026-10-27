#!/usr/bin/env node
// Print what App Store Connect did with the latest iOS builds.
//
//   node testflight-status.mjs [bundle id] [count]
//
// Without a bundle id (or with an empty one) it reads the OS1 app target's
// PRODUCT_BUNDLE_IDENTIFIER from ../project.yml, the same id the release
// archive is signed with.
//
// The release workflow uploads without waiting for Apple's processing, so a
// green run only means the upload worked. Apple can still mark the build
// invalid afterwards (bad Info.plist keys, missing entitlements, App Intents
// metadata it refuses), and that verdict only shows up here and in email.
// Read-only: uses the same API key as the upload (ASC_KEY_ID /
// ASC_ISSUER_ID / ASC_PRIVATE_KEY).
import crypto from "node:crypto";
import fs from "node:fs";

const [bundleArg, countArg = "6"] = process.argv.slice(2);
const bundleId = bundleArg || appBundleId();
const count = Number(countArg) || 6;

const keyId = required("ASC_KEY_ID");
const issuer = required("ASC_ISSUER_ID");
const privateKey = required("ASC_PRIVATE_KEY");

function required(key) {
  const value = process.env[key];
  if (!value) {
    console.error(`::error::${key} is not set`);
    process.exit(1);
  }
  return value;
}

// The first PRODUCT_BUNDLE_IDENTIFIER inside the `OS1:` target block.
function appBundleId() {
  const path = new URL("../project.yml", import.meta.url);
  const lines = fs.readFileSync(path, "utf8").split("\n");
  const start = lines.findIndex((line) => /^  OS1:\s*$/.test(line));
  for (let i = start + 1; start >= 0 && i < lines.length; i++) {
    if (/^  \S/.test(lines[i])) break;
    const match = lines[i].match(/^\s+PRODUCT_BUNDLE_IDENTIFIER:\s*(\S+)/);
    if (match) return match[1];
  }
  console.error(
    "::error::No PRODUCT_BUNDLE_IDENTIFIER for the OS1 target in project.yml",
  );
  process.exit(1);
}

function token() {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const input = `${b64({ alg: "ES256", kid: keyId, typ: "JWT" })}.${b64({
    iss: issuer,
    iat: now,
    exp: now + 600,
    aud: "appstoreconnect-v1",
  })}`;
  const signature = crypto.sign("SHA256", Buffer.from(input), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${signature.toString("base64url")}`;
}

async function get(path, params = {}) {
  const url = new URL(`https://api.appstoreconnect.apple.com${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  const body = await response.text();
  if (!response.ok) {
    return { error: `${response.status} ${body.slice(0, 600)}` };
  }
  return JSON.parse(body);
}

const apps = await get("/v1/apps", { "filter[bundleId]": bundleId });
const app = apps.data?.[0];
if (!app) {
  console.error(`::error::No app for ${bundleId}: ${apps.error ?? "empty"}`);
  process.exit(1);
}

console.log(`== Builds (processing state) for ${bundleId}`);
const builds = await get("/v1/builds", {
  "filter[app]": app.id,
  sort: "-uploadedDate",
  limit: String(count),
});
if (builds.error) console.log(`builds: ${builds.error}`);
for (const build of builds.data ?? []) {
  const a = build.attributes;
  console.log(
    `${a.version}  ${a.processingState}  uploaded ${a.uploadedDate}  expired=${a.expired}`,
  );
}

// Build uploads carry Apple's validation errors for builds that never became
// a build at all, which is what an invalid binary looks like.
console.log(`\n== Build uploads (validation results)`);
const uploads = await get(`/v1/apps/${app.id}/buildUploads`, {
  limit: String(count),
  sort: "-uploadedDate",
});
if (uploads.error) {
  const retry = await get(`/v1/apps/${app.id}/buildUploads`, {
    limit: String(count),
  });
  if (retry.error) console.log(`buildUploads: ${uploads.error}`);
  else uploads.data = retry.data;
}
for (const upload of uploads.data ?? []) {
  const a = upload.attributes ?? {};
  console.log(
    `${a.cfBundleVersion ?? "?"}  ${JSON.stringify(a.state ?? a)}  created ${a.createdDate ?? "?"}`,
  );
}
