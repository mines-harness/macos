#pragma once

#include <react/renderer/components/MinesSourceTextSpec/EventEmitters.h>
#include <react/renderer/components/MinesSourceTextSpec/Props.h>
#include <react/renderer/components/MinesSourceTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char MinesSourceTextRunComponentName[];

using MinesSourceTextRunShadowNode =
    ConcreteViewShadowNode<MinesSourceTextRunComponentName, MinesSourceTextRunProps,
                           MinesSourceTextRunEventEmitter, MinesSourceTextRunState>;
} // namespace facebook::react
