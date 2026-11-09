import Foundation
import Observation

/// Talking to Blob when the server has no voice key: you speak, Apple's
/// on-device recognizer (`BlobListener`) turns it into text, the text goes to
/// the Desk like a typed message, and Blob shows the answer and reads it aloud
/// with a Premium or Enhanced voice (`BlobSpeaker`) when one fits.
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
    let listener = BlobListener()
    let speaker = BlobSpeaker()
    private var desk: SessionViewModel?
    private let owner = UUID()
    /// Transcript size when the message went out; the answer is what comes after.
    private var sentAt = 0

    var active: Bool { phase != .idle }
    /// Voice level for Blob's body: yours while listening, its own while it reads.
    func level(at date: Date) -> Double {
        phase == .listening ? listener.level : speaker.level(at: date)
    }
    /// The answer that was last read aloud, so it is read once.
    private var spokenAnswer: String?

    /// Blob's answer so far: streaming text while the Desk writes, then the
    /// finished reply.
    var answer: String? {
        guard let desk, phase == .waiting else { return nil }
        if desk.isStreaming, !desk.liveText.isEmpty { return desk.liveText }
        return replyEntry?.content.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The finished reply as a transcript entry, once it has landed. Blob
    /// draws it with the block catalog (`MarkdownBody`); see adrs/blob-views.md.
    var replyEntry: TranscriptEntry? {
        guard let desk, phase == .waiting, !desk.isStreaming else { return nil }
        return desk.entries.dropFirst(sentAt).last { $0.type == "assistant" && $0.isReasoning != true }
    }

    /// The Desk's quick-reply relay, so `choices` chips in a reply send.
    var relay: QuickReplyRelay? { desk?.quickReplies }

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
        listener.cancel()
        speaker.stop()
        spokenAnswer = nil
        heard = ""
        phase = .idle
    }

    /// The answer is complete: the run has finished and its reply is in.
    var settled: Bool {
        guard phase == .waiting, let desk else { return false }
        return !desk.isRunning && !desk.isStreaming && answer != nil
    }

    /// Reads the finished answer aloud, once. Called when `settled` turns true.
    func answerSettled() {
        guard let answer, answer != spokenAnswer else { return }
        spokenAnswer = answer
        speaker.speak(answer)
    }

    private func listen() {
        heard = ""
        phase = .listening
        Task {
            do {
                try await listener.start()
            } catch {
                phase = .failed(error.localizedDescription)
            }
        }
    }

    /// Mirrors the listener's text while listening. Called by the view.
    func syncHeard() { if phase == .listening { heard = listener.text } }

    private func send() {
        phase = .waiting
        Task {
            let text = await listener.stop().trimmingCharacters(in: .whitespacesAndNewlines)
            heard = text
            guard !text.isEmpty else { reset(); return }
            do {
                let model = try await deskModel()
                sentAt = model.entries.count
                model.sendQuickReply(text)
            } catch {
                phase = .failed(error.localizedDescription)
            }
        }
    }

    private func follow(up text: String) {
        guard let desk else { return }
        speaker.stop()
        spokenAnswer = nil
        heard = text
        phase = .waiting
        sentAt = desk.entries.count
        desk.sendQuickReply(text)
    }

    /// The Desk session, connected once and kept for the life of the screen.
    private func deskModel() async throws -> SessionViewModel {
        if let desk { return desk }
        let ensure = try await OS1API.ensureDesk()
        let model = SessionViewModel(session: Session(id: ensure.sessionId))
        // A chip in a reply is the next thing you say: send it and wait for
        // the answer to that, not the one already on screen.
        model.quickReplies.send = { [weak self] text in self?.follow(up: text) }
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
