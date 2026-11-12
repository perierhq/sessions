import BlobCore
import Foundation
import Testing

/// Decoding the brief and items: tolerant of what the server adds or drops.
struct BriefDecodingTests {
    func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    @Test func `a full brief with fields the app doesn't know`() throws {
        let response = try decode(SupervisorBriefResponse.self, """
        {
          "state": "ready", "somethingNew": {"a": 1},
          "brief": {
            "day": "2026-11-12", "asOf": 1700000000000, "say": "Morning.", "seenAt": null,
            "mood": "sunny",
            "handled": [{"line": " Closed the flaky alert "}, {"line": ""}, {"line": null}, {}],
            "decisions": [
              {"item": {"id": "a", "title": "Merge it?", "options": ["Not now", null, " ", "Merge"],
                        "updatedAt": 1700000000123, "extra": true},
               "recommended": "Merge"},
              {"item": {"id": "no-title"}},
              {"recommended": "Yes"}
            ],
            "later": {"count": 3}
          },
          "newSince": {"itemIds": ["n1", "n2"]},
          "preparingSince": null, "refreshAt": 1700000600000
        }
        """)
        #expect(response.state == "ready")
        #expect(response.newSince == ["n1", "n2"])
        let brief = try #require(response.brief)
        #expect(brief.key == "2026-11-12@1700000000000")
        #expect(brief.handled == ["Closed the flaky alert"])
        #expect(brief.laterCount == 3)
        #expect(brief.decisions.count == 1)
        let item = brief.decisions[0].item
        #expect(item.options == ["Not now", "Merge"])
        #expect(item.revision == 1_700_000_000_123)
        #expect(item.kind == "fyi")
        #expect(item.state == "open")
        #expect(item.body == "")
        #expect(brief.decisions[0].recommended == "Merge")
    }

    @Test func `missing fields fall back`() throws {
        let empty = try decode(SupervisorBriefResponse.self, "{}")
        #expect(empty.state == "none")
        #expect(empty.brief == nil)
        #expect(empty.newSince.isEmpty)

        let odd = try decode(SupervisorBriefResponse.self, #"{"state": 7, "brief": "soon", "newSince": [1, 2]}"#)
        #expect(odd.state == "none")
        #expect(odd.brief == nil)
        #expect(odd.newSince.isEmpty)

        let bare = try decode(SupervisorBrief.self, "{}")
        #expect(bare.day == "" && bare.say == "" && bare.decisions.isEmpty && bare.laterCount == 0)
        let negative = try decode(SupervisorBrief.self, #"{"later": {"count": -2}}"#)
        #expect(negative.laterCount == 0)
    }

    @Test func `a revision is a whole, non-negative number`() throws {
        let explicit = try decode(SupervisorItem.self, #"{"id": "a", "title": "t", "revision": 5, "updatedAt": 9}"#)
        #expect(explicit.revision == 5)
        let fraction = try decode(SupervisorItem.self, #"{"id": "a", "title": "t", "revision": 1.5}"#)
        #expect(fraction.revision == nil)
        let negative = try decode(SupervisorItem.self, #"{"id": "a", "title": "t", "updatedAt": -1}"#)
        #expect(negative.revision == nil)
        #expect(negative.cardKey == "a@")
    }

    @Test func `the item list skips what it can't read`() throws {
        let list = try decode(SupervisorItemList.self, """
        {"items": [{"id": "a", "title": "One"}, {"id": "b"}, 42, {"title": "no id"}, {"id": "c", "title": "Two", "state": "answered"}]}
        """)
        #expect(list.items.map(\.id) == ["a", "c"])
        #expect(list.items[1].isOpen == false)
        #expect(try decode(SupervisorItemList.self, "{}").items.isEmpty)
    }

    @Test func `the act's steps and the body without the server's own lines`() throws {
        let item = try decode(SupervisorItem.self, """
        {"id": "a", "title": "t", "body": "Merge it.\\n\\nSteps:\\n1. Merge",
         "act": {"steps": ["Merge", null, "  "], "bodySuffix": "\\n\\nSteps:\\n1. Merge", "state": null}}
        """)
        let act = try #require(item.act)
        #expect(act.steps == ["Merge"])
        #expect(act.state == "proposed")
        #expect(item.shownBody == "Merge it.")

        let mismatched = SupervisorItem(
            id: "b", kind: "needs-you", title: "t", body: "Other body",
            act: .init(steps: ["Merge"], bodySuffix: "Steps:")
        )
        #expect(mismatched.shownBody == "Other body")
    }

    @Test(arguments: [
        (#"{"reopen": {"line": "This morning: 2 decisions waiting"}}"#, "This morning: 2 decisions waiting"),
        (#"{"reopen": "Today\u2019s brief"}"#, "Today\u{2019}s brief"),
        (#"{"reopen": {"line": "  "}}"#, nil),
        (#"{"reopen": {"line": 3}}"#, nil),
        (#"{"reopen": null}"#, nil),
        (#"{}"#, nil),
    ] as [(String, String?)])
    func `the reopen line, as an object or a string`(json: String, line: String?) throws {
        #expect(try decode(SupervisorBriefResponse.self, json).reopenLine == line)
    }
}
