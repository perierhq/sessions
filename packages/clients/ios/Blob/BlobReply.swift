import Foundation

/// A supervisor reply split the way the server asks it to write one: the
/// first paragraph is what Blob says (read aloud and shown as its Say line),
/// everything after it is shown (drawn with the block catalog) and never read.
///
/// The first paragraph is the prose before the first blank line, fenced
/// block, heading, list or table. A reply that opens with a block has
/// nothing to say: `say` is empty and the whole reply is `show`.
///
/// Pure and Foundation-only, so it is the one place to change the rule.
/// No test target compiles `Blob/` (OS1Tests hosts the Mac app), so check
/// changes with a scratch `swiftc` run against the examples below:
///
///     "**Done.** All green.\n\n```metrics\n…```" → say "Done. All green.", show "```metrics\n…```"
///     "Two things:\n- one\n- two"               → say "Two things:", show "- one\n- two"
///     "```csv\n…```\n\nAfter."                  → say "", show the whole reply
struct BlobReply: Equatable {
    /// Plain text, emphasis and inline code markers stripped.
    var say: String
    /// Markdown for `MarkdownBody`; empty when the reply is one paragraph.
    var show: String

    var isEmpty: Bool { say.isEmpty && show.isEmpty }

    init(say: String, show: String) {
        self.say = say
        self.show = show
    }

    init(_ markdown: String) {
        let lines = markdown.components(separatedBy: "\n")
        var index = 0
        while index < lines.count, lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
            index += 1
        }
        var said: [String] = []
        while index < lines.count {
            let line = lines[index]
            if line.trimmingCharacters(in: .whitespaces).isEmpty || Self.startsBlock(line) { break }
            said.append(line.trimmingCharacters(in: .whitespaces))
            index += 1
        }
        say = Self.plain(said.joined(separator: " "))
        show = lines[index...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
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
