import XCTest
@testable import OS1

/// Suggested follow-up tasks: extracted from a turn's `suggest_task` calls,
/// shown as a card outside the fold, and retired for good once Start has
/// created the session. Mirrors the web's TurnBlock suggested-task tests.
@MainActor
final class SuggestedTaskTests: XCTestCase {
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUp() async throws {
        suite = "SuggestedTaskTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
    }

    private let input: JSONValue = .object([
        "title": .string(" Add a missing test "),
        "description": .string("The parser has no coverage."),
        "instructions": .string("Write tests for the parser."),
        "repo": .string("acme"),
        "mode": .string("ask"),
        "branch": .string("parser-tests"),
    ])

    private func toolUse(_ id: String, name: String, input: JSONValue) -> TranscriptEntry {
        TranscriptEntry(
            id: id,
            type: "tool_use",
            content: "Using \(name)",
            toolName: name,
            toolInput: input,
            toolUseId: id
        )
    }

    private func proposal(_ entryId: String = "t1") -> SuggestedTaskProposal {
        SuggestedTaskProposal(
            entryId: entryId,
            task: SuggestedTask.from(toolName: "opensession-sessions_suggest_task", input: input)!
        )
    }

    // MARK: - Extraction

    func testExtractsEveryToolNameForm() {
        let forms = [
            "opensession-sessions_suggest_task",
            "mcp__opensession-sessions__suggest_task",
            "mcp__oc__opensession-sessions__suggest_task",
        ]
        for name in forms {
            let task = SuggestedTask.from(toolName: name, input: input)
            XCTAssertEqual(task?.title, "Add a missing test", name)
            XCTAssertEqual(task?.description, "The parser has no coverage.", name)
            XCTAssertEqual(task?.instructions, "Write tests for the parser.", name)
            XCTAssertEqual(task?.repo, "acme", name)
            XCTAssertEqual(task?.mode, "ask", name)
            XCTAssertEqual(task?.branch, "parser-tests", name)
        }
    }

    func testUnwrapsTheMcpDispatcherEnvelope() {
        // tool_call is pi's dispatcher; mcp_call is what older transcripts store.
        for outer in ["tool_call", "mcp__oc__tool_call", "mcp_call", "mcp__oc__mcp_call"] {
            let wrapped: JSONValue = .object([
                "name": .string("opensession-sessions_suggest_task"),
                "arguments": input,
            ])
            XCTAssertEqual(
                SuggestedTask.from(toolName: outer, input: wrapped)?.title,
                "Add a missing test",
                outer
            )
        }
    }

    func testRejectsOtherToolsAndIncompleteProposals() {
        XCTAssertNil(SuggestedTask.from(toolName: "opensession-sessions_create_session", input: input))
        XCTAssertNil(SuggestedTask.from(toolName: "linear_suggest_task", input: input))
        XCTAssertNil(SuggestedTask.from(toolName: "Bash", input: input))
        XCTAssertNil(SuggestedTask.from(
            toolName: "opensession-sessions_suggest_task",
            input: .object(["title": .string("No instructions")])
        ))
        XCTAssertNil(SuggestedTask.from(
            toolName: "opensession-sessions_suggest_task",
            input: .object(["instructions": .string("No title")])
        ))
        XCTAssertNil(SuggestedTask.from(toolName: "tool_call", input: .object([:])))
        XCTAssertNil(SuggestedTask.from(toolName: "mcp_call", input: .object([:])))
    }

    func testAcceptsPromptAsInstructionsAndDropsAnUnknownMode() {
        let task = SuggestedTask.from(
            toolName: "opensession-sessions_suggest_task",
            input: .object([
                "title": .string("T"),
                "prompt": .string("Do it."),
                "mode": .string("yolo"),
            ])
        )
        XCTAssertEqual(task?.instructions, "Do it.")
        XCTAssertEqual(task?.description, "")
        XCTAssertNil(task?.mode)
        XCTAssertNil(task?.repo)
    }

    // MARK: - Initial visibility

