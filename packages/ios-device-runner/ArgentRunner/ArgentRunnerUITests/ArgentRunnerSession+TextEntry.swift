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

        // On hardware, typeText with no first responder RECORDS an XCTest
        // failure instead of throwing, so the exception branch below never
        // fires and the reply would demote to the generic
        // XCTEST_RECORDED_FAILURE (audited on an iPhone 15). Probe focus
        // first to answer the common case with the dedicated code; only a
        // probe that positively finds no focus refuses to type.
        if hasKeyboardFocus(in: app) == false {
            return Self.textInputNotFocusedEnvelope()
        }

        // typeText targets the first responder directly, with no element
        // resolution, so typing works on screens whose accessibility trees
        // degrade.
        let exceptionDescription = ArgentExceptionGuard.runCatching {
            app.typeText(text)
        }

        if let exceptionDescription {
            // Backstop for the runtimes where a missing first responder does
            // throw instead of recording.
            if exceptionDescription.contains("keyboard focus") {
                return Self.textInputNotFocusedEnvelope()
            }

            return .failure(.commandFailed, exceptionDescription)
        }

        return .success(
            MessagePayload(message: "typed \(text.count) characters")
        )
    }

    /// Presses the keyboard's return or submit key.
    func performKeyboardReturn(on app: XCUIApplication) -> Envelope {
        // Prefer tapping the visible submit key. Its label carries the action the
        // app configured, such as Search or Go, and tapping works even when
        // typeText rejects the focus state.
        let keyboard = app.keyboards.firstMatch

        // Scan only when a keyboard is visibly up. Each exists/isHittable probe
        // is a live AX query, and a full scan on a heavy screen with no keyboard
        // can run into the 30s watchdog.
        if keyboard.exists && !keyboard.frame.isEmpty {
            for label in [
                "return", "Return", "Enter", "Go", "go", "Search", "search",
                "Next", "Done", "Send", "Join", "Continue",
            ] {
                for candidate in [
                    app.keyboards.buttons[label], app.keyboards.keys[label],
                ] {
                    if candidate.exists && candidate.isHittable {
                        candidate.tap()

                        return .success(
                            MessagePayload(message: "pressed keyboard \(label)")
                        )
                    }
                }
            }
        }

        // No visible keyboard key matched, so the return character goes
        // through typeText, whose no-first-responder failure mode is the same
        // recorded-not-thrown shape as performType's: without the probe it
        // would demote to the generic XCTEST_RECORDED_FAILURE. Same dedicated
        // answer, same only-on-positive-verdict rule.
        if hasKeyboardFocus(in: app) == false {
            return Self.textInputNotFocusedEnvelope()
        }

        // Fall back to typing the return character.
        let exceptionDescription = ArgentExceptionGuard.runCatching {
            app.typeText(XCUIKeyboardKey.return.rawValue)
        }

        if let exceptionDescription {
            return .failure(
                .unsupportedOperation,
                "unable to press the keyboard return key: \(exceptionDescription)",
                hint: "Focus a text input first (tap it), then retry."
            )
        }

        return .success(MessagePayload(message: "typed return"))
    }

    /// Presses the keyboard's delete key once. Unlike return there is no
    /// labeled key to prefer, so the delete character always goes through
    /// typeText.
    func performKeyboardDelete(on app: XCUIApplication) -> Envelope {
        // Wait for the keyboard's presentation animation to finish.
        _ = app.keyboards.firstMatch.waitForExistence(timeout: 3)

        // typeText's no-first-responder failure mode is the same
        // recorded-not-thrown shape performType documents. Same dedicated
        // answer, same only-on-positive-verdict rule.
        if hasKeyboardFocus(in: app) == false {
            return Self.textInputNotFocusedEnvelope()
        }

        let exceptionDescription = ArgentExceptionGuard.runCatching {
            app.typeText(XCUIKeyboardKey.delete.rawValue)
        }

        if let exceptionDescription {
            return .failure(
                .unsupportedOperation,
                "unable to press the keyboard delete key: \(exceptionDescription)",
                hint: "Focus a text input first (tap it), then retry."
            )
        }

        return .success(MessagePayload(message: "typed delete"))
    }
}
