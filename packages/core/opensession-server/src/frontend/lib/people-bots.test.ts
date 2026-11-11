// The bots roster (GET /api/people `bots`): Blob is built in, an old server
// that lists no bots keeps it, and a server that lists bots replaces it. A
// bot never joins the people roster.
import { expect, test } from "bun:test";

/** What the stubbed GET /api/people answers. */
interface PeopleBody {
  people?: { kind?: "person" | "bot"; name: string; fullName: string }[];
  bots?: { kind: "bot"; name: string; fullName: string; image?: string }[];
}
let body: PeopleBody = {};
Object.assign(globalThis, {
  window: {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  },
  fetch: async () => Response.json(body),
});

const { getBots, getPeople, refreshPeople } = await import("./people");

test("Blob is there before any server answers", () => {
  expect(getBots().map((b) => b.name)).toEqual(["Blob"]);
});

test("an old server without `bots` keeps the built-in Blob", async () => {
  body = { people: [{ name: "Ada", fullName: "Ada Lovelace" }] };
  await refreshPeople();
  expect(getBots()).toEqual([
    {
      kind: "bot",
      name: "Blob",
      fullName: "Blob",
      image: "/bot-icon/blob.png",
    },
  ]);
  expect(getPeople().map((p) => p.name)).toEqual(["Ada"]);
});

test("a server's own bots replace it, and stay out of the people", async () => {
  body = {
    people: [
      { name: "Ada", fullName: "Ada Lovelace" },
      { kind: "bot", name: "Robo", fullName: "Robo" },
    ],
    bots: [{ kind: "bot", name: "Blob", fullName: "Blob", image: "/b.png" }],
  };
  await refreshPeople();
  expect(getBots().map((b) => [b.name, b.kind])).toEqual([
    ["Robo", "bot"],
    ["Blob", "bot"],
  ]);
  expect(getPeople().map((p) => p.name)).toEqual(["Ada"]);
});
