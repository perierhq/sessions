import Foundation

/// What one part of a Blob reply shows (`BlobCues.Part`), read into the
/// elements Blob draws itself, the same way while the reply streams and once
/// it has settled, so settling never reflows it:
///
/// - **Rows.** A reference line (`[PR #12](url) · merged · CI green`), a
///   bold-lead paragraph (`**Release 533** · stuck · it conflicts again.`)
///   or a short `Title · status · detail` line is a status row: a title, a
///   status (its first `·` fragment, which also picks the row's mark) and a
///   supporting line. Rows in a row, blank lines or not, are one list.
/// - **Callouts** (`> [!NOTE]` … `> [!CAUTION]`) and **quotes** (`> …`).
/// - **Fences** a block claims (`claims`), complete: drawn by the block
///   catalog (`MarkdownBody`) as soon as the closing fence arrives.
/// - **Prose**: everything else, markdown for the renderer.
///
/// While the part is still being written (`open`), what can't be drawn yet
/// holds its place instead of showing source: an unclosed fence, a callout
/// or quote still growing, a row whose title or status hasn't arrived. The
/// prose at the end loses markers that aren't closed yet (`closeInline`), so
/// `**bo` reads `bo` until its `**` comes. Cue anchors (`{#id}`) are never
/// shown, nor one still being typed.
///
/// Foundation-only. No test target compiles `Blob/`, so check changes with a
/// scratch `swiftc` run of this file and `OS1/Models/SayBlock.swift` against
/// these examples (`claims` = {"choices", "metrics"}):
///
///     "[PR #10](u) · merged · CI green"           → rows [PR #10, u, "merged", "CI green", done]
///     "**Release 533** · stuck · it conflicts."   → rows [Release 533, "stuck", "It conflicts.", attention]
///     "Held releases · unblocked · watching"      → rows [Held releases, "unblocked", "Watching", done]
///     "**Done.** All green."                       → prose
///     "> [!NOTE]\n> Check the domain."             → callout(note, "Check the domain.")
///     "> [!NOTE]\n> Check the"            (open)   → placeholder(callout)
///     "Intro\n\n```choices\nA\nB"         (open)   → prose "Intro", placeholder(chips)
///     "Intro **bo"                        (open)   → prose "Intro bo"
///     "See [the PR](https://exa"          (open)   → prose "See the PR"
///     "**Release 5"                       (open)   → placeholder(row)
///     "Text {#ab"                         (open)   → prose "Text"
enum BlobShow {
    /// What a row's status says about the item, for its mark.
    enum Tone: Equatable {
        /// Failing or stuck: needs someone.
        case attention
        /// Moving or waiting: running, open, new.
        case running
        /// Fine: merged, ready, resolved.
        case done
        case neutral
    }

    struct Row: Equatable {
        /// Inline markdown, never a URL.
        var title: String
        var url: String?
        /// The first `·` fragment after the title, plain words.
        var status: String?
        /// The rest, inline markdown, `·`-joined. May be empty.
        var detail: String
        var tone: Tone
    }

    /// The space an element that isn't complete yet holds.
    enum Placeholder: Equatable { case row, callout, quote, chips, block }

    enum Block: Equatable {
        case prose(String)
        case rows([Row])
        /// A callout's kind (`note`, `tip`, `important`, `warning`,
        /// `caution`) and its body, markdown with the quote markers gone.
        case callout(kind: String, body: String)
        case quote(String)
        /// A complete claimed fence, as written.
        case fence(String)
        case placeholder(Placeholder)
    }

    static let calloutKinds: Set<String> = ["note", "tip", "important", "warning", "caution"]

