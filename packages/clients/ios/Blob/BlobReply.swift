import BlobCore
import Foundation

/// A supervisor reply split the way the server asks it to write one
/// (server/blob-surface.ts): a ```say fence first, the script Blob speaks,
/// then everything after it, which is shown (drawn with the block catalog)
/// and never read.
///
/// The script may open with a delivery hint in brackets (`[warm,
/// unhurried]`) and carry `{#id}` cues (`BlobCues`). `say` is what a person
/// reads (no hint, no cues), `spoken` what the voice gets (the hint kept,
/// since Fish's Drama 3 reads brackets as direction; no cues).
///
/// A reply without a say fence falls back to the older rule: the first
/// paragraph is what Blob says, the prose before the first blank line,
/// fenced block, heading, list or table. A reply that opens with any other
/// block has nothing to say: `say` is empty and the whole reply is `show`.
///
/// Pure and Foundation-only, so it is the one place to change the rule.
/// No test target compiles `Blob/` (OS1Tests hosts the Mac app), so check
/// changes with a scratch `swiftc` run against the examples below:
///
///     "```say\n[warm] Two things. {#pr-12} One shipped.\n```\n\n- [PR](u){#pr-12}"
///         → say "Two things. One shipped.", spoken "[warm] Two things. One shipped.", show "- [PR](u){#pr-12}"
///     "```say\nStill writ"                     → say "Still writ", show ""
///     "```say\nHi.\n\n```metrics\nA: 1\n```"   → say "Hi.", show "```metrics\nA: 1\n```"   (never closed)
///     "```say\nOne. Two. Three. Four. Five."   → say "One. Two. Three.", show "Four. Five."
///     "**Done.** All green.\n\n```metrics\n…```" → say "Done. All green.", show "```metrics\n…```"
///     "Two things:\n- one\n- two"               → say "Two things:", show "- one\n- two"
///     "```csv\n…```\n\nAfter."                  → say "", show the whole reply
struct BlobReply: Equatable {
    /// Plain text to show: emphasis, inline code, hints and cues stripped.
    var say: String
    /// Plain text for the voice: like `say`, with the delivery hint kept.
    var spoken: String
    /// Markdown for `MarkdownBody`, anchors still in (`BlobCues.parts`).
    var show: String
    /// The reply opened with a say fence: its script is a separate thing
    /// from what is shown, not the reply's first paragraph.
    var scripted: Bool

    var isEmpty: Bool { say.isEmpty && show.isEmpty }

    /// What is shown, cut at its anchors.
    var parts: [BlobCues.Part] { BlobCues.parts(of: show) }

    init(say: String, show: String) {
        self.say = say
        self.spoken = say
        self.show = show
        self.scripted = false
    }

    init(_ markdown: String) {
        let lines = markdown.components(separatedBy: "\n")
        var index = 0
        while index < lines.count, lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
            index += 1
        }
        if index < lines.count, let fence = Self.sayFence(lines[index]) {
            var script: [String] = []
            var closed = false
            var blank = false
            index += 1
            // The script ends at its closing fence. A fence that was never
            // closed ends where another block opens: a fence line, or a
            // block after a blank line.
            while index < lines.count {
                let line = lines[index]
                if Self.closes(line, fence) { index += 1; closed = true; break }
                if CueMarkers.fenceMarker(line) != nil { break }
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.isEmpty { blank = true; index += 1; continue }
                if blank, Self.startsBlock(line) { break }
                blank = false
                script.append(trimmed)
                index += 1
            }
            var raw = script.joined(separator: " ")
            var overflow = ""
            if !closed {
                // Unclosed, it may have swallowed the reply: say only its start.
                let capped = Self.capped(raw)
                overflow = CueMarkers.strip(String(raw.dropFirst(capped.count)))
                raw = capped
            }
            spoken = BlobSentenceStreamer.plain(CueMarkers.strip(raw))
            say = CueMarkers.withoutDirections(spoken)
            let rest = lines[min(index, lines.count)...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            // A ```canvas fence is the board, drawn by the canvas; its text
            // is the fallback for where the board can't render.
            show = CanvasFence.removing(from: [overflow, rest].filter { !$0.isEmpty }.joined(separator: "\n\n"))
            scripted = true
            return
        }
        var said: [String] = []
        while index < lines.count {
            let line = lines[index]
            if line.trimmingCharacters(in: .whitespaces).isEmpty || Self.startsBlock(line) { break }
            said.append(line.trimmingCharacters(in: .whitespaces))
            index += 1
        }
        say = Self.plain(CueMarkers.strip(said.joined(separator: " ")))
        spoken = say
        show = CanvasFence.removing(from: lines[index...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines))
        scripted = false
    }

