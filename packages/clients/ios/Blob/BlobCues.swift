import Foundation

/// One piece of what Blob says: the words sent to the voice as one request
/// and played as one item, and the shown element it points at.
struct BlobSegment: Equatable {
    /// Plain words for the voice; a delivery hint (`[warm]`) stays, cues don't.
    var text: String
    /// The `{#id}` of the shown element to focus when this starts playing.
    var cue: String?

    init(_ text: String, cue: String? = nil) {
        self.text = text
        self.cue = cue
    }
}

/// How the spoken script points at what a reply shows (docs/blocks.md,
/// "Spoken script"). The script carries `{#id}` cue markers; the shown
/// markdown carries the same ids as anchors (`CueMarkers`). Pure and
/// Foundation-only. No test target compiles `Blob/`, so check changes with
/// a scratch `swiftc` run of `BlobCues`, `BlobReply`, `BlobSentenceStreamer`
/// and `OS1/Models/SayBlock.swift` against these examples.
///
/// Speaking: the script is cut into segments at sentence ends and at cue
/// markers, so focus moves exactly when a segment's audio starts. A cut at
/// a marker in the middle of a sentence is skipped when it would leave fewer
/// than `minWords` words before it: that short run joins the next segment,
/// which takes the marker to its start (Fish's API has no way to pass the
/// previous text as context, so a split that short would sound clipped).
///
///     segments("Two things matter. {#inc-4} Checkout flapped again, I'd roll back. {#pr-12} And the drafts shipped.")
///         → ["Two things matter."], ["Checkout flapped again, I'd roll back." #inc-4], ["And the drafts shipped." #pr-12]
///     segments("Checkout flapped again right after 2.3.4, {#pr-12} and Pat's fix is waiting.")
///         → ["Checkout flapped again right after 2.3.4,"], ["and Pat's fix is waiting." #pr-12]
///     segments("It flapped {#inc-4} right after 2.3.4.")
///         → ["It flapped right after 2.3.4." #inc-4]          (two words before the marker: joined)
///
/// Showing: the shown markdown is cut into parts so each anchored element
/// can be scrolled to and pulsed. A fence, a list item (with its indented
/// lines) or a paragraph group is one unit; units with no anchor run
/// together into one part.
///
///     parts("Intro\n\n- [PR #12](u){#pr-12} merged\n- other\n\n```metrics {#stats}\nA: 1\n```")
///         → [[] "Intro"], [["pr-12"] "- [PR #12](u) merged"], [[] "- other"], [["stats"] "```metrics\nA: 1\n```"]
enum BlobCues {
    /// Fewest words before a mid-sentence cut.
    static let minWords = 4

    // MARK: Speaking

    /// A complete cue marker starting at `index`: its end and id.
    static func marker(in chars: [Character], at index: Int) -> (end: Int, id: String)? {
        guard index + 1 < chars.count, chars[index] == "{", chars[index + 1] == "#" else { return nil }
        var end = index + 2
        while end < chars.count, end - index - 2 < 64, isIdChar(chars[end]) { end += 1 }
        guard end > index + 2, end < chars.count, chars[end] == "}",
              chars[index + 2].isLetter || chars[index + 2].isNumber else { return nil }
        return (end + 1, String(chars[(index + 2)..<end]))
    }

    private static func isIdChar(_ c: Character) -> Bool {
        c.isASCII && (c.isLetter || c.isNumber || c == "_" || c == "-")
    }

    /// The next complete marker at or after `from`.
    static func nextMarker(in chars: [Character], from: Int) -> (start: Int, end: Int, id: String)? {
        var index = from
        while index < chars.count {
            if chars[index] == "{", let found = marker(in: chars, at: index) {
                return (index, found.end, found.id)
            }
            index += 1
        }
        return nil
    }

