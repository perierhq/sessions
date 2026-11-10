import Foundation

/// Decides when you have finished talking, so Blob sends without a second
/// tap. Fed one frame at a time (speech or not, and how long it lasted) from
/// FluidAudio's Silero VAD, or from the input level when the VAD isn't loaded
/// (`BlobListener`). Counts audio time, not wall time.
///
/// - The silence timer starts only once speech has been heard.
/// - It ends after `wait` of silence, never before `minSpeech` of speech.
/// - It ends at `maxListen` whatever happens.
/// - With nothing said for `idleGiveUp` it gives up, and Blob goes back to
///   sleep without sending anything.
struct BlobEndpointer {
    enum Decision: Equatable { case listen, send, giveUp }

    /// How long a pause ends what you're saying (Settings, "Wait after I stop").
    enum Wait: String, CaseIterable, Identifiable {
        case short, normal, long
        var id: String { rawValue }
        var seconds: TimeInterval {
            switch self {
            case .short: 0.8
            case .normal: 1.2
            case .long: 2
            }
        }
        var name: String {
            switch self {
            case .short: "Short"
            case .normal: "Normal"
            case .long: "Long"
            }
        }
        static let key = "blob.endWait"
        static var current: Wait {
            UserDefaults.standard.string(forKey: key).flatMap(Wait.init(rawValue:)) ?? .normal
        }
    }

    static let heardSpeech: TimeInterval = 0.2
    static let minSpeech: TimeInterval = 0.6
    static let maxListen: TimeInterval = 60
    static let idleGiveUp: TimeInterval = 8

    let wait: TimeInterval
    private(set) var elapsed: TimeInterval = 0
    private(set) var speech: TimeInterval = 0
    private(set) var silence: TimeInterval = 0

    init(wait: TimeInterval = Wait.current.seconds) {
        self.wait = wait
    }

    mutating func feed(speaking: Bool, seconds: TimeInterval) -> Decision {
        elapsed += seconds
        if speaking {
            speech += seconds
            silence = 0
        } else if speech >= Self.heardSpeech {
            silence += seconds
        }
        let said = speech >= Self.minSpeech
        if elapsed >= Self.maxListen { return said ? .send : .giveUp }
        if speech < Self.heardSpeech { return elapsed >= Self.idleGiveUp ? .giveUp : .listen }
        if said { return silence >= wait ? .send : .listen }
        // A cough or a click: too short to send, and nothing came after it.
        return silence >= Self.idleGiveUp ? .giveUp : .listen
    }
}
