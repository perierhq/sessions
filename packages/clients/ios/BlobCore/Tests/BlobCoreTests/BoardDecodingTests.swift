import BlobCore
import Foundation
import Testing

/// The designed boards the app bundles for `BLOB_DEMO_BOARD`, read from
/// the app's sources so the tests cover exactly what ships.
enum DemoBoards {
    static func url(_ name: String) -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // BlobCoreTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // BlobCore
            .deletingLastPathComponent() // ios
            .appendingPathComponent("Blob/Board/blob-demo-\(name).json")
    }

    static func load(_ name: String) throws -> BoardSnapshot {
        try JSONDecoder().decode(BoardSnapshot.self, from: Data(contentsOf: url(name)))
    }
}

func decodeBoard(_ json: String) throws -> BoardSnapshot {
    try JSONDecoder().decode(BoardSnapshot.self, from: Data(json.utf8))
}

struct BoardDecodingTests {
    @Test func `a board with elements and fields the app doesn't know`() throws {
        let board = try decodeBoard("""
        {"schema": 1, "revision": 7, "latestRevision": 9, "updatedAt": 1700000000000, "somethingNew": true,
         "elements": [
           {"id": "f", "type": "frame", "x": 0, "y": 0, "w": 300, "h": 200, "title": "Why", "glow": 3},
           {"id": "t", "type": "text", "role": "title", "x": 10, "y": 20, "w": 200, "text": "Hello", "sub": "there"},
           {"id": "c", "type": "text", "role": "title", "ref": "pr:acme#12", "x": 10, "y": 60, "w": 200, "h": 58},
           {"id": "s", "type": "shape", "kind": "ellipse", "x": 0, "y": 50, "w": 240, "h": 80, "z": 2, "style": {"stroke": "ink", "fill": "plaid"}},
           {"id": "a", "type": "arrow", "start": {"id": "t", "side": [0.2, 1]}, "end": {"x": 40, "y": 300}, "bend": 3},
           {"id": "k", "type": "stroke", "x": 5, "y": 5, "w": 10, "h": 10, "points": [[0, 0], [10, 10]]},
           {"id": "n", "type": "note", "anchor": {"id": "c", "side": "right", "dx": 4}, "text": "only you", "leader": true, "style": {"color": "tangerine"}},
           {"id": "hologram", "type": "hologram", "x": 0, "y": 0},
           {"id": "bad id!", "type": "frame", "x": 0, "y": 0, "w": 1, "h": 1},
           {"id": "t", "type": "frame", "x": 0, "y": 0, "w": 1, "h": 1},
           {"id": "huge", "type": "shape", "kind": "rect", "x": 0, "y": 0, "w": 99999, "h": 1},
           {"id": "img", "type": "image", "x": 0, "y": 0, "w": 10, "h": 10, "src": "https://evil.example.test/x.png"},
           {"id": "img2", "type": "image", "x": 0, "y": 0, "w": 10, "h": 10, "src": "/media?path=/tmp/shot.png", "fit": "cover"},
           "not an element", null, 4
         ],
         "refs": {
           "pr:acme#12": {"ok": true, "kind": "pr", "title": "#12 Fix it", "status": "blocked", "statusTone": "red", "url": "https://example.test/pr/12", "fields": {"number": "12"}},
           "pr:acme#13": {"ok": false, "reason": "not-found"}
         },
         "text": "Why"}
        """)
        #expect(board.revision == 7)
        #expect(board.latestRevision == 9)
        #expect(board.elements.map(\.id) == ["f", "t", "c", "s", "a", "k", "n", "img2"])
        let shape = try #require(board.elements.first { $0.id == "s" })
        #expect(shape.z == 2)
        #expect(shape.style == BoardStyle(stroke: .ink))
        let arrow = try #require(board.elements.first { $0.id == "a" })
        #expect(arrow.content == .arrow(start: .element(id: "t", side: .fraction(0.2, 1)), end: .point(BoardPoint(40, 300)), bend: 0.5, label: nil))
        let note = try #require(board.elements.first { $0.id == "n" })
        #expect(note.style == .none, "notes are ink: their style is ignored")
        #expect(note.content == .note(anchor: BoardNoteAnchor(id: "c", side: .right, dx: 4), text: "only you", leader: BoardLeader()))
        #expect(board.ref("pr:acme#12")?.statusTone == .red)
        #expect(board.ref("pr:acme#12")?.fields["number"] == "12")
        #expect(board.ref("pr:acme#13")?.ok == false)
        #expect(board.ref("pr:acme#99") == .missing, "a ref the server didn't resolve reads as not found")
    }

