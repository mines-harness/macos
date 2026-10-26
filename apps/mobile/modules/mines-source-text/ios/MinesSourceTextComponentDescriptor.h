#pragma once

#include "MinesSourceTextShadowNode.h"

#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>

namespace facebook::react {
using MinesSourceTextComponentDescriptor =
    ConcreteComponentDescriptor<MinesSourceTextShadowNode>;

void MinesSourceTextSpec_registerComponentDescriptorsFromCodegen(
    std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
} // namespace facebook::react
