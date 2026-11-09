import SwiftUI

/// First run: Blob asks where it lives, checks the server as you type, then
/// signs in with GitHub's device flow (`GitHubSignIn`, the same one the OS app
/// uses). Type the host, one tap, approve on GitHub. The rest of the OS
/// connection form (token paste, Tailscale, name) sits under More options.
struct BlobConnectView: View {
    /// Called once the hello has been said, to hand over to the home screen.
    let onFinish: () -> Void

    private enum Probe: Equatable {
        case idle, checking, found(host: String), failed(String)
    }

    @State private var config = ServerConfig.shared
    @State private var signIn = GitHubSignIn.shared
    @State private var host = ""
    @State private var probe: Probe = .idle
    @State private var copied = false
    @State private var connected = false
    @State private var showOptions = false
    @State private var physics = BlobPhysics()
    @FocusState private var fieldFocused: Bool
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 14) {
            Spacer(minLength: 24)
            blob
            heading
            Spacer(minLength: 24)
            controls
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 20)
        .frame(maxWidth: 420)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(OS1VisualStyle.background.ignoresSafeArea())
        .animation(reduceMotion ? nil : .easeOut(duration: 0.24), value: stepKey)
        .sheet(isPresented: $showOptions) { SettingsView() }
        .onAppear {
            host = Self.displayHost(config.baseURLString)
            if host.isEmpty { fieldFocused = true }
        }
        .task(id: host) { await check() }
        .onChange(of: scenePhase) { _, phase in
            // You were probably just in Safari approving the code.
            if phase == .active { signIn.nudge() }
        }
        .onChange(of: config.isConfigured) { _, configured in
            guard configured, !connected else { return }
            connected = true
            Task {
                try? await Task.sleep(for: .seconds(1.6))
                onFinish()
            }
        }
    }

    // MARK: Pieces

    private var blob: some View {
        TimelineView(.animation(paused: scenePhase != .active)) { timeline in
            Canvas { context, size in
                physics.advance(to: timeline.date, targets: BlobTargets(
                    mode: mode,
                    position: CGPoint(x: size.width / 2, y: size.height / 2),
                    size: connected ? 120 : signIn.flow != nil ? 80 : 96,
                    look: signIn.flow != nil ? CGPoint(x: size.width / 2, y: size.height + 400) : nil,
                    level: 0
                ))
                physics.draw(in: &context, dark: colorScheme == .dark, reduceMotion: reduceMotion)
            }
        }
        .frame(height: 170)
        .accessibilityHidden(true)
    }

    private var mode: BlobMode {
        if connected { return .speak }
        if signIn.starting || probe == .checking { return .think }
        if signIn.flow != nil { return .think }
        if case .found = probe { return .listen }
        return .quiet
    }

    private var heading: some View {
        VStack(spacing: 6) {
            Text(title)
                .font(.title2.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.text)
            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(OS1VisualStyle.textDim)
        }
        .multilineTextAlignment(.center)
    }

    private var title: String {
        if connected {
            let name = config.userName.split(separator: " ").first.map(String.init) ?? ""
            return name.isEmpty ? "Hi." : "Hi \(name)."
        }
        if signIn.flow != nil { return "Approve me on GitHub" }
        if case .found = probe { return "Found it." }
        return "Where do I live?"
    }

    private var subtitle: String {
        if connected { return "I\u{2019}ll be here when something needs you." }
        if signIn.flow != nil { return "Paste this code when GitHub asks" }
        switch probe {
        case .found(let host): return "\(host) answers"
        case .failed(let reason): return reason
        default: return "The address of your Sessions server"
        }
    }

    /// Changes whenever the screen moves to another step, to animate it.
    private var stepKey: String {
        connected ? "done" : signIn.flow != nil ? "code" : "\(probe)"
    }

    @ViewBuilder
    private var controls: some View {
        if connected {
            Color.clear.frame(height: 50)
        } else if let flow = signIn.flow {
            codeStep(flow)
        } else {
            serverStep
        }
    }

    private var serverStep: some View {
        VStack(spacing: 12) {
            HStack(spacing: 10) {
                TextField("sessions.example.com", text: $host)
                    .font(.body)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .focused($fieldFocused)
                    .onSubmit { if canSignIn { startSignIn() } }
                probeMark
            }
            .padding(.horizontal, 16)
            .frame(height: 52)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(OS1VisualStyle.hover))

            if let error = signIn.error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .multilineTextAlignment(.center)
            }

            primaryButton(signIn.starting ? "Starting\u{2026}" : canSignIn ? "Sign in with GitHub" : "Continue", enabled: canSignIn && !signIn.starting) {
                startSignIn()
            }

            Button("More options") { showOptions = true }
                .font(.subheadline.weight(.medium))
                .foregroundStyle(OS1VisualStyle.textDim)
                .padding(.vertical, 6)
        }
    }

    @ViewBuilder
    private var probeMark: some View {
        switch probe {
        case .checking:
            Text("Checking\u{2026}").font(.footnote).foregroundStyle(OS1VisualStyle.textFaint)
        case .found:
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 20))
                .foregroundStyle(.green)
                .accessibilityLabel("Server found")
        default:
            EmptyView()
        }
    }

    private func codeStep(_ flow: GitHubAuth.DeviceFlowStart) -> some View {
        VStack(spacing: 12) {
            Button {
                copy(flow.userCode)
            } label: {
                Text(flow.userCode)
                    .font(.system(size: 30, weight: .semibold, design: .monospaced))
                    .kerning(3)
                    .foregroundStyle(OS1VisualStyle.text)
                    .frame(maxWidth: .infinity)
                    .frame(height: 72)
                    .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(OS1VisualStyle.hover))
            }
            .buttonStyle(.plain)
            .accessibilityHint("Copies the code")

            primaryButton(copied ? "Open GitHub again" : "Copy code and open GitHub", enabled: true) {
                copy(flow.userCode)
                if let url = URL(string: flow.verificationUri) { openURL(url) }
            }

            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(copied ? "Copied. Waiting for you" : "Waiting for you")
                    .font(.subheadline)
                    .foregroundStyle(OS1VisualStyle.textDim)
                Text("\u{00B7}").foregroundStyle(OS1VisualStyle.textFaint)
                Button("Cancel") { signIn.cancel(); copied = false }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(OS1VisualStyle.textDim)
            }
            .padding(.vertical, 6)
        }
    }

    private func primaryButton(_ title: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.body.weight(.medium))
                .foregroundStyle(enabled ? Color.white : OS1VisualStyle.textFaint)
                .frame(maxWidth: .infinity)
                .frame(height: 50)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(enabled ? AnyShapeStyle(OS1VisualStyle.accentInk) : AnyShapeStyle(OS1VisualStyle.hover))
                )
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }

    // MARK: Behaviour

    private var canSignIn: Bool {
        if case .found = probe { return true }
        return false
    }

    private func startSignIn() {
        guard let url = Self.normalized(host) else { return }
        fieldFocused = false
        config.baseURLString = url.absoluteString
        signIn.start()
    }

    private func copy(_ code: String) {
        #if os(iOS)
        UIPasteboard.general.string = code
        #endif
        copied = true
    }

    /// Debounced check that a Sessions server answers at the typed address:
    /// `GET /api/auth/status` needs no token and every server has it.
    private func check() async {
        guard let url = Self.normalized(host) else { probe = .idle; return }
        try? await Task.sleep(for: .milliseconds(450))
        guard !Task.isCancelled else { return }
        probe = .checking
        var request = URLRequest(url: url.appending(path: "api/auth/status"))
        request.timeoutInterval = 5
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard !Task.isCancelled else { return }
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                probe = .found(host: url.host() ?? host)
            } else {
                probe = .failed("Something answers there, but it isn\u{2019}t a Sessions server")
            }
        } catch {
            guard !Task.isCancelled else { return }
            probe = .failed("Nothing answers at that address yet")
        }
    }

    /// `sessions.pl` → `https://sessions.pl`, matching how the OS app reads it.
    static func normalized(_ raw: String) -> URL? {
        var trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard trimmed.contains("."), !trimmed.contains(" ") else { return nil }
        if !trimmed.contains("://") { trimmed = "https://" + trimmed }
        guard let url = URL(string: trimmed), url.host() != nil else { return nil }
        return url
    }

    /// Show a saved server the way you would type it.
    private static func displayHost(_ saved: String) -> String {
        guard let url = normalized(saved), !["127.0.0.1", "localhost"].contains(url.host() ?? "") else { return "" }
        return url.scheme == "https" ? (url.host() ?? "") + url.path() : saved
    }
}
