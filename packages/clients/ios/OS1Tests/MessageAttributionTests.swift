import XCTest
@testable import OS1

final class MessageAttributionTests: XCTestCase {
    private func credit(
        sender: String? = nil,
        via: String? = nil,
        owner: String? = nil,
        me: String = "Michiel",
        login: String = "happylinks"
    ) -> MessageAttribution.Credit? {
        MessageAttribution.credit(
            sender: sender,
            senderVia: via,
            owner: owner,
            viewerName: me,
            viewerLogin: login
        )
    }

    func testOwnTurnsAreNotLabelled() {
        XCTAssertNil(credit(owner: "Michiel"))
        XCTAssertNil(credit(sender: "Michiel", owner: "Kent"))
    }

    /// The regression this whole rule exists for: the owner's own prompts
    /// carry no sender, so a teammate's session used to read as your own.
    func testOwnerCreditsATeammatesUnattributedTurn() {
        XCTAssertEqual(credit(owner: "Kent")?.name, "Kent")
    }

    func testExplicitSenderWinsOverOwner() {
        XCTAssertEqual(credit(sender: "Jaap", owner: "Kent")?.name, "Jaap")
    }

    /// Blob is credited as a bot, even to a viewer whose name it prefixes.
    func testBlobIsCreditedAsABot() {
        let blob = credit(sender: "Blob", owner: "Kent", me: "Bl", login: "bl")
        XCTAssertEqual(blob?.name, "Blob")
        XCTAssertTrue(blob?.isBot == true)
        XCTAssertFalse(credit(owner: "Kent")?.isBot == true)
    }

    func testSlackRepliesAreMarked() {
        let slack = credit(sender: "Kent", via: "slack")
        XCTAssertEqual(slack?.name, "Kent")
        XCTAssertTrue(slack?.viaSlack == true)
        XCTAssertFalse(credit(sender: "Kent")?.viaSlack == true)
    }

    /// One person reaches the app under several names; none of them should
    /// read as a stranger in their own session.
    func testIdentityShapesMatchTheSamePerson() {
        XCTAssertNil(credit(owner: "Michiel Westerbeek"))
        XCTAssertNil(credit(owner: "happylinks"))
        XCTAssertNil(credit(owner: "Kent", me: "Kent de Bruin", login: "kentdebruin"))
        XCTAssertNil(credit(owner: "kentdebruin", me: "Kent", login: "kentdebruin"))
    }

    func testUnknownViewerStillCreditsTheAuthor() {
        // A pasted token with no sign-in: the app can't claim any turn as
        // yours, so it credits the author rather than guessing.
        XCTAssertEqual(credit(owner: "Kent", me: "ios", login: "")?.name, "Kent")
    }

    func testNoAuthorAtAll() {
        XCTAssertNil(credit())
        XCTAssertNil(credit(sender: "", owner: ""))
    }

    func testViewerMessageUsesExplicitSenderBeforeOwner() {
        XCTAssertTrue(MessageAttribution.isViewerMessage(
            sender: "happylinks",
            owner: "Kent",
            viewerName: "Michiel",
            viewerLogin: "happylinks"
        ))
        XCTAssertFalse(MessageAttribution.isViewerMessage(
            sender: "Kent",
            owner: "Michiel",
            viewerName: "Michiel",
            viewerLogin: "happylinks"
        ))
    }

    func testViewerMessageNeedsAKnownAuthor() {
        XCTAssertFalse(MessageAttribution.isViewerMessage(
            sender: nil,
            owner: nil,
            viewerName: "Michiel",
            viewerLogin: "happylinks"
        ))
    }
}
