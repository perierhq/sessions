import CryptoKit
import Foundation
import Observation

/// A follow-up the agent proposed with `opensession-sessions` `suggest_task`:
/// work it judged worth doing but out of scope for what it was asked. The
/// agent proposes, the person decides. Mirrors `suggestedTaskOf` in the
/// protocol package's `tool-presentation.ts`.
///
/// The whole proposal lives in the call's input, so a still-pending call
/// already carries one.
struct SuggestedTask: Equatable, Sendable {
    var title: String
    var description: String
    /// The complete prompt the new session starts on.
    var instructions: String
    var repo: String?
    /// "ask" or "code"; nil means code.
    var mode: String?
    var branch: String?

    /// The proposal a tool call carries, or nil when the call is anything
    /// other than a well-formed `suggest_task`. Accepts every name form a
    /// transcript stores: `mcp__opensession-sessions__suggest_task`, the flat
    /// `opensession-sessions_suggest_task`, and either inside a `tool_call`
    /// (formerly `mcp_call`) dispatcher envelope.
    static func from(toolName rawName: String, input rawInput: JSONValue?) -> SuggestedTask? {
        var toolName = rawName
        var input = rawInput
        if isDispatcher(rawName) {
            (toolName, input) = ToolPresentation.resolveCall(toolName: "tool_call", input: rawInput)
        }
        guard let mcp = ToolPresentation.parseMcpTool(toolName),
              mcp.server == "opensession-sessions",
              mcp.tool == "suggest_task",
              let input, case .object = input
        else { return nil }
        let title = string(input, "title")
        let instructions = string(input, "instructions", "prompt")
        guard !title.isEmpty, !instructions.isEmpty else { return nil }
        let mode = input["mode"]?.stringValue
        return SuggestedTask(
            title: title,
            description: string(input, "description"),
            instructions: instructions,
            repo: nonempty(string(input, "repo")),
            mode: mode == "ask" || mode == "code" ? mode : nil,
            branch: nonempty(string(input, "branch"))
        )
    }

    /// `tool_call` (or the older `mcp_call`) as Pi stores it, or behind a
    /// client's own MCP prefix.
    private static func isDispatcher(_ name: String) -> Bool {
        var bare = name.lowercased()
        for prefix in ["mcp__oc__", "mcp__"] where bare.hasPrefix(prefix) {
            bare = String(bare.dropFirst(prefix.count))
        }
        return ToolPresentation.isCallDispatcher(bare)
    }

    /// The first non-empty string among `keys`, trimmed.
    private static func string(_ input: JSONValue, _ keys: String...) -> String {
        for key in keys {
            if let value = input[key]?.stringValue, !value.isEmpty {
                return value.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        return ""
    }

    private static func nonempty(_ value: String) -> String? {
        value.isEmpty ? nil : value
    }
}

/// One proposal in a turn, keyed by the transcript entry of its call. The
/// entry id is durable across reloads, which is what lets a started card stay
/// closed.
struct SuggestedTaskProposal: Identifiable, Equatable, Sendable {
    let entryId: String
    let task: SuggestedTask
    var id: String { entryId }

    /// The proposals among a turn's tool calls, in call order.
    static func proposals(in tools: [ToolCallItem]) -> [SuggestedTaskProposal] {
        tools.compactMap { tool in
            guard let use = tool.use,
                  let task = SuggestedTask.from(toolName: use.toolName ?? "", input: use.toolInput)
            else { return nil }
            return SuggestedTaskProposal(entryId: use.id, task: task)
        }
    }

    /// The create request id for starting this proposal. Derived, not random:
    /// the server maps a request id to one session, so a retry after an error,
    /// a second tap, a relaunch or the same card on another device all land
    /// on the session the first attempt made instead of a duplicate.
    static func requestId(sessionId: String, entryId: String) -> String {
        let digest = SHA256.hash(data: Data(StartedSuggestedTasks.key(
            sessionId: sessionId,
            entryId: entryId
        ).utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return "suggested-task-\(hex.prefix(40))"
    }
}

/// Suggested tasks this device has already started.
///
/// Starting a suggestion answers it: the new session carries the work, so the
/// card that proposed it closes for good. The answer is stored rather than
/// held in the card, because a transcript re-renders the same call on every
/// load and a card that came back would invite a second session. Keyed by the
/// proposing session and the call's transcript entry, capped so it cannot
/// grow without bound. Mirrors the web's `started-suggested-tasks.ts`.
@MainActor
@Observable
final class StartedSuggestedTasks {
    static let shared = StartedSuggestedTasks()
    static let storageKey = "os1.startedSuggestedTasks.v1"
    static let limit = 500

    @ObservationIgnored private let defaults: UserDefaults
    /// Oldest first, so the cap drops the oldest.
    private(set) var keys: [String]

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        keys = defaults.stringArray(forKey: Self.storageKey) ?? []
    }

    nonisolated static func key(sessionId: String, entryId: String) -> String {
        "\(sessionId):\(entryId)"
    }

    func isStarted(sessionId: String, entryId: String) -> Bool {
        keys.contains(Self.key(sessionId: sessionId, entryId: entryId))
    }

    func markStarted(sessionId: String, entryId: String) {
        let key = Self.key(sessionId: sessionId, entryId: entryId)
        var next = keys.filter { $0 != key }
        next.append(key)
        if next.count > Self.limit { next.removeFirst(next.count - Self.limit) }
        keys = next
        defaults.set(next, forKey: Self.storageKey)
    }

    /// The proposals still waiting on a decision.
    func open(_ proposals: [SuggestedTaskProposal], sessionId: String) -> [SuggestedTaskProposal] {
        proposals.filter { !isStarted(sessionId: sessionId, entryId: $0.entryId) }
    }
}

/// Starting a proposal: create the session with the proposal's derived
/// request id, then retire the card. A failure retires nothing, so the card
/// stays actionable and a retry reuses the same request id.
enum SuggestedTaskStart {
    typealias Create = @MainActor (SuggestedTask, _ requestId: String) async throws -> String

    @MainActor
    static func run(
        _ proposal: SuggestedTaskProposal,
        sessionId: String,
        store: StartedSuggestedTasks? = nil,
        create: Create = OS1API.createSession(suggested:requestId:)
    ) async throws -> String {
        let id = try await create(
            proposal.task,
            SuggestedTaskProposal.requestId(sessionId: sessionId, entryId: proposal.entryId)
        )
        (store ?? .shared).markStarted(sessionId: sessionId, entryId: proposal.entryId)
        return id
    }
}

extension OS1API {
    /// A session from a suggested task, as written: its repo (or the
    /// instance default), its mode, and its branch for a code task.
    static func createSession(suggested task: SuggestedTask, requestId: String) async throws -> String {
        try await createSession(
            prompt: task.instructions,
            repo: task.repo ?? "",
            mode: task.mode ?? "code",
            branch: task.branch,
            requestId: requestId
        )
    }
}
