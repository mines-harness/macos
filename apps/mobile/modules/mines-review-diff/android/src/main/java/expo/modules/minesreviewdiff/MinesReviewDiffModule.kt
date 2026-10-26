package expo.modules.minesreviewdiff

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MinesReviewDiffModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MinesReviewDiffSurface")

    View(MinesReviewDiffView::class) {
      Prop("tokensResetKey") { view: MinesReviewDiffView, tokensResetKey: String ->
        view.setTokensResetKey(tokensResetKey)
      }
      Prop("contentResetKey") { view: MinesReviewDiffView, contentResetKey: String ->
        view.setContentResetKey(contentResetKey)
      }
      Prop("collapsedFileIdsJson") { view: MinesReviewDiffView, collapsedFileIdsJson: String ->
        view.setCollapsedFileIdsJson(collapsedFileIdsJson)
      }
      Prop("viewedFileIdsJson") { view: MinesReviewDiffView, viewedFileIdsJson: String ->
        view.setViewedFileIdsJson(viewedFileIdsJson)
      }
      Prop("selectedRowIdsJson") { view: MinesReviewDiffView, selectedRowIdsJson: String ->
        view.setSelectedRowIdsJson(selectedRowIdsJson)
      }
      Prop("collapsedCommentIdsJson") { view: MinesReviewDiffView, collapsedCommentIdsJson: String ->
        view.setCollapsedCommentIdsJson(collapsedCommentIdsJson)
      }
      Prop("appearanceScheme") { view: MinesReviewDiffView, appearanceScheme: String ->
        view.setAppearanceScheme(appearanceScheme)
      }
      Prop("themeJson") { view: MinesReviewDiffView, themeJson: String ->
        view.setThemeJson(themeJson)
      }
      Prop("styleJson") { view: MinesReviewDiffView, styleJson: String ->
        view.setStyleJson(styleJson)
      }
      Prop("rowHeight") { view: MinesReviewDiffView, rowHeight: Double ->
        view.setRowHeight(rowHeight.toFloat())
      }
      // Accept the shared prop while deriving Android's scroll range from the drawn text.
      Prop("contentWidth") { _: MinesReviewDiffView, _: Double -> }
      Prop("contentInsetBottom") { view: MinesReviewDiffView, value: Double ->
        view.setContentInsetBottom(value.toFloat())
      }
      Prop("scrollEnabled") { view: MinesReviewDiffView, enabled: Boolean ->
        view.setScrollEnabled(enabled)
      }
      Prop("initialRowIndex") { view: MinesReviewDiffView, initialRowIndex: Double ->
        view.setInitialRowIndex(initialRowIndex)
      }
      Prop("initialFileId") { view: MinesReviewDiffView, fileId: String ->
        view.setInitialFileId(fileId)
      }

      Events(
        "onDebug",
        "onVisibleFileChange",
        "onToggleFile",
        "onToggleViewedFile",
        "onPressLine",
        "onToggleComment",
      )

      AsyncFunction("scrollToFile") { view: MinesReviewDiffView, fileId: String, animated: Boolean ->
        view.scrollToFile(fileId, animated)
      }
      AsyncFunction("scrollToTop") { view: MinesReviewDiffView, animated: Boolean ->
        view.scrollToTop(animated)
      }
      AsyncFunction("setRowsJson") { view: MinesReviewDiffView, rowsJson: String ->
        view.setRowsJson(rowsJson)
      }
      AsyncFunction("setTokensJson") { view: MinesReviewDiffView, tokensJson: String ->
        view.setTokensJson(tokensJson)
      }
      AsyncFunction("setTokensPatchJson") {
          view: MinesReviewDiffView,
          tokensPatchJson: String,
          promise: Promise
        ->
        view.setTokensPatchJson(tokensPatchJson) { accepted -> promise.resolve(accepted) }
      }

      OnViewDestroys { view: MinesReviewDiffView ->
        view.cleanup()
      }
    }
  }
}
