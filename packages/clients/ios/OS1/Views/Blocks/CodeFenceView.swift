import SwiftStreamingMarkdown
import SwiftUI

/// An ordinary fenced code block: any fence no other block claims, with or
/// without a language. It wears the same well as the other code blocks
/// (`BlockWell`): the language on the left of a 32 pt header, Copy on the
/// right, and the code right under the hairline, unwrapped and scrolling
/// sideways. It replaces the markdown library's own code block, whose header
/// and code padding left a wide gap above the first line and can't be
/// configured.
///
/// Highlighting is HighlightSwift's GitHub theme through
/// `SyntaxHighlightedCodeText`, keyed on the fence's language (an alias
/// highlight.js doesn't know stays plain). A fence without one stays plain,
/// as it does on the web.
struct CodeFenceView: View {
    let lang: String
    let source: String

    var body: some View {
        BlockWell(label: lang.isEmpty ? nil : lang) {
            CopyBlockControl(text: source, accessibilityLabel: "Copy code", hold: .seconds(2))
        } content: {
            ScrollView(.horizontal) {
                SyntaxHighlightedCodeText(
                    text: Self.narrowIndent(source),
                    language: SyntaxHighlighting.language(forExtension: lang) ?? lang,
                    fallbackColor: OS1VisualStyle.text,
                    font: Self.font
                )
                .lineSpacing(Self.lineSpacing)
                .fixedSize(horizontal: true, vertical: true)
                .padding(.top, 8)
                .padding(.horizontal, 12)
                .padding(.bottom, 10)
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            .fixedSize(horizontal: false, vertical: true)
            // The scroll view's width settling would otherwise animate with
            // whatever transaction redrew the message.
            .transaction { $0.animation = nil }
        }
    }

    /// The code as drawn: each line's leading indent at half width (a tab
    /// or four spaces become two), since a reply column is narrow. Only the
    /// leading run changes; Copy still copies `source` as written.
    static func narrowIndent(_ code: String) -> String {
        code.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
            let lead = line.prefix { $0 == " " || $0 == "\t" }
            guard !lead.isEmpty else { return String(line) }
            let columns = lead.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
            return String(repeating: " ", count: (columns + 1) / 2) + line.dropFirst(lead.count)
        }.joined(separator: "\n")
    }

    /// The code font the markdown renderer already uses (15 pt on iOS,
    /// scaled with Dynamic Type; 12 pt on the Mac), so a fence keeps its size.
    private static var font: Font {
        Font(MarkdownRenderConfig.os1Base.inlineStyle.codeTextFont as CTFont)
    }

    /// Brings the line to the renderer's 20 pt on iOS.
    private static var lineSpacing: CGFloat {
        #if os(iOS)
        2
        #else
        3
        #endif
    }
}
