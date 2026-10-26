#pragma once

#include "MinesSourceTextRunShadowNode.h"

#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>

namespace facebook::react {
using MinesSourceTextRunComponentDescriptor =
    ConcreteComponentDescriptor<MinesSourceTextRunShadowNode>;

void MinesSourceTextRunSpec_registerComponentDescriptorsFromCodegen(
    std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
} // namespace facebook::react
