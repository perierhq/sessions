import Foundation

/// Cuts a reply into sentences while it streams, so Blob can start reading
/// before the supervisor has finished writing. Fed the whole reply so far on
/// every change; returns the sentences that became complete since the last
/// call, as plain text. Only the Say part is read (`BlobReply`): it stops at
/// the first blank line, fence, heading, list item or table row.
///
/// A sentence is complete at `.`, `!`, `?` or `…` (closing emphasis, quotes
/// or brackets allowed) followed by whitespace or a line break. A dot inside
/// a number or a URL, or after an abbreviation or initial, is not an end;
/// nor is one followed by a lowercase word, so a sentence waits until the
/// next word has started. When the Say part closes, or the reply settles
/// (`finish`), the rest of it is read too. Sentences already read in this reply are never read again,
/// even when the finished reply rewrites what streamed.
///
/// Pure and Foundation-only, like `BlobReply`. No test target compiles
/// `Blob/`, so check changes with a scratch `swiftc` run against these
/// (each group fed in turn to one streamer):
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
    /// Where the next sentence starts in `source`.
    private var cursor = 0
    /// The reply as fed when its Say part closed; nil while it is open.
    private var closedAt: String?

    /// The complete sentences in `markdown` (the reply so far) not yet returned.
    mutating func feed(_ markdown: String) -> [String] {
        // The Say part has closed and this is the same message growing:
        // nothing after it is read.
        if let closedAt, markdown.hasPrefix(closedAt) { return [] }
        closedAt = nil
        let (say, closed) = Self.sayPart(of: markdown)
        let chars = Array(say)
        // A different message (the text before a tool call gave way to the
        // next one) or a rewrite: start over, still skipping what was read.
        if cursor > chars.count || chars[..<cursor] != source[..<cursor] { cursor = 0 }
        source = chars
        var out: [String] = []
        while let end = Self.sentenceEnd(in: chars, from: cursor) {
            take(chars[cursor..<end], into: &out)
            cursor = end
        }
        if closed {
            take(chars[cursor...], into: &out)
            cursor = chars.count
            closedAt = markdown
        }
        return out
    }

    /// The reply has settled: the sentences of its final Say part, cut the
    /// same way as while streaming, that have not been read yet.
    mutating func finish(_ markdown: String) -> [String] {
        // Two line breaks end the last line and close the Say part.
        let chars = Array(Self.sayPart(of: markdown + "\n\n").0)
        var out: [String] = []
        var start = 0
        while let end = Self.sentenceEnd(in: chars, from: start) {
            take(chars[start..<end], into: &out)
            start = end
        }
        take(chars[start...], into: &out)
        source = []
        cursor = 0
        closedAt = nil
        return out
    }

    private mutating func take(_ raw: ArraySlice<Character>, into out: inout [String]) {
        let sentence = Self.plain(String(raw))
        let key = Self.key(sentence)
        guard !key.isEmpty, !spoken.contains(key) else { return }
        spoken.insert(key)
        out.append(sentence)
    }

    // MARK: Rules

    /// The Say part so far, its lines joined with spaces, and whether it has
    /// ended. A line break counts as whitespace, so a sentence ending a line
    /// is complete. The unfinished last line is left out while it could still
    /// turn into a block (`-`, `1.`, `#`, a fence being typed).
    static func sayPart(of markdown: String) -> (String, closed: Bool) {
        let lines = markdown.components(separatedBy: "\n")
        var index = 0
        while index < lines.count - 1, lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
            index += 1
        }
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

    /// Letters and digits only, lowercased: the same sentence however it was marked up.
    private static func key(_ sentence: String) -> String {
        String(sentence.lowercased().filter { $0.isLetter || $0.isNumber })
    }
}
