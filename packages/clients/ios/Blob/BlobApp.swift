import SwiftUI

/// Blob: the quiet app where the supervisor agent shows up only when it has
/// something for you. It compiles the OS app's sources (networking, models, the
/// Desk voice engine, settings) with the `BLOB` condition and replaces only the
/// app entry point and the root view.
@main
struct BlobApp: App {
    #if os(macOS)
    @NSApplicationDelegateAdaptor(BlobMacAppDelegate.self) private var delegate
    #endif

    init() {
        CrashReporter.shared.install()
        Task.detached(priority: .utility) { BlobParakeet.excludeFromBackup() }
    }

    var body: some Scene {
        #if os(macOS)
        BlobMacScenes()
        #else
        WindowGroup {
            BlobRoot()
        }
        #endif
    }
}

struct BlobRoot: View {
    @AppStorage("os1.appearance") private var appearance = "system"
    @State private var config = ServerConfig.shared
    @State private var authGate = AuthGate.shared
    @State private var connecting = !ServerConfig.shared.isConfigured && !Self.demoHome
    @Environment(\.scenePhase) private var scenePhase

    /// Demo decisions, history and replies need no server, so they go
    /// straight to the home.
    private static var demoHome: Bool {
        #if DEBUG
        let env = ProcessInfo.processInfo.environment
        return BlobDecisions.demoEnabled || env["BLOB_DEMO_HISTORY"] != nil || env["BLOB_DEMO_REPLY"] != nil
            || env["BLOB_DEMO_REPLY_FILE"] != nil || env["BLOB_DEMO_THINKING"] != nil
            || env["BLOB_DEMO_HEARD"] != nil
            || (BlobDemoSheet.current != nil && BlobDemoSheet.current != .connect)
        #else
        false
        #endif
    }

    var body: some View {
        Group {
            if connecting {
                BlobConnectView { withAnimation(.easeOut(duration: 0.3)) { connecting = false } }
                    .transition(.opacity)
            } else {
                BlobHomeView()
                    .transition(.opacity)
            }
        }
            .id(config.activeId)
            .tint(OS1VisualStyle.accentInk)
            // Callouts, quick replies and links take Blob's look.
            .environment(\.markdownLook, .blob)
            // The server is refusing this device, so there is nothing to talk
            // to until the sign-in lands. Same cover the OS app uses.
            .overlay {
                if let reason = authGate.blocked {
                    ReconnectCover(reason: reason)
                        .transition(.opacity)
                }
            }
            .preferredColorScheme(appearance == "light" ? .light : appearance == "dark" ? .dark : nil)
            // Parakeet loads at launch and whenever the app is back in front,
            // so it is ready before you talk; in the background it stays
            // loaded for a while (`BlobParakeet.appBackgrounded`).
            .onChange(of: scenePhase, initial: true) { _, phase in
                switch phase {
                case .active: BlobParakeet.shared.appActive()
                case .background: BlobParakeet.shared.appBackgrounded()
                default: break
                }
            }
            .onChange(of: config.isConfigured) { _, configured in
                if !configured { connecting = true }
            }
            .task(id: config.activeId) {
                // Crash reports from a launch with no server go up once there is one.
                if config.isConfigured { await CrashReporter.shared.flush() }
                // The accent is the person's, set in Sessions; Blob follows it,
                // and again whenever it comes back to the front.
                await AccentStore.shared.hydrate()
                for await _ in NotificationCenter.default.notifications(
                    named: AppLifecycle.didBecomeActiveNotification
                ) {
                    await AccentStore.shared.hydrate()
                }
            }
    }
}
