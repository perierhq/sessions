import Foundation

/// What the supervisor is doing while you wait: one short label per step,
/// read from the transcript entries after your message. Foundation only, so
/// it can be checked with a plain `swiftc` run; `BlobThinkingView` turns
/// transcript entries into `BlobStepEvent`s and draws the result.
///
/// Labels never carry thinking text or tool arguments, apart from a PR
/// number or a project name.
struct BlobStepEvent: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        /// A tool call. `args` holds the call's scalar arguments (a
        /// `tool_call` envelope's `name` plus its inner arguments); `title`
        /// is the OS transcript's row title for it, if it has one.
        case tool(name: String, args: [String: String], title: String?)
        /// A tool's result came back: the model is thinking again.
        case result
        /// Reasoning, or text between tool calls.
        case thinking
    }

    var kind: Kind
    var at: Date
}

struct BlobStep: Equatable, Identifiable, Sendable {
    var id: Int
    var label: String
    var start: Date
    /// Nil while it is the step in progress.
    var end: Date?

    func seconds(at now: Date) -> TimeInterval { max(0, (end ?? now).timeIntervalSince(start)) }
}

enum BlobSteps {
    static let thinking = "Thinking"
    static let working = "Working"
    /// A step this long shows its time on the line.
    static let showTimeAfter: TimeInterval = 8
    /// Thinking shorter than this between two tools isn't a step of its own.
    static let minThinking: TimeInterval = 1

    /// This turn's steps, oldest first. The turn opens with "Thinking" at
    /// `sentAt`; equal neighbours merge; a short think between two tools
    /// folds into the step before it.
    static func steps(from events: [BlobStepEvent], sentAt: Date, persona: String? = nil) -> [BlobStep] {
        var marks: [(label: String, start: Date)] = [(thinking, sentAt)]
        for event in events.sorted(by: { $0.at < $1.at }) {
            let label: String
            switch event.kind {
            case .tool(let name, let args, let title): label = Self.label(tool: name, args: args, title: title, persona: persona)
            case .result, .thinking: label = thinking
            }
            let start = max(event.at, marks[marks.count - 1].start)
            if let last = marks.last, last.label == thinking, label != thinking,
               start.timeIntervalSince(last.start) < minThinking {
                marks.removeLast()
            }
            if marks.last?.label == label { continue }
            marks.append((label, marks.isEmpty ? sentAt : start))
        }
        return marks.indices.map { index in
            BlobStep(
                id: index,
                label: marks[index].label,
                start: marks[index].start,
                end: index + 1 < marks.count ? marks[index + 1].start : nil
            )
        }
    }

    /// The step the line shows. A think younger than `minThinking` after a
    /// tool keeps the tool's label, so the line doesn't flicker between calls.
    static func current(_ steps: [BlobStep], at now: Date) -> BlobStep? {
        guard let last = steps.last else { return nil }
        if last.label == thinking, steps.count > 1, last.seconds(at: now) < minThinking {
            return steps[steps.count - 2]
        }
        return last
    }

    /// The line's text: the label, then its time once it has run 8 s.
    static func line(_ step: BlobStep, at now: Date) -> String {
        let seconds = step.seconds(at: now)
        return seconds >= showTimeAfter ? "\(step.label) \u{00B7} \(duration(seconds))" : step.label
    }

    /// "<1s", "12s", "1m 4s".
    static func duration(_ seconds: TimeInterval) -> String {
        let total = Int(seconds.rounded(.down))
        if total < 1 { return "<1s" }
        if total < 60 { return "\(total)s" }
        let rest = total % 60
        return rest == 0 ? "\(total / 60)m" : "\(total / 60)m \(rest)s"
    }

    // MARK: Labels

    /// A short label for one tool call. Blob's own wording for the
    /// supervisor's tools, then the OS transcript's row title, then "Working".
    static func label(tool raw: String, args: [String: String], title: String?, persona: String? = nil) -> String {
        var name = raw.trimmingCharacters(in: .whitespaces)
        var lower = name.lowercased()
        // Pi's MCP dispatcher: label the call inside it.
        if lower == "tool_call" || lower == "mcp_call" {
            guard let inner = args["name"], !inner.isEmpty else { return working }
            name = inner
            lower = inner.lowercased()
        }
        let words = Set(lower.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init))
        func named(_ leaves: String...) -> Bool {
            leaves.contains { lower == $0 || lower.hasSuffix("_" + $0) }
        }

        if lower == "tool_search" || lower == "mcp_search" { return "Finding the right tool" }
        if named("read_ledger") { return "Reading my notes" }
        if named("append_ledger") { return "Noting that" }
        if named("ask_pat") {
            let who = persona?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return "Asking \(who.isEmpty || who == "Agent" ? "Pat" : who)"
        }
        if named("list_items", "post_item", "answer_item", "dismiss_item") { return "Checking what\u{2019}s waiting" }
        if named("web_search", "websearch") { return "Searching the web" }
        if named("web_fetch", "webfetch") { return "Reading a page" }
        if named("create_session", "spawn_task") { return "Asking a worker" }
        if named("send_to_session") { return "Updating a worker" }
        if lower.contains("incident") {
            let project = value(args, "project", "projectId", "project_id", "projectName")
            return project.map { "Checking \($0) incidents" } ?? "Checking incidents"
        }
        // GitHub pull request tools, from any server.
        if !words.isDisjoint(with: ["pr", "prs", "pull", "pulls"]) || lower.contains("pull_request") {
            let number = value(args, "pr", "prNumber", "pr_number", "pull_number", "pullNumber", "number")
                .flatMap { Int($0.trimmingCharacters(in: CharacterSet(charactersIn: "#"))) }
            return number.map { "Reading PR #\($0)" } ?? "Reading a PR"
        }
        if let title = title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { return title }
        return working
    }

    /// The first non-empty, short, single-line value under one of `keys`.
    private static func value(_ args: [String: String], _ keys: String...) -> String? {
        for key in keys {
            guard let raw = args[key]?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !raw.isEmpty, raw.count <= 40, !raw.contains("\n") else { continue }
            if raw.hasSuffix(".0"), let number = Double(raw) { return String(Int(number)) }
            return raw
        }
        return nil
    }
}

#if DEBUG
extension BlobSteps {
    /// Fake steps for screenshots: `BLOB_DEMO_THINKING=1`. A new step every
    /// few seconds, and a long one so the time shows.
    static func demo(at now: Date, since start: Date) -> [BlobStep] {
        let script: [(String, TimeInterval)] = [
            (thinking, 2), ("Reading my notes", 3), ("Checking what\u{2019}s waiting", 3),
            ("Reading PR #212", 12), (thinking, 2), ("Asking Pat", 10),
        ]
        let cycle = script.reduce(0) { $0 + $1.1 }
        let elapsed = now.timeIntervalSince(start).truncatingRemainder(dividingBy: cycle)
        let origin = now.addingTimeInterval(-elapsed)
        var steps: [BlobStep] = []
        var offset: TimeInterval = 0
        for (index, (label, length)) in script.enumerated() where offset <= elapsed {
            let begin = origin.addingTimeInterval(offset)
            offset += length
            steps.append(BlobStep(id: index, label: label, start: begin, end: offset <= elapsed ? origin.addingTimeInterval(offset) : nil))
        }
        return steps
    }
}
#endif
