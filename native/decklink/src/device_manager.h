#pragma once

#include <napi.h>
#include "platform.h"

namespace DeviceManager {
    // Returns array of {name, index, hasInput, hasOutput, displayModes}
    Napi::Value EnumerateDevices(const Napi::CallbackInfo& info);
}
