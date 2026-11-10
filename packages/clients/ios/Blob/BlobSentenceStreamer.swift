import Foundation

/// Cuts a reply into segments while it streams, so Blob can start reading
/// before the supervisor has finished writing. Fed the whole reply so far on
/// every change; returns the segments that became complete since the last
/// call (`BlobSegment`: plain words, and the cue to focus when they play).
/// Only what Blob says is read (`BlobReply`): the inside of the opening
/// ```say fence, up to its closing fence, or for a reply without one, the
/// first paragraph, up to the first blank line, fence, heading, list item or
/// table row.
///
/// A segment ends at a sentence end or at a `{#id}` cue marker
/// (`BlobCues.segmentEnd`, with its rule for short runs). A sentence is
/// complete at `.`, `!`, `?` or `…` (closing emphasis, quotes or brackets
/// allowed) followed by whitespace or a line break. A dot inside a number or
/// a URL, or after an abbreviation or initial, is not an end; nor is one
/// followed by a lowercase word, so a sentence waits until the next word has
/// started. When the Say part closes, or the reply settles (`finish`), the
/// rest of it is read too. Segments already read in this reply are never
/// read again, even when the finished reply rewrites what streamed.
///
/// Pure and Foundation-only, like `BlobReply`. No test target compiles
/// `Blob/`, so check changes with a scratch `swiftc` run against these
/// (each group fed in turn to one streamer; a cue shown as #id):
///
///     feed("```say\n[warm] Two things matter. {#inc-4} Checkout fl")
///                                       → ["[warm] Two things matter."]
///     feed("```say\n[warm] Two things matter. {#inc-4} Checkout flapped again, I'd roll back.\n```\n- a")
///                                       → ["Checkout flapped again, I'd roll back." #inc-4]
///
///     feed("```say\nCheckout flapped again right after 2.3.4, {#pr-12} and Pat's")
///                                       → ["Checkout flapped again right after 2.3.4,"]
///     finish("```say\nCheckout flapped again right after 2.3.4, {#pr-12} and Pat's fix is waiting.\n```")
///                                       → ["and Pat's fix is waiting." #pr-12]
///
///     feed("``")                        → []      (could still open a say fence)
///
///     feed("```say\nHi there.\n\n```metrics\n")  → ["Hi there."]  (never closed: ends at the next fence)
///     feed("```say\nOne. Two. Three. Four. Five.") → ["One.", "Two.", "Three."]  (unclosed: three at most)
///
///     feed("**Done.** All gr")          → ["Done."]
///     feed("**Done.** All green.\n\n- a") → ["All green."]
///
///     feed("Version 3.5 is out, e.g. on iOS. See example.com/a.b now")
///                                       → ["Version 3.5 is out, e.g. on iOS."]
///     finish("Version 3.5 is out, e.g. on iOS. See example.com/a.b now.")
///                                       → ["See example.com/a.b now."]
///
///     feed("Two things:\n- one")        → ["Two things:"]
///
///     feed("```csv\n…")                 → []
struct BlobSentenceStreamer {
    /// What has been read in this reply, normalized for comparison.
    private var spoken: Set<String> = []
    /// The Say text the cursor counts into, as last fed.
    private var source: [Character] = []
    /// Where the next segment starts in `source`.
    private var cursor = 0
    /// The reply as fed when its Say part closed; nil while it is open.
    private var closedAt: String?

    /// The complete segments in `markdown` (the reply so far) not yet returned.
    mutating func feed(_ markdown: String) -> [BlobSegment] {
        // The Say part has closed and this is the same message growing:
        // nothing after it is read.
        if let closedAt, markdown.hasPrefix(closedAt) { return [] }
        closedAt = nil
        let (say, closed) = Self.sayPart(of: markdown)
        // The leading delivery hint rides every segment; while it is still
        // being typed, nothing is complete yet.
        guard let split = Self.splitHint(say, closed: closed) else { return [] }
        let delivery = split.hint
        let chars = Array(split.rest)
        // A different message (the text before a tool call gave way to the
        // next one) or a rewrite: start over, still skipping what was read.
        if cursor > chars.count || chars[..<cursor] != source[..<cursor] { cursor = 0 }
        source = chars
        var out: [BlobSegment] = []
        while let end = BlobCues.segmentEnd(in: chars, from: cursor) {
            take(chars[cursor..<end], delivery: delivery, into: &out)
            cursor = end
        }
        if closed {
            take(chars[cursor...], delivery: delivery, into: &out)
            cursor = chars.count
            closedAt = markdown
        }
        return out
    }

