import XCTest

extension ArgentRunnerSession {
    /// The dedicated answer for typing with no first responder.
    private static func textInputNotFocusedEnvelope() -> Envelope {
        .failure(
            .textInputNotFocused,
            "no text input has keyboard focus",
            hint: "Tap the target input first, then retry."
        )
    }

    /// Whether any element in the target app currently has keyboard focus.
    /// One scoped element query answers it. nil when the probe itself failed
    /// (a degraded tree must not block typing; the recorded-failure audit in
    /// performOnMain still covers the attempt).
    private func hasKeyboardFocus(in app: XCUIApplication) -> Bool? {
        var focused: Bool?
        let exceptionDescription = ArgentExceptionGuard.runCatching {
            focused =
                app.descendants(matching: .any)
                .matching(NSPredicate(format: "hasKeyboardFocus == true"))
                .firstMatch.exists
        }

        return exceptionDescription == nil ? focused : nil
    }

    /// Types text into whatever element currently has keyboard focus. The tool
    /// layer focuses an input with a tap before sending a type command.
    func performType(_ request: CommandRequest, on app: XCUIApplication)
        -> Envelope
    {
        guard let text = request.text, !text.isEmpty else {
            return .failure(.invalidRequest, "type requires non-empty text")
        }

        // Wait for the keyboard's presentation animation to finish.
        _ = app.keyboards.firstMatch.waitForExistence(timeout: 3)

        return typeGuarded(
            text,
            in: app,
            success: "typed \(text.count) characters",
            failure: "unable to type"
        )
    }

    /// Matches the keyboard's return key by label across the UIReturnKeyType
    /// variants an app can configure. Case-insensitive, so the lowercase "go"
    /// and "search" some keyboards show need no entry of their own. An OR of
    /// `==[c]` terms rather than `IN[c]`: Foundation ignores the [c] option
    /// on IN (checked on macOS, where "Return" fails `label IN[c] {"return"}`).
    private static let submitKeyPredicate = NSCompoundPredicate(
        orPredicateWithSubpredicates: [
            "return", "enter", "go", "search", "next", "done", "send", "join",
            "continue",
        ].map { NSPredicate(format: "label ==[c] %@", $0) }
    )

    /// Presses the keyboard's return or submit key.
    func performKeyboardReturn(on app: XCUIApplication) -> Envelope {
        // Prefer tapping the visible submit key. Its label carries the action the
        // app configured, such as Search or Go, and tapping works even when
        // typeText rejects the focus state.
        let keyboard = app.keyboards.firstMatch

        // Query only when a keyboard is visibly up, and then with one predicate
        // query per key collection. A label-by-label scan cost an exists and an
        // isHittable probe per candidate, each a live AX query, and on a heavy
        // screen the scan alone approached the 30s watchdog.
        if keyboard.exists && !keyboard.frame.isEmpty {
            let submitKey = Self.submitKeyPredicate

            for candidate in [
                app.keyboards.buttons.matching(submitKey).firstMatch,
                app.keyboards.keys.matching(submitKey).firstMatch,
            ] where candidate.exists && candidate.isHittable {
                let label = candidate.label
                candidate.tap()

                return .success(
                    MessagePayload(message: "pressed keyboard \(label)")
                )
            }
        }

        // No visible keyboard key matched, so the return character goes
        // through typeText, behind the same focus probe as `type`.
        return typeGuarded(
            XCUIKeyboardKey.return.rawValue,
            in: app,
            success: "typed return",
            failure: "unable to press the keyboard return key"
        )
    }

    /// Presses the keyboard's delete key once. Unlike return there is no
    /// labeled key to prefer, so the delete character always goes through
    /// typeText.
    func performKeyboardDelete(on app: XCUIApplication) -> Envelope {
        // Wait for the keyboard's presentation animation to finish.
        _ = app.keyboards.firstMatch.waitForExistence(timeout: 3)

        return typeGuarded(
            XCUIKeyboardKey.delete.rawValue,
            in: app,
            success: "typed delete",
            failure: "unable to press the keyboard delete key"
        )
    }

    /// Types `text` into the first responder behind the focus probe and the
    /// exception guard, and maps the outcome onto the wire. On hardware,
    /// typeText with no first responder RECORDS an XCTest failure instead of
    /// throwing, so the exception branch alone never fires and the reply
    /// would demote to the generic XCTEST_RECORDED_FAILURE (audited on an
    /// iPhone 15). The probe answers the common case with the dedicated code;
    /// only a probe that positively finds no focus refuses to type. typeText
    /// itself targets the first responder directly, with no element
    /// resolution, so typing works on screens whose accessibility trees
    /// degrade.
    private func typeGuarded(
        _ text: String,
        in app: XCUIApplication,
        success message: String,
        failure context: String
    ) -> Envelope {
        if hasKeyboardFocus(in: app) == false {
            return Self.textInputNotFocusedEnvelope()
        }

        let exceptionDescription = ArgentExceptionGuard.runCatching {
            app.typeText(text)
        }

        if let exceptionDescription {
            // Backstop for the runtimes where a missing first responder does
            // throw instead of recording.
            if exceptionDescription.contains("keyboard focus") {
                return Self.textInputNotFocusedEnvelope()
            }

            // XCTest throwing mid-command is a failed command, not hardware
            // the device lacks, so it answers COMMAND_FAILED like every other
            // command's exception does.
            return .failure(
                .commandFailed,
                "\(context): \(exceptionDescription)",
                hint:
                    "Re-observe the screen, tap the target input if it lost focus, then retry."
            )
        }

        return .success(MessagePayload(message: message))
    }
}
