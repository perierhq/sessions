import BlobCore
import Testing

/// The glossary pass: conservative on purpose, a wrong fix is worse than a
/// missed one.
struct GlossaryTests {
    let glossary = ["BetterBahn", "Pat", "Mike", "PR", "PRs", "Blob", "Max", "Kit", "frontend", "web-app", "merge", "acme"]

    /// A stand-in for the system spell checker.
    static let dictionary: Set<String> = [
        "mac", "git", "butter", "band", "better", "close", "peers", "tea", "have", "pet", "hair", "mice", "front", "end",
    ]

    func correct(_ text: String, glossary: [String]? = nil) -> BlobGlossaryCorrector.Correction {
        BlobGlossaryCorrector.correct(text, glossary: glossary ?? self.glossary) {
            Self.dictionary.contains($0.lowercased())
        }
    }

    @Test(arguments: [
        ("Ask Butter Band about the deploy", "Ask BetterBahn about the deploy"),
        ("How is Better Bahn doing?", "How is BetterBahn doing?"),
        ("Is Butter Band's deploy done", "Is BetterBahn's deploy done"),
        ("any open piers on acme", "any open PRs on acme"),
        ("look at piers #12 and #13", "look at PRs #12 and #13"),
        ("the piers were merged", "the PRs were merged"),
        ("can you have mice check it", "can you have Mike check it"),
    ])
    func `fixes a near miss`(heard: String, meant: String) {
        let fixed = correct(heard)
        #expect(fixed.text == meant)
        #expect(fixed.fixes == 1)
    }

    @Test(arguments: [
        "Is the Mac build green?",
        "Did Git push it?",
        "Ask the close peers first",
        "Shall we have tea.",
        "have pet hair everywhere",
        "can you have pet check it",
        "Open https://example.test/Butter-Band now",
        "Run `Butter Band` in the shell",
        "Write to pat@example.test today",
        "Is the Front End fine?",
        "Meet me at Pier 39",
        "Status of BetterBahn and Blob",
    ])
    func `leaves the rest alone`(text: String) {
        let fixed = correct(text)
        #expect(fixed.text == text)
        #expect(fixed.fixes == 0)
    }

    @Test func `two terms as close change nothing`() {
        let fixed = correct("Ask Patty about it", glossary: ["Patti", "Pattu"])
        #expect(fixed.text == "Ask Patty about it")
    }

    @Test func `no glossary changes nothing`() {
        #expect(correct("open piers", glossary: []) == .init(text: "open piers", fixes: 0))
    }

    @Test func `a word the language has never becomes a name`() {
        // "Butter" alone is a word, so it stays even next to BetterBahn.
        #expect(correct("Pass the Butter please").text == "Pass the Butter please")
    }

    @Test func `sound key and spelling distance`() {
        #expect(BlobGlossaryCorrector.phonetic("betterbahn") == BlobGlossaryCorrector.phonetic("butterbahn"))
        #expect(BlobGlossaryCorrector.distance("butterband", "betterbahn") == 3)
        #expect(BlobGlossaryCorrector.allowedEdits(2) == 0)
        #expect(BlobGlossaryCorrector.allowedEdits(5) == 1)
        #expect(BlobGlossaryCorrector.allowedEdits(10) == 3)
    }
}
