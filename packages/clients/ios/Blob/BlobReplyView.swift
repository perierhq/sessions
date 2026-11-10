import SwiftUI

/// What Blob says, as a line of plain text at 17/22: the part of a reply or
/// a decision it reads aloud.
struct BlobSayLine: View {
    let text: String

    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 17

    var body: some View {
        Text(text)
            .font(.system(size: size))
            .lineSpacing(size * 5 / 17)
            .foregroundStyle(OS1VisualStyle.text)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// A reply split into what Blob says and what it shows (`BlobReply`): the
/// Say line, then the rest drawn with the block catalog. While the reply is
/// still streaming the rest stays plain text.
struct BlobReplyView: View {
    let reply: BlobReply
    var entryId: String?
    var relay: QuickReplyRelay?
    var streaming = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !reply.say.isEmpty {
                BlobSayLine(text: reply.say)
            }
            if !reply.show.isEmpty {
                if streaming {
                    Text(reply.show)
                        .font(.body)
                        .foregroundStyle(OS1VisualStyle.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    MarkdownBody(reply.show)
                        .environment(\.quickReplyRelay, relay)
                        .environment(\.transcriptEntryId, entryId)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
