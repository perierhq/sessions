import Foundation

/// `item:<inbox item id>`: a board element that stands for one of the
/// owner's supervisor inbox items, a decision waiting for them or an update
/// (server: shared/blob-board.ts `parseRef`, blob-board-refs.ts `itemRef`).
/// Tapping one opens the decision view for that item; VoiceOver reads it as
/// "Decision: <title>".
///
/// Read tolerantly: the resolved ref's `fields.itemId` wins when the server
/// sent one, else the locator itself. An id that doesn't look like an inbox
/// item (`si-` and up to 76 letters, digits or dashes) is no item, and the
/// element opens like any other ref.
public enum BoardItemRef {
    public static let kind = "item"

    /// Whether `ref` is an `item:` ref, whatever its locator.
    public static func isItem(_ ref: String?) -> Bool {
        guard let ref else { return false }
        return ref.trimmingCharacters(in: .whitespaces).hasPrefix("\(kind):")
    }

    /// The inbox item `ref` names, or nil when it is no item ref or names
    /// no readable id.
    public static func itemId(_ ref: String?, info: BoardRefInfo? = nil) -> String? {
        guard let ref, isItem(ref) else { return nil }
        if let info, info.ok, let id = info.fields["itemId"].flatMap(validId) { return id }
        let trimmed = ref.trimmingCharacters(in: .whitespaces)
        return validId(String(trimmed.dropFirst(kind.count + 1)))
    }

    /// `id` trimmed when it reads as an inbox item id.
    static func validId(_ id: String) -> String? {
        let id = id.trimmingCharacters(in: .whitespaces)
        guard id.hasPrefix("si-") else { return nil }
        let rest = id.dropFirst(3)
        guard (1...76).contains(rest.count),
              rest.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") })
        else { return nil }
        return id
    }
}

extension BoardSnapshot {
    /// The inbox item an element's ref names (`BoardItemRef`), or nil.
    public func itemId(for ref: String?) -> String? {
        BoardItemRef.itemId(ref, info: self.ref(ref))
    }
}
