import XCTest

extension ArgentRunnerSession {
    /// Element types an agent can act on directly. These are always included.
    static let interactiveTypes: Set<XCUIElement.ElementType> = [
        .button, .cell, .checkBox, .collectionView, .datePicker, .link,
        .menuItem,
        .picker, .pickerWheel, .searchField, .segmentedControl, .slider,
        .stepper,
        .switch, .tabBar, .textField, .secureTextField, .textView, .toggle,
        .webView,
    ]

    /// Containers whose content scrolls. Included even when unlabeled so the
    /// tree shows where scrolling is possible.
    static let scrollContainerTypes: Set<XCUIElement.ElementType> = [
        .scrollView, .table, .collectionView, .webView,
    ]

    /// Hard ceiling on emitted nodes. Bounds the reply size for very deep trees.
    static let snapshotNodeBudget = 1500

    /// Guard against cyclic or extremely deep raw trees.
    private static let rawDepthLimit = 100

    /// Ceiling on emitted node depth.
    private static let emittedDepthLimit = 60

    /// Captures the app's accessibility tree and flattens it into a snapshot
    /// payload. The capture is retried once after a short pause: this is the
    /// one runner-side retry, kept here because the capture can read its own
    /// failure, a thrown error or an accessibility exception from a tree
    /// that moved mid-capture, and a moment is usually enough for the tree
    /// to settle. performOnMain only guards; the host retries read-only sends.
    func captureSnapshot(of app: XCUIApplication) -> Envelope {
        var root: XCUIElementSnapshot?
        var lastError = ""

        for attempt in 0..<2 {
            if attempt > 0 {
                NSLog("ARGENT_RUNNER_RETRY command=snapshot reason=%@", lastError)
                Thread.sleep(forTimeInterval: 0.4)
            }

            // One XPC round trip captures the whole tree. Flattening it in-process
            // avoids per-element AX queries and their stalls. The capture can throw
            // a Swift error or raise an accessibility NSException; the guard turns
            // the exception into a description instead of a crash.
            let exceptionDescription = ArgentExceptionGuard.runCatching {
                do {
                    root = try app.snapshot()
                } catch {
                    lastError = String(describing: error)
                }
            }

            if let exceptionDescription {
                lastError = exceptionDescription
            }

            if root != nil { break }
        }

        guard let root else {
            return .failure(
                .snapshotFailed,
                "XCTest could not capture the accessibility tree: \(lastError)",
                hint:
                    "Retry after the UI settles, or use screenshot as visual truth."
            )
        }

        let nodes = Self.flatten(root)
        let capped = nodes.count >= Self.snapshotNodeBudget

        return .success(
            SnapshotPayload(
                nodes: nodes,
                quality: SnapshotQualityPayload(
                    state: capped ? "degraded" : "healthy",
                    backend: "xctest",
                    reason: capped
                        ? "node budget reached; deeper content was dropped"
                        : nil,
                    reasonCode: capped ? "node_cap" : nil
                )
            )
        )
    }

