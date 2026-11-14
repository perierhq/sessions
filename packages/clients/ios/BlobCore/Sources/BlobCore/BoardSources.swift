import Foundation

/// Where a board image may load from: this server's own media routes, as
/// same-origin paths (server: shared/blob-board.ts `isBoardImageSource`).
/// The app checks again before it fetches, so a board never makes the app
/// load a URL the model wrote.
public enum BoardImageSource {
    public static func isAllowed(_ src: String) -> Bool {
        guard src.count <= 2_048 else { return false }
        if src.hasPrefix("/media?") { return isOwnMedia(src) }
        return routes.contains { src.range(of: $0, options: .regularExpression) != nil }
    }

    private static let routes: [String] = [
        // routes/plain.ts: a Plain thread's attachment.
        #"^/api/plain/attachments/[A-Za-z0-9_-]{1,120}$"#,
        // routes/support.ts: an email conversation's attachment.
        #"^/api/support/conversations/[A-Za-z0-9_-]{1,120}/attachments/[A-Za-z0-9_-]{1,120}$"#,
        // routes/media.ts: a GitHub user attachment of a registered repo.
        #"^/gh-asset/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\?repo=[A-Za-z0-9._-]{1,120}$"#,
    ]

    /// `/media?path=<absolute path>` (an optional `v`), no traversal.
    private static func isOwnMedia(_ src: String) -> Bool {
        guard let components = URLComponents(string: "http://board.invalid" + src),
              components.path == "/media",
              let items = components.queryItems,
              items.allSatisfy({ $0.name == "path" || $0.name == "v" })
        else { return false }
        let path = items.first(where: { $0.name == "path" })?.value ?? ""
        return path.hasPrefix("/") && !path.hasPrefix("//") && !path.contains("..")
            && !path.contains(where: \.isWhitespace)
    }
}

/// The ` ```canvas ` fence a reply carries after its say fence: the board
/// revision the reply showed, then the board as plain text (server:
/// `canvasFence`, docs/blocks.md "Blob's board"). Blob draws that revision
/// instead of the fence.
public enum CanvasFence {
    /// The revision named by the first closed canvas fence, or nil.
    public static func revision(in markdown: String) -> Int? {
        for fence in fences(in: markdown) {
            if let revision = fence.revision { return revision }
        }
        return nil
    }

    /// `markdown` without its canvas fences (closed or still open), so the
    /// plain-text fallback never shows where the board itself is drawn.
    public static func removing(from markdown: String) -> String {
        let lines = markdown.components(separatedBy: "\n")
        let ranges = fences(in: markdown).map(\.lines)
        guard !ranges.isEmpty else { return markdown }
        var kept: [String] = []
        for (index, line) in lines.enumerated() where !ranges.contains(where: { $0.contains(index) }) {
            kept.append(line)
        }
        return kept.joined(separator: "\n")
            .replacingOccurrences(of: "\n\n\n+", with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    struct Fence {
        var lines: ClosedRange<Int>
        var revision: Int?
    }

    static func fences(in markdown: String) -> [Fence] {
        let lines = markdown.components(separatedBy: "\n")
        var out: [Fence] = []
        var index = 0
        while index < lines.count {
            guard let open = marker(lines[index]) else { index += 1; continue }
            let info = lines[index].trimmingCharacters(in: .whitespaces).dropFirst(open.length)
            let lang = info.split(whereSeparator: \.isWhitespace).first.map { $0.lowercased() } ?? ""
            var end = index + 1
            while end < lines.count {
                if let close = marker(lines[end]), close.char == open.char, close.length >= open.length,
                   lines[end].trimmingCharacters(in: .whitespaces).count == close.length { break }
                end += 1
            }
            if lang == "canvas" {
                let closed = end < lines.count
                let body = lines[(index + 1)..<min(end, lines.count)]
                let first = body.first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty })
                out.append(Fence(lines: index...min(end, lines.count - 1), revision: closed ? first.flatMap(revisionLine) : nil))
            }
            index = end + 1
        }
        return out
    }

    /// `revision: 43` → 43.
    static func revisionLine(_ line: String) -> Int? {
        let s = line.trimmingCharacters(in: .whitespaces)
        guard s.hasPrefix("revision:") else { return nil }
        let digits = s.dropFirst("revision:".count).trimmingCharacters(in: .whitespaces)
        guard !digits.isEmpty, digits.count <= 9, digits.allSatisfy(\.isASCIIDigit), let n = Int(digits), n >= 1
        else { return nil }
        return n
    }

    static func marker(_ line: String) -> (char: Character, length: Int)? {
        let s = line.trimmingCharacters(in: .whitespaces)
        guard let first = s.first, first == "`" || first == "~" else { return nil }
        let length = s.prefix(while: { $0 == first }).count
        return length >= 3 ? (first, length) : nil
    }
}

private extension Character {
    var isASCIIDigit: Bool { isASCII && isNumber }
}
