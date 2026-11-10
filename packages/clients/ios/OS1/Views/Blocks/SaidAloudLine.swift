import SwiftUI

/// A ```say fence in a transcript (`SayBlock`): what Blob said aloud, as one
/// quiet line above what the reply shows.
struct SaidAloudLine: View {
    let text: String

    var body: some View {
        (Text("Said aloud").fontWeight(.semibold).foregroundStyle(OS1VisualStyle.textFaint)
            + Text("  ") + Text(text).foregroundStyle(OS1VisualStyle.textDim))
            .font(.footnote)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel("Said aloud: \(text)")
    }
}
