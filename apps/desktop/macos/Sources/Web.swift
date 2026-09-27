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
  private var retry: DispatchWorkItem?

  init(transparent: Bool, address: @escaping () -> URL) {
    self.address = address
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
    if let body = message.body as? [String: Any] { onMessage(body) }
  }

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

  /// Links to anywhere else open in the browser, not in Nova.
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if let url = action.request.url, action.navigationType == .linkActivated, url.host != address().host {
      NSWorkspace.shared.open(url)
      return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url { NSWorkspace.shared.open(url) }
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