    /// The reply has settled: the segments of its final Say part, cut the
    /// same way as while streaming, that have not been read yet.
    mutating func finish(_ markdown: String) -> [BlobSegment] {
        // A line break ends the last line; for a reply without a say fence a
        // second one closes the Say part too.
        let (delivery, script) = CueMarkers.leadingDirection(Self.sayPart(of: markdown + "\n\n").0)
        let chars = Array(script)
        var out: [BlobSegment] = []
        var start = 0
        while let end = BlobCues.segmentEnd(in: chars, from: start) {
            take(chars[start..<end], delivery: delivery, into: &out)
            start = end
        }
        take(chars[start...], delivery: delivery, into: &out)
        source = []
        cursor = 0
        closedAt = nil
        return out
    }

    private mutating func take(_ raw: ArraySlice<Character>, delivery: String?, into out: inout [BlobSegment]) {
        let segment = BlobCues.segment(String(raw), delivery: delivery)
        let key = Self.key(segment.text)
        guard !key.isEmpty, !spoken.contains(key) else { return }
        spoken.insert(key)
        out.append(segment)
    }

    // MARK: Rules

    /// The Say part so far, its lines joined with spaces, and whether it has
    /// ended. A line break counts as whitespace, so a sentence ending a line
    /// is complete. The unfinished last line is left out while it could still
    /// turn into something else: a block (`-`, `1.`, `#`, a fence being
    /// typed), the say fence's opening, or its closing.
    static func sayPart(of markdown: String) -> (String, closed: Bool) {
        let lines = markdown.components(separatedBy: "\n")
        var index = 0
        while index < lines.count - 1, lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
            index += 1
        }
        if index < lines.count - 1, let fence = BlobReply.sayFence(lines[index]) {
            return scriptPart(lines[(index + 1)...], fence: fence)
        }
        let first = lines[index].trimmingCharacters(in: .whitespaces)
        if index == lines.count - 1, mayOpenSayFence(first) { return ("", false) }
        var text = ""
        while index < lines.count - 1 {
            let line = lines[index]
            if line.trimmingCharacters(in: .whitespaces).isEmpty || BlobReply.startsBlock(line) {
                return (text, true)
            }
            text += line.trimmingCharacters(in: .whitespaces) + " "
            index += 1
        }
        let partial = String(lines[index].drop { $0 == " " || $0 == "\t" })
        let trimmed = partial.trimmingCharacters(in: .whitespaces)
        if BlobReply.startsBlock(partial) { return (text, true) }
        let undecided = trimmed.isEmpty
            || trimmed.allSatisfy(\.isNumber)
            || (trimmed.count < 3 && trimmed.allSatisfy { $0 == "`" || $0 == "~" })
            || BlobReply.startsBlock(trimmed + " x")
        return (undecided ? text : text + partial, false)
    }

    /// The leading delivery hint of the Say text and the words after it;
    /// nil while a leading `[` could still be a hint or a link.
    static func splitHint(_ say: String, closed: Bool) -> (hint: String?, rest: String)? {
        let head = say.drop { $0.isWhitespace }
        if !closed, head.first == "[" {
            // Undecided until the bracket closes and the next character
            // shows it is not a link's `](`.
            guard let close = head.firstIndex(of: "]"), head.index(after: close) < head.endIndex else { return nil }
        }
        return CueMarkers.leadingDirection(say)
    }

    /// The inside of a say fence so far (`lines` start after its opening).
    /// Closed at the closing fence; the last line waits while it could be
    /// one. A fence that was never closed ends as `BlobReply` ends it: at a
    /// fence line, or a block after a blank line; and only its start is
    /// said (`BlobReply.capped`), so what it swallowed stays silent.
    private static func scriptPart(
        _ lines: ArraySlice<String>, fence: (char: Character, length: Int)
    ) -> (String, closed: Bool) {
        var text = ""
        var blank = false
        func ended(_ text: String, closed: Bool) -> (String, closed: Bool) {
            let capped = BlobReply.capped(text)
            return capped.count < text.trimmingCharacters(in: .whitespaces).count ? (capped, true) : (text, closed)
        }
        for line in lines.dropLast() {
            if BlobReply.closes(line, fence) { return (text, true) }
            if CueMarkers.fenceMarker(line) != nil { return ended(text, closed: true) }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { blank = true; continue }
            if blank, BlobReply.startsBlock(line) { return ended(text, closed: true) }
            blank = false
            text += trimmed + " "
        }
        let partial = (lines.last ?? "").trimmingCharacters(in: .whitespaces)
        if !partial.isEmpty, partial.allSatisfy({ $0 == fence.char }) { return ended(text, closed: false) }
        if CueMarkers.fenceMarker(partial) != nil { return ended(text, closed: true) }
        if blank, !partial.isEmpty {
            if BlobReply.startsBlock(partial) { return ended(text, closed: true) }
            // It could still turn into a list item, a heading or a row.
            if partial.allSatisfy(\.isNumber) || BlobReply.startsBlock(partial + " x") {
                return ended(text, closed: false)
            }
        }
        return ended(text + partial, closed: false)
    }

    /// Whether an unfinished first line could still become ```say.
    private static func mayOpenSayFence(_ line: String) -> Bool {
        guard let first = line.first, first == "`" || first == "~" else { return false }
        let marker = line.prefix { $0 == first }
        if marker.count < 3 { return marker.count == line.count }
        let info = line.dropFirst(marker.count).trimmingCharacters(in: .whitespaces).lowercased()
        return "say".hasPrefix(info)
    }

    private static let terminators: Set<Character> = [".", "!", "?", "…"]
    /// Marks that may close a sentence after its terminator.
    private static let closers: Set<Character> = ["*", "_", "~", "`", ")", "]", "\"", "'", "\u{201D}", "\u{2019}", "»"]
    /// Words a dot follows without ending the sentence. Matched lowercased,
    /// except `No` and `Nr`, which end sentences as "no." and "nr.".
    private static let abbreviations: Set<String> = [
        "e.g", "i.e", "vs", "mr", "mrs", "ms", "dr", "prof", "st", "cf", "approx", "incl", "fig", "np", "tj", "ul",
    ]

    /// The index just past the next complete sentence's terminator and
    /// closing marks, or nil when no sentence after `start` is complete yet.
    static func sentenceEnd(in chars: [Character], from start: Int) -> Int? {
        var index = start
        while index < chars.count {
            let char = chars[index]
            guard terminators.contains(char) else { index += 1; continue }
            var end = index + 1
            while end < chars.count, terminators.contains(chars[end]) { end += 1 }
            while end < chars.count, closers.contains(chars[end]) { end += 1 }
            guard end < chars.count else { return nil }
            if chars[end].isWhitespace, !(char == "." && abbreviation(before: index, in: chars)) {
                // The next word decides: lowercase ("Then… nothing") goes
                // on. Until it has started, the sentence isn't complete.
                var next = end
                while next < chars.count, chars[next].isWhitespace { next += 1 }
                guard next < chars.count else { return nil }
                if !chars[next].isLowercase { return end }
            }
            index = end
        }
        return nil
    }

    /// Whether the word before the dot at `dot` is an abbreviation or an
    /// initial, so the dot doesn't end the sentence.
    private static func abbreviation(before dot: Int, in chars: [Character]) -> Bool {
        var start = dot
        while start > 0, !chars[start - 1].isWhitespace { start -= 1 }
        let word = String(chars[start..<dot]).drop { "*_([\"'`".contains($0) }
        guard !word.isEmpty else { return false }
        if word == "No" || word == "Nr" { return true }
        if word.count == 1, word.first?.isUppercase == true { return true }
        // "e.g", "U.S": single letters joined by dots.
        if word.range(of: #"^(\p{L}\.)+\p{L}$"#, options: .regularExpression) != nil { return true }
        return abbreviations.contains(word.lowercased())
    }

    /// Plain words for the voice: `BlobReply.plain`, then emphasis markers a
    /// sentence boundary cut in half.
    static func plain(_ markdown: String) -> String {
        var s = BlobReply.plain(markdown)
        for (pattern, template) in [(#"\*+|`+|~~"#, ""), (#"(?<!\w)_+|_+(?!\w)"#, ""), (#"\s+"#, " ")] {
            s = s.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
        }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Letters and digits only, lowercased: the same words however they were marked up.
    private static func key(_ sentence: String) -> String {
        String(sentence.lowercased().filter { $0.isLetter || $0.isNumber })
    }
}
