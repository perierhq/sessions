import SwiftUI

/// Blob: the quiet app where the supervisor agent shows up only when it has
/// something for you. It compiles the OS app's sources (networking, models, the
/// Desk voice engine, settings) with the `BLOB` condition and replaces only the
/// app entry point and the root view.
@main
struct BlobApp: App {
    init() {
        CrashReporter.shared.install()
    }

    var body: some Scene {
        WindowGroup {
            BlobRoot()
        }
    }
}

private struct BlobRoot: View {
    @AppStorage("os1.appearance") private var appearance = "system"
    @State private var config = ServerConfig.shared
    @State private var authGate = AuthGate.shared

    var body: some View {
        BlobHomeView()
            .id(config.activeId)
            .tint(OS1VisualStyle.accentInk)
            // The server is refusing this device, so there is nothing to talk
            // to until the sign-in lands. Same cover the OS app uses.
            .overlay {
                if let reason = authGate.blocked {
                    ReconnectCover(reason: reason)
                        .transition(.opacity)
                }
            }
            .preferredColorScheme(appearance == "light" ? .light : appearance == "dark" ? .dark : nil)
            .task(id: config.activeId) {
                // Crash reports from a launch with no server go up once there is one.
                if config.isConfigured { await CrashReporter.shared.flush() }
            }
    }
}
