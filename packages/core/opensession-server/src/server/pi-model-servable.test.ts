// Whether this instance can serve a model: the run-start fallback and the
// automatic-notice routing ask the same question the Pi runner refuses on.
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piModelUnservableReason } from "./pi-model-routing";

const dir = await mkdtemp(join(tmpdir(), "pi-model-servable-"));
const prior = process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG;
process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = join(dir, "providers.json");
afterAll(async () => {
  if (prior === undefined)
    delete process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG;
  else process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = prior;
  await rm(dir, { recursive: true, force: true });
});

test("a provider without credentials can't serve its models", async () => {
  expect(piModelUnservableReason("pi/acme-gateway/fast")).toBe(
    'The Pi engine has no credentials for provider "acme-gateway" (got "pi/acme-gateway/fast"). Configure that model provider first.',
  );
  await writeFile(
    process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG!,
    JSON.stringify({
      providers: {
        "acme-gateway": {
          apiKey: "k",
          baseURL: "https://gateway.example.test/v1",
          api: "openai-completions",
        },
      },
    }),
  );
  expect(piModelUnservableReason("pi/acme-gateway/fast")).toBeNull();
});

test("the built-in providers bring their own accounts", () => {
  expect(piModelUnservableReason("pi/anthropic/claude-opus-5")).toBeNull();
  expect(piModelUnservableReason("pi/openai/gpt-6.1-sol")).toBeNull();
});

test("an id that is not a Pi model can't be served", () => {
  expect(piModelUnservableReason("pi/")).toContain("Not a pi model id");
});
