import SwiftUI

extension View {
    /// Every sheet Blob presents. On the open iPhone Duo it sits on the
    /// trailing edge, where the system gives it a vertical bar: its Close and
    /// other toolbar items sit in the strip below the status icons, not
    /// inside the sheet. Elsewhere (other iPhones, older systems, the Mac)
    /// the sheet presents as it always did, with `detents` if given.
    func blobSheetPlacement(detents: Set<PresentationDetent>? = nil) -> some View {
        modifier(BlobSheetPlacement(detents: detents))
    }
}

/// `presentationPlacement` exists from iOS 27.0 in the SDK; vertical bars
/// come with 27.1, so the trailing placement waits for that too. The
/// explicit large detent is what puts Close below the status icons: without
/// one, a trailing sheet's bar starts under them and hides Close, and a
/// medium detent drops the vertical bar altogether (both seen on the iOS
/// 27.2 Duo simulator).
private struct BlobSheetPlacement: ViewModifier {
    let detents: Set<PresentationDetent>?

    func body(content: Content) -> some View {
        #if os(iOS)
        if #available(iOS 27.1, *) {
            content
                .presentationPlacement(.trailing)
                .presentationDetents([.large])
        } else if let detents {
            content.presentationDetents(detents)
        } else {
            content
        }
        #else
        content
        #endif
    }
}

/// `BLOB_DEMO_SHEET=settings|account|steps|connect` presents that sheet at
/// launch in debug builds, for screenshots of where a sheet and its toolbar
/// go. `account` opens "Server and account" on top of Settings; `steps`
/// wants `BLOB_DEMO_THINKING=1` for something to list; `connect` opens More
/// options on the first-run screen, so it needs a device with no server.
enum BlobDemoSheet: String {
    case settings, account, steps, connect

    static let current: BlobDemoSheet? = {
        #if DEBUG
        return ProcessInfo.processInfo.environment["BLOB_DEMO_SHEET"].flatMap(Self.init)
        #else
        return nil
        #endif
    }()
}

extension View {
    /// Calls `show` once, a second after the app comes to the front, when
    /// `BLOB_DEMO_SHEET` names one of `sheets`. A sheet asked for before the
    /// window is on screen never appears, and a cold launch on the simulator
    /// can take several seconds to get there.
    func blobDemoSheet(_ sheets: BlobDemoSheet..., show: @escaping () -> Void) -> some View {
        modifier(BlobDemoSheetTrigger(sheets: sheets, show: show))
    }
}

private struct BlobDemoSheetTrigger: ViewModifier {
    let sheets: [BlobDemoSheet]
    let show: () -> Void
    @Environment(\.scenePhase) private var scenePhase
    @State private var shown = false

    func body(content: Content) -> some View {
        content.task(id: scenePhase) {
            guard !shown, scenePhase == .active,
                  let current = BlobDemoSheet.current, sheets.contains(current) else { return }
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            shown = true
            show()
        }
    }
}