    static func blocks(of markdown: String, open: Bool, claims: (String) -> Bool) -> [Block] {
        var text = markdown
        if open { text = text.replacingOccurrences(of: #"\{#[^\s}]*$"#, with: "", options: .regularExpression) }
        let lines = text.components(separatedBy: "\n")
        var out: [Block] = []
        var prose: [String] = []
        // A quote or a short plain row may only start a block.
        var atStart = true

        func flushProse() {
            let kept = trimBlankEdges(prose)
            prose = []
            guard !kept.isEmpty else { return }
            out.append(.prose(kept.joined(separator: "\n")))
        }
        func add(_ block: Block) {
            flushProse()
            if case .rows(let rows) = block, case .rows(let before)? = out.last {
                out[out.count - 1] = .rows(before + rows)
            } else {
                out.append(block)
            }
        }
        // A unit that runs to the end of the text is still being written:
        // its last line is incomplete, or a line after it could still join.
        func runsToEnd(_ end: Int) -> Bool {
            open && (end >= lines.count || (end == lines.count - 1 && lines[end].isEmpty))
        }

        var index = 0
        while index < lines.count {
            let line = lines[index]
            if let marker = CueMarkers.fenceMarker(line) {
                var end = index + 1
                while end < lines.count, !closes(lines[end], marker) { end += 1 }
                let info = line.trimmingCharacters(in: .whitespaces).dropFirst(marker.length)
                let lang = info.split(whereSeparator: \.isWhitespace).first.map { $0.lowercased() } ?? ""
                if end < lines.count {
                    let fence = Array(lines[index...end])
                    if claims(lang) { add(.fence(fence.joined(separator: "\n"))) } else { prose += fence }
                    index = end + 1
                    atStart = true
                    continue
                }
                if open {
                    add(.placeholder(lang == "choices" ? .chips : .block))
                } else {
                    prose += lines[index...]
                }
                break
            }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                prose.append(line)
                atStart = true
                index += 1
                continue
            }
            if atStart, let first = quoteBody(line) {
                var body = [first]
                var end = index + 1
                while end < lines.count, let inner = quoteBody(lines[end]) { body.append(inner); end += 1 }
                // Lazy continuation, as in CommonMark.
                while end < lines.count, !lines[end].trimmingCharacters(in: .whitespaces).isEmpty,
                      CueMarkers.fenceMarker(lines[end]) == nil, !lines[end].hasPrefix("#") {
                    body.append(lines[end])
                    end += 1
                }
                let marker = first.trimmingCharacters(in: .whitespaces)
                let kind = marker.hasPrefix("[!") && marker.hasSuffix("]")
                    ? marker.dropFirst(2).dropLast().lowercased() : nil
                if runsToEnd(end) {
                    add(.placeholder(marker.hasPrefix("[") || marker.isEmpty ? .callout : .quote))
                    break
                }
                if let kind, calloutKinds.contains(kind) {
                    add(.callout(kind: kind, body: joinQuote(Array(body.dropFirst()))))
                } else {
                    add(.quote(joinQuote(body)))
                }
                index = end
                atStart = true
                continue
            }
            let afterRows: Bool = { if case .rows? = out.last, prose.allSatisfy(isBlank) { return true }; return false }()
            switch rowLead(line, plainAllowed: atStart || afterRows) {
            case .row:
                var unit = [line]
                var end = index + 1
                while end < lines.count, continues(lines[end], afterRows: true) {
                    unit.append(lines[end])
                    end += 1
                }
                let joined = unit.map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: " ")
                let still = open && end >= lines.count
                if var row = row(joined) {
                    if still { row.detail = closeInline(row.detail) }
                    add(.rows([row]))
                } else if still {
                    add(.placeholder(.row))
                } else {
                    prose += unit
                    atStart = false
                }
                index = still ? lines.count : end
                atStart = true
                continue
            case .maybe where open && index == lines.count - 1:
                add(.placeholder(.row))
                index += 1
                continue
            default:
                break
            }
            prose.append(line)
            atStart = false
            index += 1
        }
        flushProse()
        if open, case .prose(let last)? = out.last {
            let closed = closeProse(last)
            if closed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                out.removeLast()
            } else {
                out[out.count - 1] = .prose(closed)
            }
        }
        return out.map { block in
            guard case .prose(let text) = block else { return block }
            return .prose(stripCues(text))
        }
    }

    // MARK: Rows

    private enum Lead { case row, maybe, none }

    /// Whether `line` starts a row: `.maybe` while a link or bold lead is
    /// still being written and could become one.
    private static func rowLead(_ line: String, plainAllowed: Bool) -> Lead {
        let body = withoutBullet(line.trimmingCharacters(in: .whitespaces))
        if body.hasPrefix("[") && !body.hasPrefix("[!") || body.hasPrefix("**") {
            guard let (_, _, rest) = lead(body) else {
                // A lead still being written.
                let partial = #"^(\[[^\]]*\]?|\[[^\]]+\]\([^)\s]*|\*\*[^*]*\*?)$"#
                return body.range(of: partial, options: .regularExpression) != nil ? .maybe : .none
            }
            let after = rest.trimmingCharacters(in: .whitespaces)
            if after.hasPrefix("·") { return .row }
            return after.isEmpty || after.hasPrefix("{") ? .maybe : .none
        }
        guard plainAllowed, let plain = plainTitle(body) else { return .none }
        return plain.isEmpty ? .none : .row
    }

    /// A line that carries on the row above it: not blank, not a new row or
    /// another block.
    private static func continues(_ line: String, afterRows: Bool) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, CueMarkers.fenceMarker(line) == nil, quoteBody(line) == nil,
              !trimmed.hasPrefix("#"), !trimmed.hasPrefix("|") else { return false }
        if case .none = rowLead(line, plainAllowed: afterRows) {
            return trimmed.range(of: #"^([-*+]|\d+[.)])\s"#, options: .regularExpression) == nil
        }
        return false
    }

    /// The row a complete line or paragraph is, or nil.
    static func row(_ text: String) -> Row? {
        let body = withoutBullet(stripCues(text).trimmingCharacters(in: .whitespaces))
        var title: String
        var url: String?
        var rest: Substring
        if let (leadTitle, leadURL, after) = lead(body) {
            let trimmed = after.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("·") else { return nil }
            title = leadTitle
            url = leadURL
            rest = trimmed.dropFirst()
        } else if let plain = plainTitle(body), !plain.isEmpty {
            title = plain
            rest = body.dropFirst(plain.count).drop { $0 == " " }.dropFirst()
        } else {
            return nil
        }
        title = title.trimmingCharacters(in: .whitespaces)
        let fragments = rest.components(separatedBy: " · ")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && $0 != "·" }
        guard !title.isEmpty else { return nil }
        let status = fragments.first.map { $0.hasSuffix("·") ? String($0.dropLast()).trimmingCharacters(in: .whitespaces) : $0 }
        let detail = capitalized(fragments.dropFirst().joined(separator: " · "))
        return Row(title: title, url: url, status: status, detail: detail, tone: tone(of: status ?? ""))
    }

    /// A link (`[title](url)`) or bold (`**title**`) lead: its title, URL
    /// and what follows.
    private static func lead(_ body: String) -> (String, String?, String)? {
        if body.hasPrefix("["), let match = body.range(of: #"^\[([^\]]+)\]\(([^)\s]+)\)"#, options: .regularExpression) {
            let whole = String(body[match])
            let close = whole.firstIndex(of: "]")!
            let title = String(whole[whole.index(after: whole.startIndex)..<close])
            let url = String(whole[whole.index(close, offsetBy: 2)..<whole.index(before: whole.endIndex)])
            return (title, url, String(body[match.upperBound...]))
        }
        if body.hasPrefix("**"), let match = body.range(of: #"^\*\*([^*]+)\*\*"#, options: .regularExpression) {
            let title = String(body[match].dropFirst(2).dropLast(2))
            return (title, nil, String(body[match.upperBound...]))
        }
        return nil
    }

    /// The title of a plain `Title · status` line: short, no sentence
    /// punctuation at its end, no markup. Nil when the line isn't one.
    private static func plainTitle(_ body: String) -> String? {
        guard let dot = body.range(of: " · ") else { return nil }
        let title = String(body[..<dot.lowerBound])
        guard title.count <= 60, let last = title.last, !".,:;!?".contains(last),
              !title.contains("["), !title.contains("*"), !title.contains("`"),
              title.range(of: #"^(#|>|\||\d+[.)]\s)"#, options: .regularExpression) == nil
        else { return nil }
        return title
    }

    private static func withoutBullet(_ line: String) -> String {
        guard let match = line.range(of: #"^[-*+]\s+"#, options: .regularExpression) else { return line }
        return String(line[match.upperBound...])
    }

    private static func capitalized(_ text: String) -> String {
        guard let first = text.first, first.isLowercase else { return text }
        return first.uppercased() + text.dropFirst()
    }

    private static let attentionWords: Set<String> = [
        "stuck", "fail", "failed", "failing", "fails", "broken", "broke", "down", "blocked", "conflict",
        "conflicts", "error", "errors", "rejected", "flapping", "overdue", "outage", "crashing",
    ]
    private static let doneWords: Set<String> = [
        "merged", "ready", "done", "resolved", "green", "shipped", "live", "ok", "passed", "passing",
        "unblocked", "fixed", "approved", "clean", "deployed", "released", "answered", "closed", "healthy",
    ]
    private static let runningWords: Set<String> = [
        "running", "progress", "waiting", "pending", "open", "new", "held", "checking", "watching",
        "queued", "review", "draft", "building", "deploying", "shipping", "working",
    ]

    /// The tone a status reads as. A fix wins over the trouble it names
    /// ("conflicts resolved" is done), then trouble, then movement.
    static func tone(of status: String) -> Tone {
        let lower = status.lowercased()
        if lower.contains("needs you") { return .attention }
        let words = Set(lower.split { !$0.isLetter }.map(String.init))
        if lower.hasPrefix("no ") || lower.hasPrefix("not ") || lower.contains("nobody") {
            return words.isDisjoint(with: attentionWords) ? .neutral : .done
        }
        if !words.isDisjoint(with: ["resolved", "fixed", "unblocked"]) { return .done }
        if !words.isDisjoint(with: attentionWords) { return .attention }
        if !words.isDisjoint(with: doneWords) { return .done }
        if !words.isDisjoint(with: runningWords) { return .running }
        return .neutral
    }

    // MARK: Quotes

    /// The text after a top-level `>` marker, or nil.
    private static func quoteBody(_ line: String) -> String? {
        var rest = line[...]
        var indent = 0
        while rest.first == " ", indent < 3 { rest = rest.dropFirst(); indent += 1 }
        guard rest.first == ">" else { return nil }
        rest = rest.dropFirst()
        if rest.first == " " { rest = rest.dropFirst() }
        return String(rest)
    }

    /// Quote lines as inline markdown: lines of a paragraph joined, blank
    /// lines kept as breaks.
    private static func joinQuote(_ lines: [String]) -> String {
        var paragraphs: [String] = []
        var current: [String] = []
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                if !current.isEmpty { paragraphs.append(current.joined(separator: " ")); current = [] }
            } else {
                current.append(trimmed)
            }
        }
        if !current.isEmpty { paragraphs.append(current.joined(separator: " ")) }
        return stripCues(paragraphs.joined(separator: "\n"))
    }

    // MARK: Streaming

    /// The prose at the end of a part still being written, without what
    /// would show as source: a heading, list or rule marker on its own, and
    /// inline markers not closed yet (`closeInline`).
    static func closeProse(_ text: String) -> String {
        var lines = text.components(separatedBy: "\n")
        if let last = lines.last,
           last.range(of: #"^\s*(#{1,6}|[-*+]|\d+[.)]?|[-*_=]+|`{1,2}|~{1,2}|\|)?\s*$"#, options: .regularExpression) != nil {
            lines.removeLast()
        }
        guard !lines.isEmpty else { return "" }
        // Only the last paragraph can still be open.
        var start = lines.count - 1
        while start > 0, !lines[start - 1].trimmingCharacters(in: .whitespaces).isEmpty { start -= 1 }
        let paragraph = lines[start...].joined(separator: "\n")
        return (lines[..<start] + [closeInline(paragraph)]).joined(separator: "\n")
    }

    /// Inline markdown still being written, with its unclosed markers taken
    /// out: an unclosed code span, emphasis, strikethrough or link reads as
    /// the words inside it, an image not yet complete is left out. Text
    /// whose markers all close comes back as it is.
    static func closeInline(_ text: String) -> String {
        var s = text
        if s.filter({ $0 == "`" }).count % 2 == 1, let last = s.lastIndex(of: "`") { s.remove(at: last) }
        let rules: [(String, String)] = [
            (#"!\[[^\]]*(\]\([^)]*)?$"#, ""),
            (#"\[([^\]]*)\]\([^)]*$"#, "$1"),
            (#"\[([^\]]*)\]?$"#, "$1"),
        ]
        for (pattern, template) in rules {
            s = s.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
        }
        for marker in ["**", "__", "~~"] where s.components(separatedBy: marker).count % 2 == 0 {
            if let last = s.range(of: marker, options: .backwards) { s.removeSubrange(last) }
        }
        // A single `*` that opens emphasis: not a bullet, not spaced like a
        // multiplication sign.
        let chars = Array(s)
        var singles: [Int] = []
        var index = 0
        while index < chars.count {
            if chars[index] == "*" {
                if index + 1 < chars.count, chars[index + 1] == "*" { index += 2; continue }
                let before = index == 0 ? " " : chars[index - 1]
                let after = index + 1 < chars.count ? chars[index + 1] : " "
                if !(before.isWhitespace && after.isWhitespace) { singles.append(index) }
            }
            index += 1
        }
        if singles.count % 2 == 1, let last = singles.last {
            s = String(chars[..<last]) + String(chars[(last + 1)...])
        }
        // A marker just started at the end: `foo *` on its way to `foo **bar**`.
        s = s.replacingOccurrences(of: #"(^|\s)[*_~]+$"#, with: "$1", options: .regularExpression)
        // An underscore inside the last word is never emphasis, but a
        // renderer still guessing at a half-written word could take it for one.
        if s.filter({ $0 == "`" }).count % 2 == 0, let space = s.lastIndex(where: \.isWhitespace) ?? s.indices.first {
            let word = s[space...]
            if word.contains("_"), !word.contains("\\_") {
                s = String(s[..<space]) + word.replacingOccurrences(of: #"(?<=[A-Za-z0-9])_"#, with: #"\\_"#, options: .regularExpression)
            }
        }
        return s
    }

    // MARK: Helpers

    /// Anything shaped like a cue, wherever it sits outside a fence.
    static func stripCues(_ text: String) -> String {
        guard text.contains("{#") else { return text }
        var fence: (char: Character, length: Int)?
        return text.components(separatedBy: "\n").map { line in
            if let open = fence {
                if closes(line, open) { fence = nil }
                return line
            }
            if let marker = CueMarkers.fenceMarker(line) { fence = marker; return line }
            return line.replacingOccurrences(of: "[ \t]*" + CueMarkers.loosePattern, with: "", options: .regularExpression)
        }.joined(separator: "\n")
    }

    private static func closes(_ line: String, _ fence: (char: Character, length: Int)) -> Bool {
        guard let marker = CueMarkers.fenceMarker(line), marker.char == fence.char, marker.length >= fence.length
        else { return false }
        return line.trimmingCharacters(in: .whitespaces).count == marker.length
    }

    private static func isBlank(_ line: String) -> Bool { line.trimmingCharacters(in: .whitespaces).isEmpty }

    private static func trimBlankEdges(_ lines: [String]) -> [String] {
        var kept = lines[...]
        while let first = kept.first, isBlank(first) { kept = kept.dropFirst() }
        while let last = kept.last, isBlank(last) { kept = kept.dropLast() }
        return Array(kept)
    }
}
