import AppKit
import WebKit

/// Nova's page, shown by the app (in the orb and the window). The page gets no microphone or
/// camera - the app hears for Nova - and talks to the app through `window.webkit.messageHandlers.nova`;
/// the app answers through `window.novaShell`.
final class WebHost: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
  var onMessage: ([String: Any]) -> Void = { _ in }
  /// The page (re)loaded: it needs to hear the app's state again.
  var onLoad: () -> Void = {}
  let view: WKWebView
  /// Where to load from - asked again after a failure (the dev server may have stopped).
  private let address: () -> URL
  /// Origins ("scheme://host:port") this page is allowed to talk to the app from and navigate to:
  /// the daemon's own address, and the dev server while it's confirmed to be Nova's and switched on.
  /// Whatever else answers on the same machine - another Vite project, a page that redirected itself
  /// somewhere else - is a stranger, never handed the microphone or a place to navigate the window to.
  private let allowedOrigins: () -> Set<String>
  private var retry: DispatchWorkItem?

  init(transparent: Bool, allowedOrigins: @escaping () -> Set<String>, address: @escaping () -> URL) {
    self.address = address
    self.allowedOrigins = allowedOrigins
    let config = WKWebViewConfiguration()
    config.mediaTypesRequiringUserActionForPlayback = []
    view = WKWebView(frame: .zero, configuration: config)
    super.init()
    config.userContentController.add(WeakHandler(self), name: "nova")
    if transparent {
      view.setValue(false, forKey: "drawsBackground")
      view.underPageBackgroundColor = .clear
    }
    view.navigationDelegate = self
    view.uiDelegate = self
    view.isInspectable = true // Safari → Develop can inspect it
    reload()
  }

  func reload() {
    retry?.cancel()
    view.load(URLRequest(url: address(), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5))
  }

  /// Tell the page something: `window.novaShell.<name>(<value>)`.
  func call(_ name: String, _ value: Any) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]), let json = String(data: data, encoding: .utf8) else { return }
    view.evaluateJavaScript("window.novaShell && window.novaShell.\(name)(\(json))", completionHandler: nil)
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    // Only Nova's own page, its main frame - never an iframe it happens to contain, and never a
    // stranger sharing the port - may unmute the microphone, resize the HUD, or ask to expand it.
    guard message.frameInfo.isMainFrame, allowedOrigins().contains(WebHost.originString(message.frameInfo.securityOrigin)) else { return }
    if let body = message.body as? [String: Any] { onMessage(body) }
  }

  /// "scheme://host:port", so a page's declared origin and a trusted URL's can be compared exactly
  /// (unlike a bare host, this can't be fooled by a different scheme or port on the same host).
  static func originString(_ origin: WKSecurityOrigin) -> String { "\(origin.protocol)://\(origin.host):\(origin.port)" }

  static func originString(_ url: URL) -> String? {
    guard let scheme = url.scheme, let host = url.host else { return nil }
    return "\(scheme)://\(host):\(url.port ?? (scheme == "https" ? 443 : 80))"
  }

  /// Only http(s) ever gets handed to NSWorkspace - never file:, a custom scheme, or anything else a
  /// page could use to reach past the browser and into some other app.
  static func isExternal(_ url: URL) -> Bool { url.scheme == "http" || url.scheme == "https" }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { onLoad() }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { again() }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { again() }

  /// The page couldn't load (the daemon is still starting): try again shortly.
  private func again() {
    retry?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.reload() }
    retry = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: work)
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { reload() }

  /// The page never gets the microphone or camera.
  func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
               type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    decisionHandler(.deny)
  }

  /// Any navigation - a clicked link, a redirect, a form, script that sets location - to anywhere but
  /// Nova's own page opens in the browser instead (only if it's a page at all) and never happens
  /// inside Nova's own views: a stranger's page never gets to load where the microphone answers to.
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { return decisionHandler(.allow) }
    if let origin = WebHost.originString(url), allowedOrigins().contains(origin) { return decisionHandler(.allow) }
    if WebHost.isExternal(url) { NSWorkspace.shared.open(url) }
    decisionHandler(.cancel)
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url, WebHost.isExternal(url) { NSWorkspace.shared.open(url) }
    return nil
  }

  // The page's confirm() and alert() ("Forget all memories?") as Mac alerts.
  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    completionHandler(alert.runModal() == .alertFirstButtonReturn)
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.runModal()
    completionHandler()
  }
}

/// WebKit keeps its message handlers alive; this keeps the page from keeping the app's objects alive.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
  weak var target: WKScriptMessageHandler?

  init(_ target: WKScriptMessageHandler) {
    self.target = target
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.userContentController(controller, didReceive: message)
  }
}
