import XCTest

/// Exact live-element resolution and tapping for the `tapElement` command.
///
/// Kept independent of `ArgentRunnerSession` so a fixture UI-test target can
/// compile this file with RunnerProtocol.swift and exercise the production
/// query/action path against its own XCUIApplication.
enum NativeElementTap {
    /// Resolves exactly one live XCUIElement and taps it directly.
    static func perform(_ request: CommandRequest, on app: XCUIApplication)
        -> Envelope
    {
        guard let selector = request.selector,
            selector.identifier?.isEmpty != true,
            selector.label?.isEmpty != true,
            selector.role?.isEmpty != true,
            selector.identifier != nil || selector.label != nil
        else {
            return .failure(
                .invalidRequest,
                "tapElement requires non-empty selector fields and an identifier or label"
            )
        }

        guard request.numberOfTaps == nil || request.numberOfTaps == 1 else {
            return .failure(
                .invalidRequest,
                "tapElement supports a single tap only"
            )
        }

        var predicates: [NSPredicate] = []
        if let identifier = selector.identifier {
            predicates.append(NSPredicate(format: "identifier == %@", identifier))
        }
        if let label = selector.label {
            predicates.append(NSPredicate(format: "label == %@", label))
        }
        if let role = selector.role {
            guard let types = elementTypes(for: role) else { return elementNotFound() }
            let rawTypes = types.map { NSNumber(value: $0.rawValue) }
            predicates.append(NSPredicate(format: "elementType IN %@", rawTypes))
        }

        let predicate = NSCompoundPredicate(andPredicateWithSubpredicates: predicates)
        let query = app.descendants(matching: .any).matching(predicate)
        let matchCount = query.count

        guard matchCount > 0 else {
            return elementNotFound()
        }
        guard matchCount == 1 else {
            return .failure(
                .elementAmbiguous,
                "tapElement matched multiple elements",
                hint: "Add another exact selector field so exactly one live element matches."
            )
        }

        // Resolve through the unique live query rather than an indexed snapshot
        // of candidates. If the hierarchy changes, XCTest re-evaluates this
        // same full selector instead of retargeting a stored index.
        let element = query.element
        guard element.isEnabled, element.isHittable else {
            return .failure(
                .elementNotInteractable,
                "tapElement matched an element that is disabled or not hittable",
                hint: "Wait for the element to become enabled and hittable, then retry."
            )
        }

        element.tap()
        return .success(MessagePayload(message: "tapped"))
    }

    private static func elementNotFound() -> Envelope {
        .failure(
            .elementNotFound,
            "tapElement found no matching element",
            hint: "Re-observe the screen and use a selector that identifies one live element."
        )
    }

    private static func elementTypes(for role: String) -> [XCUIElement.ElementType]? {
        switch role {
        case "AXButton": return [.button, .checkBox, .menuItem, .cell]
        case "AXStaticText": return [.staticText]
        case "AXImage": return [.image]
        case "AXLink": return [.link]
        case "AXTextField": return [.textField, .secureTextField, .searchField, .textView]
        case "AXTabBar": return [.tabBar]
        case "AXAdjustable":
            return [.switch, .toggle, .slider, .stepper, .datePicker, .picker, .pickerWheel]
        default: return nil
        }
    }
}
