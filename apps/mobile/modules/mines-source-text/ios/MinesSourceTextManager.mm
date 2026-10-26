#import <React/RCTUIManager.h>
#import <React/RCTViewManager.h>

@interface MinesSourceTextManager : RCTViewManager
@end

@implementation MinesSourceTextManager

RCT_EXPORT_MODULE(MinesSourceText)

- (UIView *)view {
  return [[UIView alloc] init];
}

@end

@interface MinesSourceTextRunManager : RCTViewManager
@end

@implementation MinesSourceTextRunManager

RCT_EXPORT_MODULE(MinesSourceTextRun)

- (UIView *)view {
  return nil;
}

@end
