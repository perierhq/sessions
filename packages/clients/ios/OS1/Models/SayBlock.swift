import Foundation

/// The spoken script of a Blob reply, a ```say fence (docs/blocks.md,
/// "Spoken script"), and the `{#id}` cue markers that tie it to what the
/// reply shows. In a transcript the fence is a quiet "Said aloud" line and
/// every cue is dropped; the Blob app reads them (`BlobReply`, `BlobCues`).
///
/// Pure and Foundation-only, like the other block models. Examples:
///
///     SayBlock.parse("[warm] Two things. {#inc-4} Checkout flapped.") → "Two things. Checkout flapped."
///     SayBlock.parse("[warm]")                                        → nil
///     CueMarkers.strip("again {#inc-4} right after")                  → "again right after"
///     CueMarkers.stripAnchors("[PR](u){#pr-12} merged\nDone {#d}")    → "[PR](u) merged\nDone"
///     CueMarkers.stripAnchors("```metrics {#stats}\nA: 1\n```")       → "```metrics\nA: 1\n```"
enum SayBlock {
    /// The words of a say fence as shown: no delivery hint, no cues,
    /// whitespace collapsed. Nil when nothing would be said.
    static func parse(_ source: String) -> String? {
        let words = CueMarkers.withoutDirections(CueMarkers.strip(source))
        return words.isEmpty ? nil : words
    }
}

enum CueMarkers {
    /// A cue: `{#` an id of letters, digits, `_` and `-` (starting with a
    /// letter or digit, up to 64) `}`.
    static let pattern = #"\{#([A-Za-z0-9][A-Za-z0-9_-]{0,63})\}"#

    /// `text` without its cue markers, and without a marker still being
    /// typed at its end, whitespace collapsed.
    static func strip(_ text: String) -> String {
        var s = text.replacingOccurrences(of: #"\s*"# + pattern, with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\{#[A-Za-z0-9_-]*$"#, with: "", options: .regularExpression)
        return collapse(s)
    }

    /// The cue ids in `text`, in order.
    static func ids(in text: String) -> [String] {
        guard text.contains("{#"), let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let range = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, range: range).compactMap { match in
            Range(match.range(at: 1), in: text).map { String(text[$0]) }
        }
    }

    /// `text` without bracketed delivery hints (`[warm, unhurried]`), which
    /// direct the voice and are never shown. A link's `[text](url)` stays.
    static func withoutDirections(_ text: String) -> String {
        collapse(text.replacingOccurrences(of: #"\[[^\]\n]{1,80}\](?!\()"#, with: " ", options: .regularExpression))
    }

    /// Markdown without its cue anchors: a `{#id}` right after a link, or
    /// ending a line (a fence's opening line too). Fenced code is left alone.
    static func stripAnchors(_ markdown: String) -> String {
        guard markdown.contains("{#") else { return markdown }
        var fence: (char: Character, length: Int)?
        var lines = markdown.components(separatedBy: "\n")
        for index in lines.indices {
            let line = lines[index]
            let opener = fenceMarker(line)
            if let open = fence {
                if let opener, opener.char == open.char, opener.length >= open.length,
                   line.trimmingCharacters(in: .whitespaces).count == opener.length {
                    fence = nil
                }
                continue
            }
            if let opener {
                fence = opener
                lines[index] = withoutLineEndAnchor(line)
                continue
            }
            guard line.contains("{#") else { continue }
            lines[index] = withoutLineEndAnchor(withoutLinkAnchors(line))
        }
        return lines.joined(separator: "\n")
    }

    /// The anchor ids a line carries: after a link, or ending the line.
    static func anchorIds(inLine line: String) -> [String] {
        guard line.contains("{#") else { return [] }
        var ids: [String] = []
        if let regex = try? NSRegularExpression(pattern: #"\]\([^()\s]*\)"# + pattern) {
            let range = NSRange(line.startIndex..., in: line)
            for match in regex.matches(in: line, range: range) {
                if let id = Range(match.range(at: 1), in: line) { ids.append(String(line[id])) }
            }
        }
        if let range = line.range(of: #"[ \t]*"# + pattern + #"[ \t]*$"#, options: .regularExpression) {
            let found = Self.ids(in: String(line[range]))
            ids.append(contentsOf: found.filter { !ids.contains($0) })
        }
        return ids
    }

    /// The opening or closing marker of a fence on this line: ``` or ~~~,
    /// up to three spaces in.
    static func fenceMarker(_ line: String) -> (char: Character, length: Int)? {
        let indent = line.prefix { $0 == " " }
        guard indent.count <= 3 else { return nil }
        let rest = line.dropFirst(indent.count)
        guard let first = rest.first, first == "`" || first == "~" else { return nil }
        let length = rest.prefix { $0 == first }.count
        return length >= 3 ? (first, length) : nil
    }

    private static func withoutLinkAnchors(_ line: String) -> String {
        line.replacingOccurrences(of: #"(\]\([^()\s]*\))"# + pattern, with: "$1", options: .regularExpression)
    }

    private static func withoutLineEndAnchor(_ line: String) -> String {
        line.replacingOccurrences(of: #"[ \t]*"# + pattern + #"[ \t]*$"#, with: "", options: .regularExpression)
    }

    private static func collapse(_ text: String) -> String {
        text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
