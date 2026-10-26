import AVFoundation
import ExpoModulesCore
import Security
import UIKit

@ExpoModule("MinesNativeControls")
public final class MinesNativeControlsModule: Module {
  private let presentationSources = MinesPresentationSources()
  private var videoPresentation: MinesNativeVideoPresentation?
  private var filePresentation: MinesNativeFilePresentation?

  public func definition() -> ModuleDefinition {
    Constants {
      if #available(iOS 26.0, *) {
        return [
          "supportsWorkspaceColumns": NSClassFromString("RNSSplitHostComponentView") != nil,
        ]
      }
      return ["supportsWorkspaceColumns": false]
    }
    View(MinesSegmentedControlView.self) {
      ViewName("SegmentedControl")
      Events("onSelectionChange")
      Prop("labels") { (view: MinesSegmentedControlView, value: [String]) in view.labels = value }
      Prop("selectedIndex") { (view: MinesSegmentedControlView, value: Int) in view.selectedIndex = value }
      Prop("trackColor") { (view: MinesSegmentedControlView, value: UIColor) in view.trackColor = value }
      Prop("selectedColor") { (view: MinesSegmentedControlView, value: UIColor) in view.selectedColor = value }
      Prop("textColor") { (view: MinesSegmentedControlView, value: UIColor) in view.textColor = value }
      Prop("mutedColor") { (view: MinesSegmentedControlView, value: UIColor) in view.mutedColor = value }
      Prop("appearance") { (view: MinesSegmentedControlView, value: String) in view.appearance = value }
    }

    View(MinesSidebarTabBarView.self) {
      ViewName("SidebarTabBar")
      Events("onSelectionChange", "onCompose")
      Prop("tabs") { (view: MinesSidebarTabBarView, value: [String]) in view.tabs = value }
      Prop("selectedTab") { (view: MinesSidebarTabBarView, value: String) in view.selectedTab = value }
      Prop("selectedColor") { (view: MinesSidebarTabBarView, value: UIColor) in view.selectedColor = value }
      Prop("showsCompose") { (view: MinesSidebarTabBarView, value: Bool) in view.showsCompose = value }
      Prop("compact") { (view: MinesSidebarTabBarView, value: Bool) in view.compact = value }
      Prop("appearance") { (view: MinesSidebarTabBarView, value: String) in view.appearance = value }
    }

    View(MinesLayoutMetricsView.self) {
      ViewName("LayoutMetrics")
      Events("onMetricsChange")
    }

    View(MinesScrollEdgeBleedView.self) {
      ViewName("ScrollEdgeBleed")
    }

    AsyncFunction("presentVideo") { (url: URL, title: String, sourceIdentifier: String, identifier: String, promise: Promise) in
      try self.presentVideo(
        url: url,
        title: title,
        sourceIdentifier: sourceIdentifier,
        identifier: identifier,
        promise: promise
      )
    }.runOnQueue(.main)

    AsyncFunction("presentFile") { (url: URL, title: String, sourceIdentifier: String, identifier: String, promise: Promise) in
      try self.presentFile(url: url, title: title, sourceIdentifier: sourceIdentifier,
                           identifier: identifier, promise: promise)
    }.runOnQueue(.main)

