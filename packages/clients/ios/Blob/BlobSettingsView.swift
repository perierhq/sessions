import AVFoundation
import SwiftUI

/// Long-press Blob: its voice, and the way to the server and account settings.
struct BlobSettingsView: View {
    let speaker: BlobSpeaker

    @AppStorage(BlobSpeaker.readAloudKey) private var readAloud = true
    @AppStorage(BlobSpeaker.voiceKey) private var voiceId = ""
    @AppStorage(BlobSpeaker.liveCallKey) private var liveCall = false
    @State private var voices: [AVSpeechSynthesisVoice] = []
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

                Section {
                    Toggle("Live call", isOn: $liveCall)
                } footer: {
                    Text("Talk to Blob over an OpenAI live call instead. Needs a voice key on your server and is paid per minute.")
                }

                if readAloud {
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

                Section {
                    Button("Server and account") { showAccount = true }
                }
            }
            .navigationTitle("Blob")
            .navigationBarTitleDisplayMode(.inline)
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
            .onDisappear { speaker.stop() }
        }
    }

    private var selectedId: String? {
        voiceId.isEmpty ? BlobSpeaker.selectedVoice()?.identifier : voiceId
    }
}
