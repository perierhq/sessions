import AVFoundation
import Foundation

/// "One sec." when the supervisor takes a while: Blob says a short filler
/// once per turn if nothing has been spoken 4 s after your message went out.
///
/// The server voice's fillers are fetched once and kept on the device, in
/// `Caches/BlobFiller/<voiceId>/`, keyed by voice and model from
/// `GET /api/blob/speech/status` and by the phrases themselves. Only one
/// voice's clips are kept. Playing one needs no network, so it is
/// instant. Until the cache is filled (first use, or after the voice or
/// model changes) Blob says it with an Apple voice and fills the cache in
/// the background. Separate from `BlobSpeaker` so a filler never touches
/// the answer's own playback; the view stops it when the answer starts.
@MainActor
final class BlobFiller: NSObject {
    nonisolated static let phrases = ["One sec.", "Let me check.", "Give me a moment."]
    /// Quiet this long after sending before the filler plays.
    static let delay: Duration = .seconds(4)

    private var player: AVAudioPlayer?
    private let synthesizer = AVSpeechSynthesizer()
    private var filling: Task<Void, Never>?
    private var fillingKey: String?

    override init() {
        super.init()
        synthesizer.delegate = self
        BlobListener.registerPlayback { [weak self] in
            guard let self else { return false }
            return self.player?.isPlaying == true || self.synthesizer.isSpeaking
        }
    }

    /// Says a random filler: from the cache when it holds the current server
    /// voice's, else with an Apple voice while the cache fills.
    func play(speaker: BlobSpeaker) async {
        guard UserDefaults.standard.object(forKey: BlobSpeaker.readAloudKey) as? Bool ?? true else { return }
        let status = await speaker.refreshServerVoice()
        if let key = Self.key(status) {
            if let data = await Self.cached(key) {
                guard !Task.isCancelled else { return }
                try? BlobListener.activateSession(record: false)
                player = try? AVAudioPlayer(data: data)
                player?.delegate = self
                if player?.play() != true { BlobListener.deactivateSession() }
                return
            }
            fill(key)
        }
        guard !Task.isCancelled, let phrase = Self.phrases.randomElement(),
              let voice = BlobSpeaker.voice(for: phrase) else { return }
        try? BlobListener.activateSession(record: false)
        let utterance = AVSpeechUtterance(string: phrase)
        utterance.voice = voice
        synthesizer.speak(utterance)
    }

    func stop() {
        player?.stop()
        player = nil
        synthesizer.stopSpeaking(at: .immediate)
        BlobListener.deactivateSession()
    }

    // MARK: Cache

    struct Key: Equatable, Sendable {
        var voiceId: String
        var model: String
    }

    /// Changes when `phrases` do, so edited phrases are fetched again.
    nonisolated static let phraseSet = stableHash(phrases.joined(separator: "\n"))

    private static func key(_ status: OS1API.BlobSpeechStatus?) -> Key? {
        guard let status, status.configured, let voice = status.voiceId, !voice.isEmpty else { return nil }
        return Key(voiceId: safe(voice), model: safe(status.model ?? "default") + "-" + phraseSet)
    }

    /// Fetches the three fillers once for this voice and model, replacing
    /// whatever the voice's folder held for another model.
    private func fill(_ key: Key) {
        let id = "\(key.voiceId)/\(key.model)"
        guard fillingKey != id else { return }
        fillingKey = id
        filling = Task.detached(priority: .utility) {
            var clips: [Data] = []
            for phrase in Self.phrases {
                guard let data = try? await OS1API.blobSpeech(phrase), !data.isEmpty else { break }
                clips.append(data)
            }
            if clips.count == Self.phrases.count { Self.store(clips, key) }
            await MainActor.run { [weak self] in
                if self?.fillingKey == id { self?.fillingKey = nil }
            }
        }
    }

    private nonisolated static var root: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appending(path: "BlobFiller", directoryHint: .isDirectory)
    }

    private nonisolated static func folder(_ key: Key) -> URL? {
        root?.appending(path: key.voiceId, directoryHint: .isDirectory)
    }

    private nonisolated static func file(_ key: Key, _ index: Int) -> URL? {
        folder(key)?.appending(path: "\(key.model)-\(index).mp3")
    }

    /// A random cached filler for `key`, or nil when any is missing.
    private nonisolated static func cached(_ key: Key) async -> Data? {
        await Task.detached(priority: .userInitiated) {
            let files = phrases.indices.compactMap { file(key, $0) }
            guard files.count == phrases.count,
                  files.allSatisfy({ FileManager.default.fileExists(atPath: $0.path) }),
                  let pick = files.randomElement()
            else { return nil }
            return try? Data(contentsOf: pick)
        }.value
    }

    private nonisolated static func store(_ clips: [Data], _ key: Key) {
        guard let root, let folder = folder(key) else { return }
        let manager = FileManager.default
        // One voice, model and phrase set at a time: clear every other first.
        try? manager.removeItem(at: root)
        try? manager.createDirectory(at: folder, withIntermediateDirectories: true)
        for (index, data) in clips.enumerated() {
            if let url = file(key, index) { try? data.write(to: url, options: .atomic) }
        }
    }

    /// A short path component that can't climb out of the cache folder.
    /// Anything changed or cut gets a hash of the original, so two ids
    /// never share a folder.
    private static func safe(_ raw: String) -> String {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
        let cleaned = String(String.UnicodeScalarView(raw.unicodeScalars.map { allowed.contains($0) ? $0 : "_" }))
        guard cleaned.isEmpty || cleaned != raw || cleaned.count > 40 else { return cleaned }
        return String(cleaned.prefix(24)) + "_" + stableHash(raw)
    }

    /// FNV-1a, 64 bit, as hex: stable across launches, unlike `hashValue`.
    private nonisolated static func stableHash(_ text: String) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in text.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return String(hash, radix: 16)
    }
}

/// When the filler ends, the audio session goes back (`deactivateSession`
/// skips it while the answer is already playing).
extension BlobFiller: AVAudioPlayerDelegate, AVSpeechSynthesizerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in BlobListener.deactivateSession() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in BlobListener.deactivateSession() }
    }
}