    /// The index just past the next complete segment starting at `start`,
    /// or nil when none is complete yet: a sentence end
    /// (`BlobSentenceStreamer.sentenceEnd`) or a cue marker in the middle of
    /// a sentence with at least `minWords` words before it.
    static func segmentEnd(in chars: [Character], from start: Int) -> Int? {
        // The segment's own marker, at its start, is not a cut.
        var scan = start
        while scan < chars.count, chars[scan].isWhitespace { scan += 1 }
        if let own = marker(in: chars, at: scan) { scan = own.end }
        while true {
            let sentence = BlobSentenceStreamer.sentenceEnd(in: chars, from: scan)
            guard let next = nextMarker(in: chars, from: scan), sentence.map({ next.start < $0 }) ?? true else {
                return sentence
            }
            if words(in: chars[start..<next.start]) >= minWords { return next.start }
            scan = next.end
        }
    }

    /// The segment for raw script text: the last marker in it is its cue (a
    /// short run joined forward hands its marker on), the words are plain.
    static func segment(_ raw: String) -> BlobSegment {
        BlobSegment(BlobSentenceStreamer.plain(CueMarkers.strip(raw)), cue: CueMarkers.ids(in: raw).last)
    }

    /// The whole script cut into segments, as the streamer cuts it.
    static func segments(_ script: String) -> [BlobSegment] {
        let chars = Array(script)
        var out: [BlobSegment] = []
        var start = 0
        while let end = segmentEnd(in: chars, from: start) {
            out.append(segment(String(chars[start..<end])))
            start = end
        }
        out.append(segment(String(chars[start...])))
        return out.filter { !$0.text.isEmpty }
    }

    private static func words(in chars: ArraySlice<Character>) -> Int {
        CueMarkers.withoutDirections(CueMarkers.strip(String(chars))).split(whereSeparator: \.isWhitespace).count
    }

    // MARK: Showing

    /// A run of the shown markdown and the anchors it carries.
    struct Part: Equatable {
        var ids: [String]
        var markdown: String
    }

    /// The shown markdown in parts, anchors stripped. One part, with no ids,
    /// when it carries no anchor.
    static func parts(of show: String) -> [Part] {
        guard show.contains("{#") else { return [Part(ids: [], markdown: show)] }
        // Units: (separator before it, its lines, its ids).
        var units: [(gap: String, lines: [String], ids: [String])] = []
        var blank = false
        var fence: (char: Character, length: Int)?
        var lastIsFence = false
        for line in show.components(separatedBy: "\n") {
            if let open = fence {
                units[units.count - 1].lines.append(line)
                if let close = CueMarkers.fenceMarker(line), close.char == open.char, close.length >= open.length,
                   line.trimmingCharacters(in: .whitespaces).count == close.length {
                    fence = nil
                }
                continue
            }
            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                blank = !units.isEmpty
                continue
            }
            let ids = CueMarkers.anchorIds(inLine: line)
            let gap = units.isEmpty ? "" : blank ? "\n\n" : "\n"
            if let open = CueMarkers.fenceMarker(line) {
                fence = open
                units.append((gap, [line], ids))
                lastIsFence = true
            } else if isListItem(line) || blank || units.isEmpty || lastIsFence {
                units.append((gap, [line], ids))
                lastIsFence = false
            } else {
                // A continuation: an indented line under a list item, or the
                // next line of a paragraph.
                units[units.count - 1].lines.append(line)
                units[units.count - 1].ids.append(contentsOf: ids)
            }
            blank = false
        }
        var parts: [Part] = []
        for unit in units {
            let text = CueMarkers.stripAnchors(unit.lines.joined(separator: "\n"))
            if unit.ids.isEmpty, let last = parts.last, last.ids.isEmpty {
                parts[parts.count - 1].markdown += unit.gap + text
            } else {
                parts.append(Part(ids: unit.ids, markdown: text))
            }
        }
        return parts.isEmpty ? [Part(ids: [], markdown: show)] : parts
    }

    private static func isListItem(_ line: String) -> Bool {
        line.range(of: #"^\s{0,3}([-*+]|\d+[.)])\s"#, options: .regularExpression) != nil
    }
}