    /// Most of an unclosed script that is said: this many sentences, and no
    /// more than `scriptChars`.
    static let scriptSentences = 3
    static let scriptChars = 600

    /// The start of an unclosed script that is said: up to
    /// `scriptSentences` complete sentences and `scriptChars` characters,
    /// cut at a sentence end (or, failing one, a space). The text itself
    /// when it is within both.
    static func capped(_ text: String) -> String {
        let chars = Array(text)
        var ends: [Int] = []
        var from = 0
        while ends.count < scriptSentences, let end = BlobSentenceStreamer.sentenceEnd(in: chars, from: from) {
            ends.append(end)
            from = end
        }
        var limit = ends.count == scriptSentences ? ends[ends.count - 1] : chars.count
        if limit > scriptChars {
            limit = ends.last(where: { $0 <= scriptChars })
                ?? chars[..<scriptChars].lastIndex(where: \.isWhitespace)
                ?? scriptChars
        }
        return String(chars[..<limit])
    }

    /// The opening of a say fence (```say, ~~~say): its marker, to close it.
    static func sayFence(_ line: String) -> (char: Character, length: Int)? {
        guard let marker = CueMarkers.fenceMarker(line) else { return nil }
        let info = line.trimmingCharacters(in: .whitespaces).dropFirst(marker.length)
        return info.trimmingCharacters(in: .whitespaces).lowercased() == "say" ? marker : nil
    }

    /// Whether `line` closes a fence opened with `fence`.
    static func closes(_ line: String, _ fence: (char: Character, length: Int)) -> Bool {
        guard let marker = CueMarkers.fenceMarker(line), marker.char == fence.char, marker.length >= fence.length
        else { return false }
        return line.trimmingCharacters(in: .whitespaces).count == marker.length
    }

    /// A fence, heading, list item or table row: the end of what Blob says.
    static func startsBlock(_ line: String) -> Bool {
        let s = line.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("```") || s.hasPrefix("~~~") || s.hasPrefix("|") { return true }
        return s.range(of: #"^(#{1,6}\s|[-*+]\s|\d+[.)]\s)"#, options: .regularExpression) != nil
    }

    /// Strips links, emphasis, strikethrough and inline code markers.
    static func plain(_ markdown: String) -> String {
        var s = markdown
        let rules: [(String, String)] = [
            (#"!?\[([^\]]+)\]\([^)]*\)"#, "$1"),
            (#"`([^`]+)`"#, "$1"),
            (#"\*\*(.+?)\*\*"#, "$1"),
            (#"(?<!\w)__(.+?)__(?!\w)"#, "$1"),
            (#"\*(\S(?:.*?\S)?)\*"#, "$1"),
            (#"(?<!\w)_(\S(?:.*?\S)?)_(?!\w)"#, "$1"),
            (#"~~(.+?)~~"#, "$1"),
        ]
        for (pattern, template) in rules {
            s = s.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
        }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Links into Blob, as Bark notifications open them: `blob://item/<id>`
/// names a supervisor item; `blob://` alone just opens the app.
enum BlobLink {
    static func itemId(_ url: URL) -> String? {
        guard url.scheme?.lowercased() == "blob",
              url.host(percentEncoded: false) == "item",
              let id = url.pathComponents.first(where: { $0 != "/" }),
              !id.isEmpty
        else { return nil }
        return id
    }
}