    /// Flattens the snapshot tree into an ordered node list. Keeps elements an
    /// agent can name or act on, assigns indices and parent links in emission
    /// order, and dedupes mirror elements.
    static func flatten(_ root: XCUIElementSnapshot) -> [SnapshotNodePayload] {
        struct WorkItem {
            let snapshot: XCUIElementSnapshot
            let rawDepth: Int
            let emittedDepth: Int
            let parentIndex: Int
        }

        let viewport = root.frame
        var nodes = [makeNode(root, index: 0, depth: 0, parentIndex: nil)]
        var seen: Set<String> = [identity(root)]

        var stack = root.children.reversed().map {
            WorkItem(snapshot: $0, rawDepth: 1, emittedDepth: 1, parentIndex: 0)
        }

        while let item = stack.popLast() {
            if nodes.count >= snapshotNodeBudget { break }
            if item.rawDepth > rawDepthLimit { continue }

            let snapshot = item.snapshot
            let frame = snapshot.frame
            let visible =
                viewport.isEmpty
                || (!frame.isEmpty && viewport.intersects(frame))
            let include =
                visible && item.emittedDepth <= emittedDepthLimit
                && shouldInclude(snapshot)
            let key = identity(snapshot)
            let duplicate = seen.contains(key)

            var childParentIndex = item.parentIndex
            var childEmittedDepth = item.emittedDepth

            if include && !duplicate {
                seen.insert(key)

                let index = nodes.count

                nodes.append(
                    makeNode(
                        snapshot,
                        index: index,
                        depth: item.emittedDepth,
                        parentIndex: item.parentIndex
                    )
                )

                childParentIndex = index
                childEmittedDepth += 1
            }

            for child in snapshot.children.reversed() {
                stack.append(
                    WorkItem(
                        snapshot: child,
                        rawDepth: item.rawDepth + 1,
                        emittedDepth: childEmittedDepth,
                        parentIndex: childParentIndex
                    )
                )
            }
        }

        return nodes
    }

    /// Whether an element earns a node: interactive, a scroll container, or
    /// carrying any text.
    private static func shouldInclude(_ snapshot: XCUIElementSnapshot) -> Bool {
        if interactiveTypes.contains(snapshot.elementType) { return true }
        if scrollContainerTypes.contains(snapshot.elementType) { return true }

        return !snapshot.label.isEmpty || !snapshot.identifier.isEmpty
            || valueText(snapshot.value) != nil
    }

    /// Converts one element snapshot into a wire node payload.
    private static func makeNode(
        _ snapshot: XCUIElementSnapshot,
        index: Int,
        depth: Int,
        parentIndex: Int?
    ) -> SnapshotNodePayload {
        let frame = snapshot.frame

        return SnapshotNodePayload(
            index: index,
            type: elementTypeName(snapshot.elementType),
            label: snapshot.label.isEmpty ? nil : snapshot.label,
            identifier: snapshot.identifier.isEmpty ? nil : snapshot.identifier,
            value: valueText(snapshot.value),
            // A geometry-less element reports CGRect.null with an infinite origin,
            // and JSONEncoder rejects non-finite doubles. Coordinates are forced
            // finite so one such node cannot fail the whole encode.
            rect: SnapshotRect(
                x: finite(frame.minX),
                y: finite(frame.minY),
                width: finite(frame.width),
                height: finite(frame.height)
            ),
            enabled: snapshot.isEnabled,
            focused: snapshot.hasFocus ? true : nil,
            selected: snapshot.isSelected ? true : nil,
            depth: depth,
            parentIndex: parentIndex
        )
    }

    /// Dedup key for one node. Mirror elements surfaced twice by the AX tree
    /// share type, texts, and geometry and collapse to the same key.
    private static func identity(_ snapshot: XCUIElementSnapshot) -> String {
        let frame = snapshot.frame

        return
            "\(snapshot.elementType.rawValue)|\(snapshot.label)|\(snapshot.identifier)|"
            + "\(keyCoordinate(frame.minX)),\(keyCoordinate(frame.minY)),"
            + "\(keyCoordinate(frame.width)),\(keyCoordinate(frame.height))"
    }

    /// Stable dedup-key text for one frame coordinate. The key needs to be
    /// stable, not exact.
    private static func keyCoordinate(_ v: CGFloat) -> String {
        // Int(_: Double) traps on non-finite or out-of-range input, and a trap
        // kills the runner process. Geometry-less elements do reach here with
        // CGRect.null frames, so every conversion must be total.
        guard v.isFinite else { return String(describing: v) }

        return String(Int(min(max(v.rounded(), -1e15), 1e15)))
    }

    /// Collapses a non-finite coordinate to 0 for the wire payload.
    private static func finite(_ v: CGFloat) -> Double {
        v.isFinite ? Double(v) : 0
    }