    func testAPendingProposalReachesTheWorkTurn() {
        let viewModel = SessionViewModel(session: Session(id: "bks-1"))
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            TranscriptEntry(id: "u1", type: "user", content: "fix it"),
            toolUse("t1", name: "Bash", input: .object(["command": .string("ls")])),
            TranscriptEntry(id: "tr-t1", type: "tool_result", content: "ok", toolUseId: "t1"),
            toolUse("t2", name: "opensession-sessions_suggest_task", input: input),
            TranscriptEntry(id: "a1", type: "assistant", content: "Done."),
        ]))
        let turn = viewModel.displayBlocks.lazy.compactMap { block -> WorkTurn? in
            if case .work(let turn) = block { return turn }
            return nil
        }.first
        XCTAssertEqual(turn?.suggestedTasks.map(\.entryId), ["t2"])
        XCTAssertEqual(turn?.suggestedTasks.first?.task.title, "Add a missing test")

        let store = StartedSuggestedTasks(defaults: defaults)
        XCTAssertEqual(
            store.open(turn?.suggestedTasks ?? [], sessionId: "bks-1").map(\.entryId),
            ["t2"],
            "a fresh card is actionable"
        )
    }

    // MARK: - Start

    func testSuccessCreatesOnceAndRetiresTheCard() async throws {
        let store = StartedSuggestedTasks(defaults: defaults)
        var calls: [(SuggestedTask, String)] = []
        let id = try await SuggestedTaskStart.run(proposal(), sessionId: "bks-1", store: store) {
            calls.append(($0, $1))
            return "bks-new"
        }
        XCTAssertEqual(id, "bks-new")
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls.first?.0.instructions, "Write tests for the parser.")
        XCTAssertTrue(store.isStarted(sessionId: "bks-1", entryId: "t1"))
        XCTAssertTrue(store.open([proposal()], sessionId: "bks-1").isEmpty)
    }

    func testFailureLeavesTheCardAndRetriesReuseTheRequestId() async throws {
        struct Offline: Error {}
        let store = StartedSuggestedTasks(defaults: defaults)
        var requestIds: [String] = []
        do {
            _ = try await SuggestedTaskStart.run(proposal(), sessionId: "bks-1", store: store) {
                requestIds.append($1)
                throw Offline()
            }
            XCTFail("the error should surface")
        } catch is Offline {}
        XCTAssertFalse(store.isStarted(sessionId: "bks-1", entryId: "t1"))
        XCTAssertEqual(store.open([proposal()], sessionId: "bks-1").count, 1)

        _ = try await SuggestedTaskStart.run(proposal(), sessionId: "bks-1", store: store) {
            requestIds.append($1)
            return "bks-new"
        }
        XCTAssertEqual(requestIds.count, 2)
        XCTAssertEqual(requestIds[0], requestIds[1], "the server maps one request id to one session")
        XCTAssertTrue(store.isStarted(sessionId: "bks-1", entryId: "t1"))
    }

    func testRequestIdsAreDistinctPerSessionAndEntry() {
        let a = SuggestedTaskProposal.requestId(sessionId: "bks-1", entryId: "t1")
        XCTAssertEqual(a, SuggestedTaskProposal.requestId(sessionId: "bks-1", entryId: "t1"))
        XCTAssertNotEqual(a, SuggestedTaskProposal.requestId(sessionId: "bks-1", entryId: "t2"))
        XCTAssertNotEqual(a, SuggestedTaskProposal.requestId(sessionId: "bks-2", entryId: "t1"))
        XCTAssertLessThanOrEqual(a.count, 200)
    }

    // MARK: - Isolation and persistence

    func testStartedStateIsKeyedBySessionAndEntry() {
        let store = StartedSuggestedTasks(defaults: defaults)
        store.markStarted(sessionId: "bks-1", entryId: "t1")
        XCTAssertTrue(store.isStarted(sessionId: "bks-1", entryId: "t1"))
        XCTAssertFalse(store.isStarted(sessionId: "bks-1", entryId: "t2"), "another card in the same session")
        XCTAssertFalse(store.isStarted(sessionId: "bks-2", entryId: "t1"), "the same entry id in another session")
        XCTAssertEqual(
            store.open([proposal("t1"), proposal("t2")], sessionId: "bks-1").map(\.entryId),
            ["t2"]
        )
    }

    func testStartedStateSurvivesRemountAndRelaunch() {
        StartedSuggestedTasks(defaults: defaults).markStarted(sessionId: "bks-1", entryId: "t1")
        // A new store over the same defaults is what a relaunch reads.
        let relaunched = StartedSuggestedTasks(defaults: defaults)
        XCTAssertTrue(relaunched.isStarted(sessionId: "bks-1", entryId: "t1"))
        XCTAssertTrue(relaunched.open([proposal()], sessionId: "bks-1").isEmpty)
    }

    func testStartedListIsBounded() {
        let store = StartedSuggestedTasks(defaults: defaults)
        for index in 0..<(StartedSuggestedTasks.limit + 5) {
            store.markStarted(sessionId: "bks-1", entryId: "t\(index)")
        }
        let relaunched = StartedSuggestedTasks(defaults: defaults)
        XCTAssertEqual(relaunched.keys.count, StartedSuggestedTasks.limit)
        XCTAssertFalse(relaunched.isStarted(sessionId: "bks-1", entryId: "t0"), "the oldest drops first")
        XCTAssertTrue(relaunched.isStarted(
            sessionId: "bks-1",
            entryId: "t\(StartedSuggestedTasks.limit + 4)"
        ))
    }

    // MARK: - Create body

    func testCreateBodyCarriesTheBranchOnlyForCode() {
        let code = OS1API.createSessionBody(
            prompt: "p", repo: "acme", mode: "code", branch: "parser-tests", user: "u"
        )
        XCTAssertEqual(code["branch"] as? String, "parser-tests")
        let ask = OS1API.createSessionBody(
            prompt: "p", repo: "acme", mode: "ask", branch: "parser-tests", user: "u"
        )
        XCTAssertNil(ask["branch"])
    }
}
