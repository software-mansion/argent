import UIKit

/// Placeholder host application for the Argent runner's UI-test bundle.
///
/// It never participates in automation (every command targets another app by
/// bundle id), but XCUITest requires a host app to exist, and testmanagerd
/// launches it once when the session starts. The single black screen makes it
/// obvious on the device that the runner, not a user app, is frontmost.
@main
final class RunnerHostAppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    let controller = UIViewController()
    controller.view.backgroundColor = .black

    let label = UILabel()
    label.text = "Argent Runner"
    label.textColor = .white
    label.font = .systemFont(ofSize: 22, weight: .semibold)
    label.translatesAutoresizingMaskIntoConstraints = false
    controller.view.addSubview(label)
    NSLayoutConstraint.activate([
      label.centerXAnchor.constraint(equalTo: controller.view.centerXAnchor),
      label.centerYAnchor.constraint(equalTo: controller.view.centerYAnchor),
    ])

    let window = UIWindow(frame: UIScreen.main.bounds)
    window.rootViewController = controller
    window.makeKeyAndVisible()
    self.window = window
    return true
  }
}
