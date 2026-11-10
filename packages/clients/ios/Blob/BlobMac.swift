#if os(macOS)
import AppKit
import SwiftUI

/// What the menu bar item shows, and what its menus ask the home to do. The
/// home writes Blob's state here; the menu bar reads it even while the
/// window is closed.
@MainActor
@Observable
final class BlobMacState {
    static let shared = BlobMacState()

    enum Request: Equatable { case write, history, settings }

    var mode: BlobMode = .quiet
    var status = "Asleep"
    var waiting = 0
    /// Set by a menu command, cleared by the home once handled.
    var request: Request?
}

/// Blob for Mac: one small window with the home, a menu bar item with Blob's
/// face, and menu commands for the keyboard.
struct BlobMacScenes: Scene {
    static let windowId = "blob"
    @State private var state = BlobMacState.shared

    var body: some Scene {
        Window("Blob", id: Self.windowId) {
            BlobRoot()
                .frame(minWidth: 360, idealWidth: 420, minHeight: 480, idealHeight: 620)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 420, height: 620)
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(replacing: .appSettings) {
                Button("Settings\u{2026}") { state.request = .settings }
                    .keyboardShortcut(",")
            }
            CommandMenu("Blob") {
                Button("Write to Blob") { state.request = .write }
                    .keyboardShortcut("l")
                Button("Show history") { state.request = .history }
                    .keyboardShortcut("y")
            }
        }

        MenuBarExtra {
            BlobMenu(state: state)
        } label: {
            Image(nsImage: BlobMenuFace.image(awake: state.mode != .quiet || state.waiting > 0))
                .accessibilityLabel(state.waiting > 0 ? "Blob, \(BlobMenu.waitingLine(state.waiting))" : "Blob")
        }
    }
}

/// The menu under Blob's face: what it is doing, what is waiting, and a way
/// back to the window.
private struct BlobMenu: View {
    let state: BlobMacState
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Text(state.status)
        Text(Self.waitingLine(state.waiting))
        Divider()
        Button("Open Blob") {
            openWindow(id: BlobMacScenes.windowId)
            NSApp.activate()
        }
        .keyboardShortcut("o")
        Divider()
        Button("Quit Blob") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }

    static func waitingLine(_ count: Int) -> String {
        switch count {
        case 0: "Nothing waiting"
        case 1: "1 decision waiting"
        default: "\(count) decisions waiting"
        }
    }
}

/// Blob's face for the menu bar, as a template image so it follows the menu
/// bar's colour: eyes closed while asleep, open when awake or when something
/// is waiting.
enum BlobMenuFace {
    static func image(awake: Bool) -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
            let body = NSBezierPath(ovalIn: rect.insetBy(dx: 1.5, dy: 2))
            NSColor.black.setFill()
            body.fill()
            NSGraphicsContext.current?.compositingOperation = .clear
            if awake {
                NSBezierPath(ovalIn: NSRect(x: 6, y: 7.5, width: 2, height: 3.5)).fill()
                NSBezierPath(ovalIn: NSRect(x: 10, y: 7.5, width: 2, height: 3.5)).fill()
            } else {
                NSBezierPath(roundedRect: NSRect(x: 5.5, y: 8.5, width: 3, height: 1.2), xRadius: 0.6, yRadius: 0.6).fill()
                NSBezierPath(roundedRect: NSRect(x: 9.5, y: 8.5, width: 3, height: 1.2), xRadius: 0.6, yRadius: 0.6).fill()
            }
            return true
        }
        image.isTemplate = true
        return image
    }
}

/// Keeps Blob in the menu bar after its window closes.
final class BlobMacAppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

/// Space and Esc on the home, which have no menu command: Space talks while
/// nothing is being typed, Esc stops Blob reading or hides history. Returns
/// the event when the home leaves it alone.
struct BlobMacKeys: ViewModifier {
    let space: () -> Bool
    let escape: () -> Bool
    @State private var monitor: Any?

    func body(content: Content) -> some View {
        content
            .onAppear {
                guard monitor == nil else { return }
                monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                    guard let window = event.window, window.isKeyWindow, window.attachedSheet == nil,
                          event.modifierFlags.intersection([.command, .control, .option]).isEmpty
                    else { return event }
                    switch event.keyCode {
                    case 49:
                        // Space types a space in any text field.
                        if window.firstResponder is NSText { return event }
                        return space() ? nil : event
                    case 53:
                        return escape() ? nil : event
                    default:
                        return event
                    }
                }
            }
            .onDisappear {
                if let monitor { NSEvent.removeMonitor(monitor) }
                monitor = nil
            }
    }
}
#endif
