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
///     SayBlock.parse("Done. [aside] More {#x.y}")                     → "Done. [aside] More"
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
    /// Anything shaped like a cue, valid id or not: never shown or read.
    static let loosePattern = #"\{#[^\s}]{1,64}\}"#

    private static func regex(_ pattern: String) -> NSRegularExpression {
        // The patterns are literals above; a typo is a programming error.
        try! NSRegularExpression(pattern: pattern)
    }

    private static let cueRegex = regex(pattern)
    private static let anyCue = regex(#"\s*"# + loosePattern)
    private static let typingCue = regex(#"\{#[^\s}]*$"#)
    private static let linkCue = regex(#"\]\([^()\s]*\)"# + pattern)
    private static let linkAnyCue = regex(#"(\]\([^()\s]*\))"# + loosePattern)
    private static let lineEndCue = regex(#"[ \t]*"# + pattern + #"[ \t]*$"#)
    private static let lineEndAnyCue = regex(#"[ \t]*"# + loosePattern + #"[ \t]*$"#)
    private static let leadingHint = regex(#"^\s*\[([^\]\n]{1,80})\](?!\()\s*"#)
    private static let whitespace = regex(#"\s+"#)

    private static func replace(_ regex: NSRegularExpression, in text: String, with template: String) -> String {
        regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }

    /// `text` without its cue markers (anything shaped like one), and
    /// without a marker still being typed at its end, whitespace collapsed.
    static func strip(_ text: String) -> String {
        guard text.contains("{#") else { return collapse(text) }
        return collapse(replace(typingCue, in: replace(anyCue, in: text, with: " "), with: ""))
    }

    /// The cue ids in `text`, in order.
    static func ids(in text: String) -> [String] {
        guard text.contains("{#") else { return [] }
        let range = NSRange(text.startIndex..., in: text)
        return cueRegex.matches(in: text, range: range).compactMap { match in
            Range(match.range(at: 1), in: text).map { String(text[$0]) }
        }
    }

    /// The delivery hint a script opens with (`[warm, unhurried]`), without
    /// its brackets, and the words after it. Only a leading hint counts, as
    /// on the web (lib/say-block.ts); a link's `[text](url)` is no hint.
    static func leadingDirection(_ text: String) -> (hint: String?, rest: String) {
        let range = NSRange(text.startIndex..., in: text)
        guard let match = leadingHint.firstMatch(in: text, range: range),
              let whole = Range(match.range, in: text), let hint = Range(match.range(at: 1), in: text)
        else { return (nil, text) }
        return (text[hint].trimmingCharacters(in: .whitespaces), String(text[whole.upperBound...]))
    }

    /// `text` without its leading delivery hint, which directs the voice
    /// and is never shown, whitespace collapsed.
    static func withoutDirections(_ text: String) -> String {
        collapse(leadingDirection(text).rest)
    }

    /// The words as the server voice gets them: the hint, then the words.
    static func directed(_ text: String, hint: String?) -> String {
        guard let hint, !hint.isEmpty else { return text }
        return "[\(hint)] \(text)"
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
                lines[index] = replace(lineEndAnyCue, in: line, with: "")
                continue
            }
            guard line.contains("{#") else { continue }
            lines[index] = replace(lineEndAnyCue, in: replace(linkAnyCue, in: line, with: "$1"), with: "")
        }
        return lines.joined(separator: "\n")
    }

    /// The anchor ids a line carries: after a link, or ending the line.
    static func anchorIds(inLine line: String) -> [String] {
        guard line.contains("{#") else { return [] }
        var ids: [String] = []
        let range = NSRange(line.startIndex..., in: line)
        for match in linkCue.matches(in: line, range: range) {
            if let id = Range(match.range(at: 1), in: line) { ids.append(String(line[id])) }
        }
        if let match = lineEndCue.firstMatch(in: line, range: range), let end = Range(match.range, in: line) {
            let found = Self.ids(in: String(line[end]))
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

    private static func collapse(_ text: String) -> String {
        replace(whitespace, in: text, with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
