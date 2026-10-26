import ExpoModulesCore
import UIKit

enum MinesComposerClipboard {
  static let fragmentType = "app.mines.context-fragment"

  static func write(text: String, fragment: String) {
    var items: [String: Any] = ["public.utf8-plain-text": text]
    if let data = fragment.data(using: .utf8),
       var payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let records = payload["records"] as? [[String: Any]] {
      var selected = records.filter { record in
        guard let id = record["contextId"] as? String else { return false }
        return text.contains("/\(id))")
      }
      let screenshots = Set(selected.compactMap { $0["screenshotContextId"] as? String })
      selected.append(contentsOf: records.filter { screenshots.contains($0["contextId"] as? String ?? "") && !text.contains("/\($0["contextId"] as? String ?? ""))") })
      payload["records"] = selected
      if !selected.isEmpty, let encoded = try? JSONSerialization.data(withJSONObject: payload), let raw = String(data: encoded, encoding: .utf8) {
        let attribute = raw.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        let escaped = text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
        items[fragmentType] = encoded
        items["public.html"] = Data("<pre data-mines-context-fragment=\"\(attribute)\">\(escaped)</pre>".utf8)
      }
    }
    UIPasteboard.general.items = [items]
  }

  static func read() -> [String: String] {
    let board = UIPasteboard.general
    return [
      "text": board.string ?? "",
      "fragment": board.data(forPasteboardType: fragmentType).flatMap { String(data: $0, encoding: .utf8) } ?? "",
      "html": board.data(forPasteboardType: "public.html").flatMap { String(data: $0, encoding: .utf8) } ?? "",
    ]
  }
}

@ExpoModule("MinesComposerEditor")
public class MinesComposerEditorModule: Module {
  // UIPasteboard is main-thread only, so the member is main-actor isolated.
  @JS
  @MainActor
  func writeContextClipboard(text: String, fragment: String) async {
    MinesComposerClipboard.write(text: text, fragment: fragment)
  }

  public func definition() -> ModuleDefinition {
    View(MinesComposerEditorView.self) {
      Prop("controlledDocumentJson") { (view: MinesComposerEditorView, documentJson: String) in
        view.setControlledDocumentJson(documentJson)
      }
      Prop("themeJson") { (view: MinesComposerEditorView, themeJson: String) in
        view.setThemeJson(themeJson)
      }
      Prop("clipboardFragment") { (view: MinesComposerEditorView, fragment: String) in
        view.setClipboardFragment(fragment)
      }
      Prop("placeholder") { (view: MinesComposerEditorView, placeholder: String) in
        view.setPlaceholder(placeholder)
      }
      Prop("fontFamily") { (view: MinesComposerEditorView, fontFamily: String) in
        view.setFontFamily(fontFamily)
      }
      Prop("fontSize") { (view: MinesComposerEditorView, fontSize: Double) in
        view.setFontSize(CGFloat(fontSize))
      }
      Prop("lineHeight") { (view: MinesComposerEditorView, lineHeight: Double) in
        view.setLineHeight(CGFloat(lineHeight))
      }
      Prop("contentInsetVertical") { (view: MinesComposerEditorView, contentInsetVertical: Double) in
        view.setContentInsetVertical(CGFloat(contentInsetVertical))
      }
      Prop("editable") { (view: MinesComposerEditorView, editable: Bool) in
        view.setEditable(editable)
      }
      Prop("readOnly") { (view: MinesComposerEditorView, readOnly: Bool) in
        view.setReadOnly(readOnly)
      }
      Prop("scrollEnabled") { (view: MinesComposerEditorView, scrollEnabled: Bool) in
        view.setScrollEnabled(scrollEnabled)
      }
      Prop("autoFocus") { (view: MinesComposerEditorView, autoFocus: Bool) in
        view.setAutoFocus(autoFocus)
      }
      Prop("autoCorrect") { (view: MinesComposerEditorView, autoCorrect: Bool) in
        view.setAutoCorrect(autoCorrect)
      }
      Prop("spellCheck") { (view: MinesComposerEditorView, spellCheck: Bool) in
        view.setSpellCheck(spellCheck)
      }
      Prop("submitTitle") { (view: MinesComposerEditorView, title: String) in
        view.setSubmitTitle(title)
      }
      Prop("alternateSubmitTitle") { (view: MinesComposerEditorView, title: String) in
        view.setAlternateSubmitTitle(title)
      }
      Prop("enterBehavior") { (view: MinesComposerEditorView, behavior: String) in
        view.setEnterBehavior(behavior)
      }
      Prop("textPasteThresholdBytes") { (view: MinesComposerEditorView, threshold: Int) in
        view.setTextPasteThresholdBytes(threshold)
      }
      Prop("maxInputChars") { (view: MinesComposerEditorView, maxInputChars: Int) in
        view.setMaxInputChars(maxInputChars)
      }

      Events(
        "onComposerChange",
        "onComposerSelectionChange",
        "onComposerFocus",
        "onComposerBlur",
        "onComposerSubmit",
        "onComposerPasteImages",
        "onComposerContextPress",
        "onComposerPasteContext",
        "onComposerPasteText",
        "onComposerContentSizeChange"
      )

      AsyncFunction("focus") { (view: MinesComposerEditorView) in
        view.focusEditor()
      }
      AsyncFunction("blur") { (view: MinesComposerEditorView) in
        view.blurEditor()
      }
      AsyncFunction("setSelection") { (view: MinesComposerEditorView, start: Int, end: Int) in
        view.setSelection(start: start, end: end)
      }
    }
  }
}
