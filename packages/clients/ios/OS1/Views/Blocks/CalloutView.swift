import SwiftUI

/// A GitHub callout: a titled block in its kind's ink with an icon and a
/// bar down the left, the body as ordinary markdown.
///
/// Blob (`markdownLook == .blob`) draws it as its Callout board does: a
/// quiet inset with the kind's glyph and no title or border. A warning or
/// caution is warm, unless another one in the reply already is (`strong`
/// false): a reply has at most one.
struct CalloutView: View {
    let callout: Callout
    var dimmed = false
    var strong = true

    @Environment(\.markdownLook) private var look

    var body: some View {
        if look == .blob {
            BlobCallout(callout: callout, strong: strong)
        } else {
            transcript
        }
    }

    private var transcript: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: symbol)
                    .font(.footnote.weight(.semibold))
                Text(callout.kind.title)
                    .font(.footnote.weight(.semibold))
            }
            .foregroundStyle(ink)
            if !callout.body.isEmpty {
                MarkdownBody(callout.body, dimmed: dimmed, richBlocks: false)
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ink.opacity(0.07), in: BlockChrome.shape)
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(ink)
                .frame(width: 3)
                .clipShape(BlockChrome.shape)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(callout.kind.title)
    }

    private var ink: Color {
        switch callout.kind {
        case .note: OS1VisualStyle.blueInk
        case .tip: OS1VisualStyle.greenInk
        case .important: OS1VisualStyle.purpleInk
        case .warning: OS1VisualStyle.yellowInk
        case .caution: OS1VisualStyle.redInk
        }
    }

    private var symbol: String {
        switch callout.kind {
        case .note: "info.circle"
        case .tip: "lightbulb"
        case .important: "exclamationmark.bubble"
        case .warning: "exclamationmark.triangle"
        case .caution: "octagon"
        }
    }
}

/// A callout the way Blob draws it (see `CalloutView`).
private struct BlobCallout: View {
    let callout: Callout
    let strong: Bool

    @ScaledMetric(relativeTo: .footnote) private var size: CGFloat = 13

    private var warm: Bool { strong && (callout.kind == .warning || callout.kind == .caution) }

    var body: some View {
        let ink = warm ? OS1VisualStyle.yellowInk : OS1VisualStyle.textNarration
        let text = AttributedString.inlineMarkdown(Self.paragraphs(callout.body))
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: size, weight: .medium))
                .accessibilityHidden(true)
            Text(text)
                .font(.system(size: size))
                .lineSpacing(size * 3 / 13)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(ink)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            warm ? OS1VisualStyle.yellow.opacity(0.15) : OS1VisualStyle.chipFill,
            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(callout.kind.title): \(String(text.characters))")
    }

    private var symbol: String {
        switch callout.kind {
        case .note: "info.circle"
        case .tip: "lightbulb"
        case .important: "exclamationmark.circle"
        case .warning: "exclamationmark.triangle"
        case .caution: "exclamationmark.octagon"
        }
    }

    /// The body's lines joined into paragraphs, a blank line between two.
    static func paragraphs(_ body: String) -> String {
        body.components(separatedBy: "\n\n")
            .map { $0.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: " ") }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
    }
}
