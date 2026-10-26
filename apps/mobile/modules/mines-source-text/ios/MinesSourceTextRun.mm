#import "MinesSourceTextRun.h"
#import <React/RCTFabricComponentsPlugins.h>
#import "MinesSourceTextRunComponentDescriptor.h"
#import <react/renderer/components/MinesSourceTextSpec/Props.h>
#import <react/renderer/components/MinesSourceTextSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

@interface MinesSourceTextRun () <RCTMinesSourceTextRunViewProtocol>

@end

@implementation MinesSourceTextRun {
  NSString *_text;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider {
  return concreteComponentDescriptorProvider<
      MinesSourceTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps =
        std::make_shared<const MinesSourceTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props
           oldProps:(Props::Shared const &)oldProps {
  const auto &oldViewProps =
      *std::static_pointer_cast<MinesSourceTextRunProps const>(_props);
  const auto &newViewProps =
      *std::static_pointer_cast<MinesSourceTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> MinesSourceTextRunCls(void) {
  return MinesSourceTextRun.class;
}

@end
