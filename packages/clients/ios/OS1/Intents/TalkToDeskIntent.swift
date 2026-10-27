import AppIntents

/// "Talk to Desk": one press, and you are in a live voice call with the Desk.
///
/// Meant for the iPhone's Action Button (Settings > Action Button > Shortcut >
/// Talk to Desk), next to `StartAgentIntent`. That one opens the composer with
/// dictation for an idea you want to read before it runs; this one is for
/// talking it through. Running it is the opt-in, so it does not need the Desk
/// voice preference to be on.
struct TalkToDeskIntent: AppIntent {
    static let title: LocalizedStringResource = "Talk to Desk"

    static let description = IntentDescription(
        "Opens the Desk and starts a live voice call with it.",
        categoryName: "Sessions",
        searchKeywords: ["desk", "voice", "call", "talk", "assistant"]
    )

    /// The call needs the mic, and a backgrounded app never holds it open.
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        DeskCallRequest.shared.ask()
        return .result()
    }
}

/// The hand-off between the intent and the Desk. The intent can run before
/// any view exists (cold launch), so the request is parked here. The sessions
/// list opens the Desk sheet when it sees one, and the sheet takes it and
/// starts the call.
@MainActor
@Observable
final class DeskCallRequest {
    static let shared = DeskCallRequest()

    struct Request: Identifiable {
        let id = UUID()
    }

    private(set) var request: Request?

    func ask() {
        request = Request()
    }

    /// Read once and clear, so reopening the Desk later does not call again.
    func take() -> Request? {
        defer { request = nil }
        return request
    }
}
