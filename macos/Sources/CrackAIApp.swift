import AppKit
import Foundation
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
  private var window: NSWindow!
  private var webView: WKWebView!
  private var statusItem: NSStatusItem!
  private var statusInfoMenuItem: NSMenuItem!
  private var serverProcess: Process?
  private var healthTimer: Timer?
  private let port = Int(ProcessInfo.processInfo.environment["CRACK_PORT"] ?? "8787") ?? 8787

  private var baseUrl: URL {
    URL(string: "http://127.0.0.1:\(port)")!
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    setupMainMenu()
    setupStatusBar()
    setupWindow()
    ensureServerRunningThenLoad()
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag {
      showMainWindow()
    }
    return true
  }

  func applicationWillTerminate(_ notification: Notification) {
    healthTimer?.invalidate()
    if let proc = serverProcess, proc.isRunning {
      proc.terminate()
    }
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    sender.orderOut(nil)
    return false
  }

  private func setupMainMenu() {
    let mainMenu = NSMenu()
    let appMenuItem = NSMenuItem()
    mainMenu.addItem(appMenuItem)

    let appMenu = NSMenu()
    appMenu.addItem(NSMenuItem(title: "CRACK 창 열기", action: #selector(showMainWindow), keyEquivalent: "o"))
    appMenu.addItem(NSMenuItem(title: "새로고침", action: #selector(reloadWebView), keyEquivalent: "r"))
    appMenu.addItem(NSMenuItem(title: "창 닫기", action: #selector(closeCurrentWindow), keyEquivalent: "w"))
    appMenu.addItem(.separator())
    appMenu.addItem(NSMenuItem(title: "CRACK 종료", action: #selector(quitApp), keyEquivalent: "q"))
    appMenuItem.submenu = appMenu

    let editMenuItem = NSMenuItem()
    mainMenu.addItem(editMenuItem)
    let editMenu = NSMenu(title: "편집")
    editMenu.addItem(NSMenuItem(title: "실행 취소", action: Selector(("undo:")), keyEquivalent: "z"))
    editMenu.addItem(NSMenuItem(title: "잘라내기", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
    editMenu.addItem(NSMenuItem(title: "복사", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
    editMenu.addItem(NSMenuItem(title: "붙여넣기", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
    editMenu.addItem(NSMenuItem(title: "전체 선택", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
    editMenuItem.submenu = editMenu

    NSApp.mainMenu = mainMenu
  }

  private func setupStatusBar() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let button = statusItem.button {
      button.title = "✦"
      button.toolTip = "CRACK AI · 인터랙티브 캐릭터 챗"
    }

    let menu = NSMenu()
    statusInfoMenuItem = NSMenuItem(title: "CRACK AI 서버 준비 중...", action: nil, keyEquivalent: "")
    statusInfoMenuItem.isEnabled = false
    menu.addItem(statusInfoMenuItem)
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "CRACK 앱 열기", action: #selector(showMainWindow), keyEquivalent: ""))
    menu.addItem(NSMenuItem(title: "브라우저(웹 사이트)로 열기", action: #selector(openInBrowser), keyEquivalent: ""))
    menu.addItem(NSMenuItem(title: "Google AI Studio 무료 키 발급 ↗", action: #selector(openAiStudio), keyEquivalent: ""))
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "종료", action: #selector(quitApp), keyEquivalent: ""))
    statusItem.menu = menu
  }

  private func setupWindow() {
    let config = WKWebViewConfiguration()
    config.defaultWebpagePreferences.allowsContentJavaScript = true

    webView = WKWebView(frame: .zero, configuration: config)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.setValue(false, forKey: "drawsBackground")

    let frame = NSRect(x: 0, y: 0, width: 1320, height: 860)
    window = NSWindow(
      contentRect: frame,
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "CRACK · AI 캐릭터 챗 & 인터랙티브 스토리"
    window.minSize = NSSize(width: 440, height: 640)
    window.center()
    window.backgroundColor = NSColor(calibratedRed: 0.031, green: 0.031, blue: 0.055, alpha: 1.0)
    window.appearance = NSAppearance(named: .darkAqua)
    window.delegate = self
    window.contentView = webView
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  // MARK: - Server Lifecycle
  private func resolveNodeBinary() -> String {
    let candidates = [
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
    ]
    for path in candidates {
      if FileManager.default.isExecutableFile(atPath: path) {
        return path
      }
    }
    return "/opt/homebrew/bin/node"
  }

  private func resolveServerCliPath() -> String? {
    if let resPath = Bundle.main.resourcePath {
      let bundled = (resPath as NSString).appendingPathComponent("app/bin/crack-ai.mjs")
      if FileManager.default.fileExists(atPath: bundled) {
        return bundled
      }
    }
    let bundleDir = (Bundle.main.bundlePath as NSString).deletingLastPathComponent
    let localCli = (bundleDir as NSString).appendingPathComponent("bin/crack-ai.mjs")
    if FileManager.default.fileExists(atPath: localCli) {
      return localCli
    }
    return nil
  }

  private func checkServerHealth(completion: @escaping (Bool, [String: Any]?) -> Void) {
    let url = baseUrl.appendingPathComponent("api/health")
    var req = URLRequest(url: url, timeoutInterval: 1.5)
    req.cachePolicy = .reloadIgnoringLocalCacheData
    URLSession.shared.dataTask(with: req) { data, response, _ in
      guard let http = response as? HTTPURLResponse, http.statusCode == 200,
            let data,
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        DispatchQueue.main.async { completion(false, nil) }
        return
      }
      DispatchQueue.main.async { completion(true, obj) }
    }.resume()
  }

  private func ensureServerRunningThenLoad() {
    checkServerHealth { [weak self] alive, info in
      guard let self else { return }
      if alive {
        self.updateStatusMenu(from: info)
        self.loadApp()
        self.startHealthPolling()
      } else {
        self.startEmbeddedServer()
        self.waitForServerAndLoad(attempts: 25)
      }
    }
  }

  private func startEmbeddedServer() {
    guard serverProcess == nil else { return }
    guard let cliPath = resolveServerCliPath() else {
      showErrorPage("CRACK AI 서버 파일을 찾을 수 없습니다.")
      return
    }
    let nodeBin = resolveNodeBinary()
    guard FileManager.default.isExecutableFile(atPath: nodeBin) else {
      showErrorPage("Node.js 런타임을 찾을 수 없습니다. (/opt/homebrew/bin/node)")
      return
    }

    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: nodeBin)
    proc.arguments = [cliPath, "server"]
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    env["CRACK_PORT"] = "\(port)"
    proc.environment = env

    do {
      try proc.run()
      serverProcess = proc
    } catch {
      showErrorPage("내장 서버 시작 실패: \(error.localizedDescription)")
    }
  }

  private func waitForServerAndLoad(attempts: Int) {
    if attempts <= 0 {
      showErrorPage("로컬 서버 응답 대기 시간이 초과되었습니다.")
      return
    }
    checkServerHealth { [weak self] alive, info in
      guard let self else { return }
      if alive {
        self.updateStatusMenu(from: info)
        self.loadApp()
        self.startHealthPolling()
      } else {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
          self.waitForServerAndLoad(attempts: attempts - 1)
        }
      }
    }
  }

  private func startHealthPolling() {
    healthTimer?.invalidate()
    healthTimer = Timer.scheduledTimer(withTimeInterval: 30.0, repeats: true) { [weak self] _ in
      self?.checkServerHealth { alive, info in
        if alive { self?.updateStatusMenu(from: info) }
      }
    }
  }

  private func updateStatusMenu(from info: [String: Any]?) {
    guard let info else { return }
    let hasKey = info["hasApiKey"] as? Bool ?? false
    let model = info["defaultModel"] as? String ?? "gemini-3.8-flash"
    statusInfoMenuItem.title = hasKey ? "✦ \(model) 연결됨" : "미리보기 모드 (API 키 미설정)"
  }

  private func loadApp() {
    webView.load(URLRequest(url: baseUrl))
  }

  private func showErrorPage(_ message: String) {
    let html = """
    <html><body style="background:#08080e;color:#f6f6fc;font-family:-apple-system;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;">
    <div><h2>CRACK AI 시작 오류</h2><p style="color:#9e9eb8;">\(message)</p></div>
    </body></html>
    """
    webView.loadHTMLString(html, baseURL: nil)
  }

  // MARK: - WKWebView Navigation & Native Dialogs / File Upload
  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    if let url = navigationAction.request.url {
      let host = url.host ?? ""
      if host != "127.0.0.1" && host != "localhost" && !host.isEmpty {
        NSWorkspace.shared.open(url)
        decisionHandler(.cancel)
        return
      }
      if url.path.hasSuffix("/export") {
        NSWorkspace.shared.open(url)
        decisionHandler(.cancel)
        return
      }
    }
    decisionHandler(.allow)
  }

  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = navigationAction.request.url {
      NSWorkspace.shared.open(url)
    }
    return nil
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptAlertPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping () -> Void
  ) {
    let alert = NSAlert()
    alert.messageText = "CRACK"
    alert.informativeText = message
    alert.addButton(withTitle: "확인")
    alert.beginSheetModal(for: window) { _ in completionHandler() }
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptConfirmPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping (Bool) -> Void
  ) {
    let alert = NSAlert()
    alert.messageText = "CRACK"
    alert.informativeText = message
    alert.addButton(withTitle: "확인")
    alert.addButton(withTitle: "취소")
    alert.beginSheetModal(for: window) { resp in
      completionHandler(resp == .alertFirstButtonReturn)
    }
  }

  func webView(
    _ webView: WKWebView,
    runOpenPanelWith parameters: WKOpenPanelParameters,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping ([URL]?) -> Void
  ) {
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.beginSheetModal(for: window) { response in
      completionHandler(response == .OK ? panel.urls : nil)
    }
  }

  // MARK: - Actions
  @objc private func showMainWindow() {
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  @objc private func closeCurrentWindow() {
    window.performClose(nil)
  }

  @objc private func reloadWebView() {
    webView.reload()
  }

  @objc private func openInBrowser() {
    NSWorkspace.shared.open(baseUrl)
  }

  @objc private func openAiStudio() {
    if let url = URL(string: "https://aistudio.google.com/apikey") {
      NSWorkspace.shared.open(url)
    }
  }

  @objc private func quitApp() {
    NSApp.terminate(nil)
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
