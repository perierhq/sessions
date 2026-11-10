import CoreGraphics

/// What Blob tells the server about the space a reply will get, sent as
/// `surface` with every message (`OS1API.deliverPromptBody`). The server turns
/// it into a hint for the supervisor turn (blob-surface.ts, adrs/blob-views.md).
@MainActor
enum BlobSurfaceReport {
    private(set) static var current: [String: Any]? = ["app": "blob", "panes": 1, "width": "compact"]

    /// `panes` is what the home draws (`BlobPanes`): one on a phone, a closed
    /// Duo or the open Duo upright, two beside a vertical fold. Width is
    /// regular from 600 pt, as on the open Duo in either orientation.
    static func update(size: CGSize, panes: Int) {
        let wide = size.width >= 600
        current = ["app": "blob", "panes": panes, "width": wide ? "regular" : "compact"]
    }
}