    /// The element's value as wire text, nil when absent or empty.
    private static func valueText(_ value: Any?) -> String? {
        guard let value, !(value is NSNull) else { return nil }
        let text = String(describing: value)
        return text.isEmpty ? nil : text
    }

    /// Stable type names for the wire payload. The TypeScript describe adapter
    /// maps them onto accessibility roles.
    static func elementTypeName(_ type: XCUIElement.ElementType) -> String {
        switch type {
        case .any: return "Any"
        case .other: return "Other"
        case .application: return "Application"
        case .group: return "Group"
        case .window: return "Window"
        case .sheet: return "Sheet"
        case .drawer: return "Drawer"
        case .alert: return "Alert"
        case .dialog: return "Dialog"
        case .button: return "Button"
        case .radioButton: return "RadioButton"
        case .radioGroup: return "RadioGroup"
        case .checkBox: return "CheckBox"
        case .disclosureTriangle: return "DisclosureTriangle"
        case .popUpButton: return "PopUpButton"
        case .comboBox: return "ComboBox"
        case .menuButton: return "MenuButton"
        case .toolbarButton: return "ToolbarButton"
        case .popover: return "Popover"
        case .keyboard: return "Keyboard"
        case .key: return "Key"
        case .navigationBar: return "NavigationBar"
        case .tabBar: return "TabBar"
        case .tabGroup: return "TabGroup"
        case .toolbar: return "Toolbar"
        case .statusBar: return "StatusBar"
        case .table: return "Table"
        case .tableRow: return "TableRow"
        case .tableColumn: return "TableColumn"
        case .outline: return "Outline"
        case .outlineRow: return "OutlineRow"
        case .browser: return "Browser"
        case .collectionView: return "CollectionView"
        case .slider: return "Slider"
        case .pageIndicator: return "PageIndicator"
        case .progressIndicator: return "ProgressIndicator"
        case .activityIndicator: return "ActivityIndicator"
        case .segmentedControl: return "SegmentedControl"
        case .picker: return "Picker"
        case .pickerWheel: return "PickerWheel"
        case .switch: return "Switch"
        case .toggle: return "Toggle"
        case .link: return "Link"
        case .image: return "Image"
        case .icon: return "Icon"
        case .searchField: return "SearchField"
        case .scrollView: return "ScrollView"
        case .scrollBar: return "ScrollBar"
        case .staticText: return "StaticText"
        case .textField: return "TextField"
        case .secureTextField: return "SecureTextField"
        case .datePicker: return "DatePicker"
        case .textView: return "TextView"
        case .menu: return "Menu"
        case .menuItem: return "MenuItem"
        case .menuBar: return "MenuBar"
        case .menuBarItem: return "MenuBarItem"
        case .map: return "Map"
        case .webView: return "WebView"
        case .incrementArrow: return "IncrementArrow"
        case .decrementArrow: return "DecrementArrow"
        case .timeline: return "Timeline"
        case .ratingIndicator: return "RatingIndicator"
        case .valueIndicator: return "ValueIndicator"
        case .splitGroup: return "SplitGroup"
        case .splitter: return "Splitter"
        case .relevanceIndicator: return "RelevanceIndicator"
        case .colorWell: return "ColorWell"
        case .helpTag: return "HelpTag"
        case .matte: return "Matte"
        case .dockItem: return "DockItem"
        case .ruler: return "Ruler"
        case .rulerMarker: return "RulerMarker"
        case .grid: return "Grid"
        case .levelIndicator: return "LevelIndicator"
        case .cell: return "Cell"
        case .layoutArea: return "LayoutArea"
        case .layoutItem: return "LayoutItem"
        case .handle: return "Handle"
        case .stepper: return "Stepper"
        case .tab: return "Tab"
        case .touchBar: return "TouchBar"
        case .statusItem: return "StatusItem"
        @unknown default: return "Other"
        }
    }
}
