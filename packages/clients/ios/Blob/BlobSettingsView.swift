import AVFoundation
import SwiftUI

/// Long-press Blob: its voice, and the way to the server and account settings.
struct BlobSettingsView: View {
    let speaker: BlobSpeaker

    @AppStorage(BlobSpeaker.readAloudKey) private var readAloud = true
    @AppStorage(BlobSpeaker.voiceKey) private var voiceId = ""
    @AppStorage(BlobSpeaker.liveCallKey) private var liveCall = false
    @AppStorage(BlobTranscriber.key) private var transcriber = BlobTranscriber.parakeet.rawValue
    @AppStorage(BlobEndpointer.Wait.key) private var endWait = BlobEndpointer.Wait.normal.rawValue
    @State private var voices: [AVSpeechSynthesisVoice] = []
    @State private var modelError: String?
    /// How Blob reports, from the server's supervisor prefs. Nil hides the
    /// row: not loaded yet, or a server that doesn't have the setting.
    @State private var reportStyle: String?
    @State private var reportError: String?
    @State private var showAccount = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Toggle("Read answers aloud", isOn: $readAloud)
                } footer: {
                    Text("Blob listens on this phone, answers in text and can read it to you.")
                }

                transcriptionSection

                Section {
                    Picker("Wait after I stop", selection: $endWait) {
                        ForEach(BlobEndpointer.Wait.allCases) { wait in
                            Text(wait.name).tag(wait.rawValue)
                        }
                    }
                } footer: {
                    Text("Blob sends what you said once you pause this long. Tap Blob to send sooner.")
                }

                Section {
                    Toggle("Live call", isOn: $liveCall)
                } footer: {
                    Text("Talk to Blob over an OpenAI live call instead. Needs a voice key on your server and is paid per minute.")
                }

                if readAloud, let server = speaker.server, server.configured {
                    serverVoiceSection(server)
                } else if readAloud {
                    Section {
                        if voices.isEmpty {
                            Text("No Premium or Enhanced voices installed")
                                .foregroundStyle(OS1VisualStyle.textDim)
                        }
                        ForEach(voices, id: \.identifier) { voice in
                            Button {
                                voiceId = voice.identifier
                                speaker.preview(voice)
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(voice.name.replacingOccurrences(of: #" \((Premium|Enhanced)\)"#, with: "", options: .regularExpression))
                                            .foregroundStyle(OS1VisualStyle.text)
                                        Text("\(Locale.current.localizedString(forIdentifier: voice.language) ?? voice.language) \u{00B7} \(voice.quality == .premium ? "Premium" : "Enhanced")")
                                            .font(.footnote)
                                            .foregroundStyle(OS1VisualStyle.textDim)
                                    }
                                    Spacer()
                                    if voice.identifier == selectedId {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(OS1VisualStyle.accentInk)
                                    }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    } header: {
                        Text("Voice")
                    } footer: {
                        Text("Tap a voice to hear it. Download more in Settings \u{203A} Accessibility \u{203A} Spoken Content \u{203A} Voices. Apps can\u{2019}t use the current Siri voices. With no good voice for the answer\u{2019}s language, Blob stays silent.")
                    }
                }

                if let reportStyle {
                    reportSection(reportStyle)
                }

                Section {
                    Button("Server and account") { showAccount = true }
                }
            }
            .navigationTitle("Blob")
            .inlineTitleBarCompat()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        dismiss()
                    } label: {
                        Label("Done", systemImage: "checkmark").labelStyle(.iconOnly)
                    }
                }
            }
            .sheet(isPresented: $showAccount) { SettingsView() }
            .onAppear { voices = BlobSpeaker.goodVoices() }
            .task { await speaker.refreshServerVoice(force: true) }
            .task { reportStyle = try? await OS1API.supervisorPrefs().reportStyle }
            .onDisappear { speaker.stop() }
        }
    }

    private var transcriptionSection: some View {
        let parakeet = BlobParakeet.shared
        let fishAvailable = speaker.server?.transcribe == true
        return Section {
            transcriberRow(.parakeet, name: "Parakeet on this phone", detail: parakeetDetail(parakeet.state))
            if fishAvailable {
                transcriberRow(.fish, name: "Fish Audio", detail: "On your server, $0.36 per hour of audio")
            }
            transcriberRow(.apple, name: "Apple", detail: nil)
            if transcriber == BlobTranscriber.parakeet.rawValue {
                switch parakeet.state {
                case .absent, .failed:
                    Button("Download Parakeet (\(BlobParakeet.sizeLabel))") { parakeet.download() }
                case .downloading(let fraction):
                    ProgressView(value: fraction) {
                        Text("Downloading\u{2026} \(Int(fraction * 100))%")
                            .font(.footnote)
                            .foregroundStyle(OS1VisualStyle.textDim)
                    }
                default:
                    EmptyView()
                }
            }
        } header: {
            Text("Transcription")
        } footer: {
            if case .failed(let message) = parakeet.state {
                Text(message)
            } else {
                Text("Parakeet hears Polish and English on this phone. Until it has downloaded, Blob uses \(fishAvailable ? "Fish Audio" : "Apple"). Live captions always come from Apple.")
            }
        }
    }

    private func parakeetDetail(_ state: BlobParakeet.State) -> String {
        switch state {
        case .absent, .failed: "Not downloaded, \(BlobParakeet.sizeLabel)"
        case .downloading: "Downloading"
        case .downloaded, .loading, .ready: "Downloaded"
        }
    }

    private func transcriberRow(_ choice: BlobTranscriber, name: String, detail: String?) -> some View {
        let selected = transcriber == choice.rawValue
        return Button {
            transcriber = choice.rawValue
            if choice == .parakeet { BlobParakeet.shared.warm() }
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                        .foregroundStyle(OS1VisualStyle.text)
                    if let detail {
                        Text(detail)
                            .font(.footnote)
                            .foregroundStyle(OS1VisualStyle.textDim)
                    }
                }
                Spacer()
                if selected {
                    Image(systemName: "checkmark")
                        .foregroundStyle(OS1VisualStyle.accentInk)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// Fish Audio models the server accepts, best first.
    private static let serverModels = [
        (id: "s2.1-pro", name: "Best quality"),
        (id: "s2.1-pro-free", name: "Free"),
    ]

    private func serverVoiceSection(_ server: OS1API.BlobSpeechStatus) -> some View {
        let current = server.model ?? "s2.1-pro"
        return Section {
            ForEach(Self.serverModels, id: \.id) { model in
                Button {
                    guard model.id != current else { return }
                    Task {
                        do {
                            try await speaker.setServerModel(model.id)
                            modelError = nil
                        } catch {
                            modelError = error.localizedDescription
                        }
                    }
                } label: {
                    HStack {
                        Text(model.name)
                            .foregroundStyle(OS1VisualStyle.text)
                        Spacer()
                        if model.id == current {
                            Image(systemName: "checkmark")
                                .foregroundStyle(OS1VisualStyle.accentInk)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        } header: {
            Text("Voice \u{00B7} Fish Audio")
        } footer: {
            if let modelError {
                Text(modelError)
            } else {
                Text("Free requests may be used by Fish to train its models.")
            }
        }
    }

    /// Report styles the server accepts.
    private static let reportStyles = [
        (id: "bluf", name: "Bottom line first"),
        (id: "sbar", name: "SBAR"),
        (id: "plain", name: "Plain"),
    ]

    private func reportSection(_ current: String) -> some View {
        Section {
            ForEach(Self.reportStyles, id: \.id) { style in
                Button {
                    guard style.id != current else { return }
                    reportStyle = style.id
                    Task {
                        do {
                            let prefs = try await OS1API.setSupervisorReportStyle(style.id)
                            reportStyle = prefs.reportStyle ?? style.id
                            reportError = nil
                        } catch {
                            reportStyle = current
                            reportError = error.localizedDescription
                        }
                    }
                } label: {
                    HStack {
                        Text(style.name)
                            .foregroundStyle(OS1VisualStyle.text)
                        Spacer()
                        if style.id == current {
                            Image(systemName: "checkmark")
                                .foregroundStyle(OS1VisualStyle.accentInk)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(style.id == current ? .isSelected : [])
            }
        } header: {
            Text("How Blob reports")
        } footer: {
            if let reportError {
                Text(reportError)
            } else {
                Text("Bottom line first leads with the answer. SBAR gives situation, background, assessment and a recommendation.")
            }
        }
    }

    private var selectedId: String? {
        voiceId.isEmpty ? BlobSpeaker.selectedVoice()?.identifier : voiceId
    }
}