    AsyncFunction("presentFiles") { (urls: [URL], titles: [String], selectedIndex: Int, sourceIdentifiers: [String], identifier: String, promise: Promise) in
      guard !urls.isEmpty, urls.count == titles.count, urls.count == sourceIdentifiers.count,
        urls.indices.contains(selectedIndex)
      else {
        throw URLError(.badURL)
      }
      let file = try self.makeFilePresentation(sourceIdentifiers: sourceIdentifiers, identifier: identifier,
                                               promise: promise)
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        file.dismiss()
        return
      }
      file.present(urls: urls, titles: titles, selectedIndex: selectedIndex, from: presenter)
    }.runOnQueue(.main)

    OnDestroy {
      let presentation = self.videoPresentation
      let file = self.filePresentation
      DispatchQueue.main.async {
        presentation?.dismiss()
        file?.dismiss()
      }
    }

    View(MinesPresentationSourceView.self) {
      ViewName("PresentationSource")
      Prop("identifier") { (view: MinesPresentationSourceView, identifier: String) in
        view.sources = self.presentationSources
        view.identifier = identifier
      }
    }

    View(MinesFrostedCutoutView.self) {
      ViewName("FrostedCutout")
      Prop("cutoutTop") { (view: MinesFrostedCutoutView, value: Double) in view.cutoutTop = CGFloat(value) }
      Prop("cutoutWidth") { (view: MinesFrostedCutoutView, value: Double) in view.cutoutWidth = CGFloat(value) }
      Prop("cutoutHeight") { (view: MinesFrostedCutoutView, value: Double) in view.cutoutHeight = CGFloat(value) }
      Prop("cutoutRadius") { (view: MinesFrostedCutoutView, value: Double) in view.cutoutRadius = CGFloat(value) }
      Prop("appearance") { (view: MinesFrostedCutoutView, value: String) in view.appearance = value }
    }

    View(MinesContextSheetSizeView.self) {
      ViewName("ContextSheetSize")
      Prop("contentHeight") { (view: MinesContextSheetSizeView, height: Double) in
        view.contentHeight = CGFloat(height)
      }
    }

    AsyncFunction("shareFileFromSource") { (url: URL, title: String, identifier: String, promise: Promise) in
      try self.shareFile(url: url, title: title, sourceIdentifier: identifier, promise: promise)
    }.runOnQueue(.main)
  }

  // UIKit presenters are main-actor isolated rather than run on the JS thread
  // the macro would otherwise pick.
  @JS
  @MainActor
  func dismissVideo(identifier: String) async {
    dismissVideoPresentation(identifier: identifier)
  }

  // expo-video activates the session for inline playback but never deactivates
  // it. Any other category or mode means another feature (recording) owns it.
  @JS
  @MainActor
  func releaseVideoAudioSession() async {
    // The fullscreen presentation releases the session in its own teardown.
    guard videoPresentation == nil else { return }
    let session = AVAudioSession.sharedInstance()
    guard session.category == .playback, session.mode == .moviePlayback else { return }
    try? session.setActive(false, options: [.notifyOthersOnDeactivation])
  }

  @JS
  @MainActor
  func dismissFile(identifier: String) async {
    dismissFilePresentation(identifier: identifier)
  }

  // Rotates the interface without Simulator menu UI scripting, which CI
  // runners cannot perform (osascript is denied Accessibility access there).
  @JS
  @MainActor
  func applyShowcaseOrientation(orientation: String) async {
    let mask: UIInterfaceOrientationMask = orientation == "landscape" ? .landscapeRight : .portrait
    for case let windowScene as UIWindowScene in UIApplication.shared.connectedScenes {
      windowScene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { error in
        NSLog("MinesNativeControls applyShowcaseOrientation(\(orientation)) failed: \(error)")
      }
      for window in windowScene.windows {
        window.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
      }
    }
  }

  // Geometry requests can fail before foreground activation; callers retry until bounds match.
  // Use screen bounds because iPadOS floating-window orientation can differ from the captured framebuffer.
  @JS
  @MainActor
  func getInterfaceOrientation() async -> String {
    guard
      let windowScene = UIApplication.shared.connectedScenes
        .compactMap({ $0 as? UIWindowScene })
        .first
    else {
      return "unknown"
    }
    let bounds = windowScene.screen.coordinateSpace.bounds
    return bounds.width > bounds.height ? "landscape" : "portrait"
  }

  @JS
  @MainActor
  func isProtectedDataAvailable() async -> Bool {
    UIApplication.shared.isProtectedDataAvailable
  }

  private func launchArgument(_ flag: String) -> String? {
    let arguments = ProcessInfo.processInfo.arguments
    guard
      let flagIndex = arguments.firstIndex(of: flag),
      arguments.indices.contains(flagIndex + 1)
    else {
      return nil
    }
    return arguments[flagIndex + 1]
  }

  @JS
  func getShowcasePairingUrl() -> String? {
    launchArgument("--showcasePairingUrl")
  }

  @JS
  func getShowcaseScene() -> String? {
    let scenePath = NSHomeDirectory() + "/Library/Caches/MinesShowcaseScene"
    if let storedScene = try? String(contentsOfFile: scenePath, encoding: .utf8)
      .trimmingCharacters(in: .whitespacesAndNewlines), !storedScene.isEmpty {
      return storedScene
    }
    return launchArgument("--showcaseScene")
  }

  // The palette is fixed for the whole capture, so it only ever arrives as a
  // launch argument — unlike the scene, which the runner rewrites in place.
  @JS
  func getShowcaseTheme() -> String? {
    launchArgument("--showcaseTheme")
  }

  @JS
  func getShowcaseOrientation() -> String? {
    launchArgument("--showcaseOrientation")
  }

  @JS
  func prepareShowcaseCapture() {
    for itemClass in [kSecClassGenericPassword, kSecClassInternetPassword] {
      SecItemDelete([kSecClass as String: itemClass] as CFDictionary)
    }
  }

  @JS(.concurrent)
  func markShowcaseReady(scene: String) async {
    let readyPath = NSHomeDirectory() + "/Library/Caches/MinesShowcaseReadyScene"
    try? scene.write(toFile: readyPath, atomically: true, encoding: .utf8)
  }

  private func presentVideo(url: URL, title: String, sourceIdentifier: String, identifier: String, promise: Promise) throws {
    let isPlayableURL = url.isFileURL
      ? FileManager.default.isReadableFile(atPath: url.path)
      : (["https", "http"].contains(url.scheme?.lowercased() ?? "") && url.host != nil)
    guard videoPresentation == nil, filePresentation == nil,
      let presenter = appContext?.utilities?.currentViewController(),
      isPlayableURL
    else {
      throw NSError(
        domain: "MinesNativeVideo",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "The video preview is no longer available."]
      )
    }
    let presentation = MinesNativeVideoPresentation(identifier: identifier, url: url, title: title) { [weak self] error in
      self?.videoPresentation = nil
      if let error { promise.reject(error) } else { promise.resolve(nil) }
    }
    videoPresentation = presentation
    presentation.present(from: presenter, sources: presentationSources, sourceIdentifier: sourceIdentifier)
  }

  private func dismissVideoPresentation(identifier: String) {
    if videoPresentation?.identifier == identifier { videoPresentation?.dismiss() }
  }

  private func makeFilePresentation(sourceIdentifiers: [String], identifier: String,
                                    promise: Promise) throws -> MinesNativeFilePresentation {
    guard filePresentation == nil, videoPresentation == nil,
      appContext?.utilities?.currentViewController() != nil
    else { throw URLError(.cannotLoadFromNetwork) }
    let file = MinesNativeFilePresentation(identifier: identifier, sources: presentationSources,
                                        sourceIdentifiers: sourceIdentifiers) { [weak self] error in
      self?.filePresentation = nil
      if let error { promise.reject(error) } else { promise.resolve(nil) }
    }
    filePresentation = file
    return file
  }

  private func presentFile(url: URL, title: String, sourceIdentifier: String,
                           identifier: String, promise: Promise) throws {
    let file = try makeFilePresentation(sourceIdentifiers: [sourceIdentifier], identifier: identifier, promise: promise)
    guard let presenter = appContext?.utilities?.currentViewController() else { file.dismiss(); return }
    file.present(url: url, title: title, from: presenter)
  }

  private func dismissFilePresentation(identifier: String) {
    if filePresentation?.identifier == identifier { filePresentation?.dismiss() }
  }

  private func shareFile(url: URL, title: String, sourceIdentifier: String, promise: Promise) throws {
    guard let presenter = appContext?.utilities?.currentViewController() else {
      throw NSError(
        domain: "MinesNativePresentation",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "The presenting screen is no longer open."]
      )
    }
    try presentFileShare(
      url: url,
      title: title,
      source: presentationSources.view(for: sourceIdentifier),
      presenter: presenter,
      promise: promise
    )
  }
}
