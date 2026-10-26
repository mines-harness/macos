import ExpoModulesCore

public class MinesReviewDiffModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MinesReviewDiffSurface")

    View(MinesReviewDiffView.self) {
      Prop("contentInsetTop") { (view: MinesReviewDiffView, value: Double) in
        view.setContentInsetTop(CGFloat(value))
      }

      Prop("contentInsetBottom") { (view: MinesReviewDiffView, value: Double) in
        view.setContentInsetBottom(CGFloat(value))
      }

      Prop("tokensResetKey") { (view: MinesReviewDiffView, tokensResetKey: String) in
        view.setTokensResetKey(tokensResetKey)
      }

      Prop("contentResetKey") { (view: MinesReviewDiffView, contentResetKey: String) in
        view.setContentResetKey(contentResetKey)
      }

      Prop("collapsedFileIdsJson") { (view: MinesReviewDiffView, collapsedFileIdsJson: String) in
        view.setCollapsedFileIdsJson(collapsedFileIdsJson)
      }

      Prop("viewedFileIdsJson") { (view: MinesReviewDiffView, viewedFileIdsJson: String) in
        view.setViewedFileIdsJson(viewedFileIdsJson)
      }

      Prop("selectedRowIdsJson") { (view: MinesReviewDiffView, selectedRowIdsJson: String) in
        view.setSelectedRowIdsJson(selectedRowIdsJson)
      }

      Prop("collapsedCommentIdsJson") { (view: MinesReviewDiffView, collapsedCommentIdsJson: String) in
        view.setCollapsedCommentIdsJson(collapsedCommentIdsJson)
      }

      Prop("appearanceScheme") { (view: MinesReviewDiffView, appearanceScheme: String) in
        view.setAppearanceScheme(appearanceScheme)
      }

      Prop("themeJson") { (view: MinesReviewDiffView, themeJson: String) in
        view.setThemeJson(themeJson)
      }

      Prop("styleJson") { (view: MinesReviewDiffView, styleJson: String) in
        view.setStyleJson(styleJson)
      }

      Prop("rowHeight") { (view: MinesReviewDiffView, rowHeight: Double) in
        view.setRowHeight(CGFloat(rowHeight))
      }

      Prop("contentWidth") { (view: MinesReviewDiffView, contentWidth: Double) in
        view.setContentWidth(CGFloat(contentWidth))
      }

      Prop("initialRowIndex") { (view: MinesReviewDiffView, initialRowIndex: Double) in
        view.setInitialRowIndex(initialRowIndex)
      }

      Prop("initialFileId") { (view: MinesReviewDiffView, fileId: String) in
        view.setInitialFileId(fileId)
      }

      Prop("scrollEnabled") { (view: MinesReviewDiffView, enabled: Bool) in
        view.setScrollEnabled(enabled)
      }

      Prop("bounces") { (view: MinesReviewDiffView, bounces: Bool) in
        view.setBounces(bounces)
      }

      Prop("refreshEnabled") { (view: MinesReviewDiffView, enabled: Bool) in
        view.setRefreshEnabled(enabled)
      }

      Prop("refreshing") { (view: MinesReviewDiffView, refreshing: Bool) in
        view.setRefreshing(refreshing)
      }

      Events(
        "onDebug",
        "onVisibleFileChange",
        "onToggleFile",
        "onToggleViewedFile",
        "onPressLine",
        "onToggleComment",
        "onPullToRefresh"
      )

      AsyncFunction("scrollToFile") { (view: MinesReviewDiffView, fileId: String, animated: Bool) in
        view.scrollToFile(fileId, animated: animated)
      }

      AsyncFunction("scrollToTop") { (view: MinesReviewDiffView, animated: Bool) in
        view.scrollToTop(animated: animated)
      }

      // Large, frequently changing JSON values cannot be regular Fabric props. Expo's
      // prop adapter compares strings on the main thread before invoking a setter, which
      // makes a syntax-token patch capable of blocking a frame by itself.
      AsyncFunction("setRowsJson") { (view: MinesReviewDiffView, rowsJson: String) in
        view.setRowsJson(rowsJson)
      }

      AsyncFunction("setTokensJson") { (view: MinesReviewDiffView, tokensJson: String) in
        view.setTokensJson(tokensJson)
      }

      AsyncFunction("setTokensPatchJson") { (view: MinesReviewDiffView, tokensPatchJson: String, promise: Promise) in
        view.setTokensPatchJson(tokensPatchJson) { accepted in
          promise.resolve(accepted)
        }
      }
    }
  }
}
