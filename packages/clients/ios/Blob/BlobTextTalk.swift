import Foundation
import Observation

/// Talking to Blob when the server has no voice key: you speak, on-device
/// dictation (`Dictation`) turns it into text, the text goes to the Desk like a
/// typed message, and Blob answers in text instead of speaking.
///
/// The live voice call needs an OpenAI key on the server
/// (`GET /api/desk/voice/status` reports it). Without one, this keeps the same
/// tap-to-talk feel with nothing leaving the phone except the message itself.
@MainActor
@Observable
final class BlobTextTalk {
    enum Phase: Equatable { case idle, listening, waiting, failed(String) }

    private(set) var phase: Phase = .idle
    /// What you said, as dictation hears it.
    private(set) var heard = ""
    private let dictation = Dictation()
    private var desk: SessionViewModel?
    private let owner = UUID()
    /// Transcript size when the message went out; the answer is what comes after.
    private var sentAt = 0

    var active: Bool { phase != .idle }
    var level: Double { phase == .listening ? Double(dictation.levels.last ?? 0) : 0 }

    /// Blob's answer so far: streaming text while the Desk writes, then the
    /// finished reply.
    var answer: String? {
        guard let desk, phase == .waiting else { return nil }
        if desk.isStreaming, !desk.liveText.isEmpty { return desk.liveText }
        let reply = desk.entries.dropFirst(sentAt).last { $0.type == "assistant" && $0.isReasoning != true }
        return reply?.content.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// True while the Desk is still working on the answer.
    var thinking: Bool { phase == .waiting && (desk?.isRunning ?? true) && answer == nil }

    /// Tap: start listening, or send what was heard, or put Blob back to sleep.
    func tap() {
        switch phase {
        case .idle, .failed: listen()
        case .listening: send()
        case .waiting: reset()
        }
    }

    func reset() {
        dictation.stop()
        heard = ""
        phase = .idle
    }

    /// The answer is complete: the run has finished and its reply is in.
    var settled: Bool {
        guard phase == .waiting, let desk else { return false }
        return !desk.isRunning && !desk.isStreaming && answer != nil
    }

    private func listen() {
        heard = ""
        phase = .listening
        Task {
            await dictation.start(base: "") { [weak self] text in self?.heard = text }
            switch dictation.state {
            case .denied(let message), .failed(let message): phase = .failed(message)
            default: break
            }
        }
    }

    private func send() {
        dictation.stop()
        let text = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { reset(); return }
        phase = .waiting
        Task {
            do {
                let model = try await deskModel()
                sentAt = model.entries.count
                model.sendQuickReply(text)
            } catch {
                phase = .failed(error.localizedDescription)
            }
        }
    }

    /// The Desk session, connected once and kept for the life of the screen.
    private func deskModel() async throws -> SessionViewModel {
        if let desk { return desk }
        let ensure = try await OS1API.ensureDesk()
        let model = SessionViewModel(session: Session(id: ensure.sessionId))
        model.start(owner: owner)
        desk = model
        return model
    }

    /// Whether the server can run the live voice call. Nil when it can't say
    /// (offline, older server): the caller keeps trying voice in that case.
    static func voiceConfigured() async -> Bool? {
        guard let base = ServerConfig.shared.baseURL else { return nil }
        let request = ServerConfig.shared.authorizedRequest(base.appending(path: "api/desk/voice/status"))
        struct Status: Decodable { let configured: Bool? }
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let status = try? JSONDecoder().decode(Status.self, from: data)
        else { return nil }
        return status.configured
    }
}
