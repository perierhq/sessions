import CoreGraphics

/// What Blob tells the server about the space a reply will get, sent as
/// `surface` with every message (`OS1API.deliverPromptBody`). The server turns
/// it into a hint for the supervisor turn (blob-surface.ts, adrs/blob-views.md).
@MainActor
enum BlobSurfaceReport {
    private(set) static var current: [String: Any]? = ["app": "blob", "panes": 1, "width": "compact"]

    /// One pane on a phone or a closed Duo, two on the open Duo's inner
    /// display, which is regular width in either orientation.
    static func update(size: CGSize) {
        let wide = size.width >= 600
        current = ["app": "blob", "panes": wide ? 2 : 1, "width": wide ? "regular" : "compact"]
    }
}
