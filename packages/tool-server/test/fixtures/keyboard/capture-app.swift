import UIKit

// Fixture for "an app element wins over an on-screen keyboard key".
// No navigation bar: its "Done" would be smaller than the return key and win
// the tie today, hiding the bug.
final class FormVC: UIViewController, UITextFieldDelegate {
  let status = UILabel()
  // One accessibility element, no child text: a UIButton would expose its
  // title as a small static text, which already beats the key today.
  let doneButton = BigButton(title: "Done")

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    status.text = "status: none"
    status.accessibilityIdentifier = "status"

    // Return key "done" (id "Done").
    let name = field("Name", .default)
    name.returnKeyType = .done

    // Full-width app button, larger than the return key.
    doneButton.backgroundColor = .systemGray5
    doneButton.heightAnchor.constraint(equalToConstant: 44).isActive = true
    doneButton.addTarget(self, action: #selector(done), for: .touchUpInside)

    // Decimal pad: no return key, keys have no ids; an accessory "Done".
    let amount = field("Amount", .decimalPad)
    let bar = UIToolbar(frame: CGRect(x: 0, y: 0, width: 320, height: 44))
    bar.items = [
      UIBarButtonItem(barButtonSystemItem: .flexibleSpace, target: nil, action: nil),
      UIBarButtonItem(title: "Done", style: .done, target: self, action: #selector(accessoryDone)),
    ]
    amount.inputAccessoryView = bar

    // Return key "go" (id "Go") next to a row that only contains "Go".
    let website = field("Website", .URL)
    website.returnKeyType = .go
    let google = UILabel()
    google.text = "Google"

    // An app "Delete" above the keyboard, smaller than the covered one below.
    let delete = UIButton(type: .system)
    delete.setTitle("Delete", for: .normal)
    delete.addTarget(self, action: #selector(deleteTop), for: .touchUpInside)

    // `-twoDone`: a second, taller "Done" under the others (hidden otherwise,
    // which a stack view lays out as absent).
    let tallDone = BigButton(title: "Done")
    tallDone.backgroundColor = .systemGray4
    tallDone.heightAnchor.constraint(equalToConstant: 72).isActive = true
    tallDone.isHidden = !ProcessInfo.processInfo.arguments.contains("-twoDone")

    let stack = UIStackView(arrangedSubviews: [status, name, doneButton, amount, website, google, delete, tallDone])
    stack.axis = .vertical
    stack.spacing = 8
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)

    // `-coveredOnly`: leave only the covered "Delete", for the recorder case.
    delete.isHidden = ProcessInfo.processInfo.arguments.contains("-coveredOnly")

    // An app "Delete" the keyboard covers, one element under the decimal pad's
    // "Delete" key (which has no id).
    let covered = BigButton(title: "Delete")
    covered.backgroundColor = .systemGray6
    covered.translatesAutoresizingMaskIntoConstraints = false
    covered.addTarget(self, action: #selector(deleteCovered), for: .touchUpInside)
    view.addSubview(covered)

    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
      stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
      stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
      covered.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
      covered.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
      covered.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -20),
      covered.heightAnchor.constraint(equalToConstant: 120),
    ])
  }

  func field(_ placeholder: String, _ keyboard: UIKeyboardType) -> UITextField {
    let f = UITextField()
    f.placeholder = placeholder
    f.keyboardType = keyboard
    f.borderStyle = .roundedRect
    f.accessibilityIdentifier = placeholder.lowercased()
    f.delegate = self
    return f
  }

  func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    status.text = "status: return"
    textField.resignFirstResponder()
    return true
  }

  // Keeps the keyboard up, and hides itself, so only the key says "done".
  @objc func done() {
    status.text = "saved"
    doneButton.isHidden = true
  }

  @objc func accessoryDone() {
    status.text = "status: accessory"
    view.endEditing(true)
  }

  @objc func deleteTop() { status.text = "status: deleted" }
  @objc func deleteCovered() { status.text = "status: covered delete" }
}

final class BigButton: UIControl {
  init(title: String) {
    super.init(frame: .zero)
    let text = UILabel()
    text.text = title
    text.textColor = .systemBlue
    text.isAccessibilityElement = false
    text.translatesAutoresizingMaskIntoConstraints = false
    addSubview(text)
    NSLayoutConstraint.activate([
      text.centerXAnchor.constraint(equalTo: centerXAnchor),
      text.centerYAnchor.constraint(equalTo: centerYAnchor),
    ])
    isAccessibilityElement = true
    accessibilityLabel = title
    accessibilityTraits = .button
  }
  required init?(coder: NSCoder) { fatalError() }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  func scene(
    _ scene: UIScene, willConnectTo session: UISceneSession,
    options: UIScene.ConnectionOptions
  ) {
    guard let ws = scene as? UIWindowScene else { return }
    let w = UIWindow(windowScene: ws)
    w.rootViewController = FormVC()
    w.makeKeyAndVisible()
    window = w
  }
}

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
  func application(
    _ application: UIApplication,
    configurationForConnecting s: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let c = UISceneConfiguration(name: nil, sessionRole: s.role)
    c.delegateClass = SceneDelegate.self
    return c
  }
}