    @Test func `an empty or odd answer is an empty board`() throws {
        let empty = try decodeBoard("{}")
        let odd = try decodeBoard(#"{"elements": "soon", "revision": "x"}"#)
        let list = try decodeBoard("[]")
        #expect(empty.isEmpty)
        #expect(odd.revision == 0 && odd.isEmpty)
        #expect(list.isEmpty)
    }

    @Test func `live fields fill from the ref`() {
        let ref = BoardRefInfo(ok: true, title: "search-service 1.19.0", status: "merged", fields: ["number": "533"])
        #expect(BoardLiveText.fill("Ship {ref.title}", ref) == "Ship search-service 1.19.0")
        #expect(BoardLiveText.fill("#{ref.number} is {ref.status}", ref) == "#533 is merged")
        #expect(BoardLiveText.fill("Ship {ref.title}", .missing) == "Ship")
        #expect(BoardLiveText.fill("{ref.title", ref) == "{ref.title")
        #expect(BoardLiveText.fill("plain", nil) == "plain")
    }

    @Test(arguments: ["release", "morning"])
    func `the designed boards decode whole`(name: String) throws {
        let board = try DemoBoards.load(name)
        let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: DemoBoards.url(name))) as? [String: Any]
        let count = (raw?["elements"] as? [Any])?.count
        #expect(board.elements.count == count, "every element the server accepted reads")
        #expect(!board.touched.isEmpty)
        #expect(board.refs.values.allSatisfy { $0.ok })
    }

    @Test func `the palette in light and dark`() {
        #expect(BoardToken.ink.rgba(dark: false).rgb == 0x1A1A1A)
        #expect(BoardToken.ink.rgba(dark: true).rgb == 0xE9E9E9)
        #expect(BoardToken.tangerine.rgba(dark: false).rgb == 0xD3571C)
        #expect(BoardToken.quiet.rgba(dark: false).alpha == 0.05)
        #expect(BoardToken.quiet.rgba(dark: true).alpha == 0.07)
    }
}

struct BoardSourcesTests {
    @Test(arguments: [
        ("/media?path=/tmp/shot.png", true),
        ("/media?path=%2Ftmp%2Fshot.png&v=3", true),
        ("/media?path=/tmp/../etc/passwd", false),
        ("/media?path=relative.png", false),
        ("/media?path=/a&x=1", false),
        ("/api/plain/attachments/att_1", true),
        ("/api/support/conversations/c1/attachments/a1", true),
        ("/gh-asset/0123abcd-0123-4567-89ab-0123456789ab?repo=acme", true),
        ("https://example.test/x.png", false),
        ("//example.test/x.png", false),
        ("/api/plain/attachments/att_1/../../secrets", false),
    ])
    func `board images only from this server's media routes`(src: String, allowed: Bool) {
        #expect(BoardImageSource.isAllowed(src) == allowed)
    }

    @Test func `a reply's canvas fence names the revision`() {
        let reply = """
        ```say
        Billing stopped CI.
        ```

        ```canvas
        revision: 43
        Why the release is stuck
        ```
        """
        #expect(CanvasFence.revision(in: reply) == 43)
        #expect(CanvasFence.removing(from: reply) == "```say\nBilling stopped CI.\n```")
    }

    @Test func `an open or malformed canvas fence names nothing`() {
        #expect(CanvasFence.revision(in: "```canvas\nrevision: 43") == nil)
        #expect(CanvasFence.removing(from: "Hi.\n\n```canvas\nrevision: 4") == "Hi.")
        #expect(CanvasFence.revision(in: "```canvas\nrevision: zero\n```") == nil)
        #expect(CanvasFence.revision(in: "```canvas\nrevision: 0\n```") == nil)
        #expect(CanvasFence.revision(in: "```json\nrevision: 3\n```") == nil)
        #expect(CanvasFence.revision(in: "No board here.") == nil)
        #expect(CanvasFence.removing(from: "No board here.") == "No board here.")
    }

    @Test func `a longer fence holds a shorter one inside`() {
        let reply = "````canvas\nrevision: 5\n```\nnot closed yet\n````\nAfter."
        #expect(CanvasFence.revision(in: reply) == 5)
        #expect(CanvasFence.removing(from: reply) == "After.")
    }
}
