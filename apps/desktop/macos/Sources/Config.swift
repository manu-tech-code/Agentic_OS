import Foundation

/// Where Nova is on this Mac, written into the app by `npm run app`.
struct ShellConfig: Decodable {
  /// The Nova checkout the daemon runs from.
  var repo: String
  /// Node, and the PATH the daemon - and the agents it starts - need (a login item gets almost none).
  var node: String
  var path: String
  /// The daemon's port (NOVA_PORT) and the settings file (NOVA_SETTINGS_FILE).
  var port: Int
  var settings: String
  /// The window's dev server: used while it runs (npm run dev), else the daemon serves the window.
  var devUi: String?

  static func load() -> ShellConfig? {
    guard let url = Bundle.main.url(forResource: "shell", withExtension: "json"), let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(ShellConfig.self, from: data)
  }

  var daemonSocket: URL { URL(string: "ws://127.0.0.1:\(port)")! }
  var daemonPage: URL { URL(string: "http://127.0.0.1:\(port)/")! }
  /// ~/.nova, where the settings file is.
  var home: URL { URL(fileURLWithPath: settings).deletingLastPathComponent() }

  /// Who runs the daemon (Settings → Menu bar), read straight from the settings file - the daemon
  /// may not be running to ask. Nova.app, unless the user said they run it themselves.
  func runsDaemon() -> Bool {
    guard let data = FileManager.default.contents(atPath: settings),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let presence = json["presence"] as? [String: Any],
          let daemon = presence["daemon"] as? String else { return true }
    return daemon != "terminal"
  }
}

/// Settings → Menu bar, as the daemon sends them.
struct PresenceConfig: Equatable {
  var shortcut = "option+space"
  /// "always", "window" or "shortcut": when the microphone listens for Nova's name.
  var listen = "always"
  var pauseWhenLocked = true
  var orb = "bottom-right"
  var orbSeconds = 6.0
  var sounds = true
  var launchAtLogin = true
  var daemon = "app"

  init() {}

  init(_ json: [String: Any]) {
    shortcut = json["shortcut"] as? String ?? shortcut
    listen = json["listen"] as? String ?? listen
    pauseWhenLocked = json["pauseWhenLocked"] as? Bool ?? pauseWhenLocked
    orb = json["orb"] as? String ?? orb
    orbSeconds = (json["orbSeconds"] as? NSNumber)?.doubleValue ?? orbSeconds
    sounds = json["sounds"] as? Bool ?? sounds
    launchAtLogin = json["launchAtLogin"] as? Bool ?? launchAtLogin
    daemon = json["daemon"] as? String ?? daemon
  }

  var json: [String: Any] {
    ["shortcut": shortcut, "listen": listen, "pauseWhenLocked": pauseWhenLocked, "orb": orb, "orbSeconds": orbSeconds, "sounds": sounds, "launchAtLogin": launchAtLogin, "daemon": daemon]
  }

  private static let defaultsKey = "lastPresence"

  /// What Settings said last time, kept on this Mac so the microphone behaves correctly from launch -
  /// before the daemon connects and says the real thing (shell-config).
  static func loadLast() -> PresenceConfig? {
    guard let data = UserDefaults.standard.data(forKey: defaultsKey), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return PresenceConfig(json)
  }

  func saveAsLast() {
    guard let data = try? JSONSerialization.data(withJSONObject: json) else { return }
    UserDefaults.standard.set(data, forKey: Self.defaultsKey)
  }
}
