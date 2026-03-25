#include <napi.h>
#include "device_manager.h"
#include "output_handler.h"
#include "passthrough.h"

// Global state — only one output mode active at a time
static OutputHandler* g_outputHandler = nullptr;
static PassthroughHandler* g_passthroughHandler = nullptr;

/**
 * enumerateDevices() -> [{name, index, hasInput, hasOutput, displayModes}]
 */
Napi::Value EnumerateDevices(const Napi::CallbackInfo& info) {
    return DeviceManager::EnumerateDevices(info);
}

/**
 * startOutput(deviceIndex: number, displayMode: number) -> boolean
 * Starts standalone mode (black frames + VANC captions).
 */
Napi::Value StartOutput(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (g_outputHandler || g_passthroughHandler) {
        Napi::Error::New(env, "Output already running. Stop first.").ThrowAsJavaScriptException();
        return env.Null();
    }

    uint32_t deviceIndex = info[0].As<Napi::Number>().Uint32Value();
    uint32_t displayMode = info[1].As<Napi::Number>().Uint32Value();

    g_outputHandler = new OutputHandler();
    bool ok = g_outputHandler->Start(deviceIndex, (BMDDisplayMode)displayMode);
    if (!ok) {
        delete g_outputHandler;
        g_outputHandler = nullptr;
        return Napi::Boolean::New(env, false);
    }

    return Napi::Boolean::New(env, true);
}

/**
 * startPassthrough(inputDevice: number, outputDevice: number, displayMode: number) -> boolean
 * Starts pass-through mode (SDI in -> SDI out + captions).
 */
Napi::Value StartPassthrough(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (g_outputHandler || g_passthroughHandler) {
        Napi::Error::New(env, "Output already running. Stop first.").ThrowAsJavaScriptException();
        return env.Null();
    }

    uint32_t inputDevice = info[0].As<Napi::Number>().Uint32Value();
    uint32_t outputDevice = info[1].As<Napi::Number>().Uint32Value();
    uint32_t displayMode = info[2].As<Napi::Number>().Uint32Value();

    g_passthroughHandler = new PassthroughHandler();
    bool ok = g_passthroughHandler->Start(inputDevice, outputDevice, (BMDDisplayMode)displayMode);
    if (!ok) {
        delete g_passthroughHandler;
        g_passthroughHandler = nullptr;
        return Napi::Boolean::New(env, false);
    }

    return Napi::Boolean::New(env, true);
}

/**
 * stopOutput() -> void
 */
Napi::Value StopOutput(const Napi::CallbackInfo& info) {
    if (g_outputHandler) {
        g_outputHandler->Stop();
        g_outputHandler->Release();
        g_outputHandler = nullptr;
    }
    if (g_passthroughHandler) {
        g_passthroughHandler->Stop();
        g_passthroughHandler->Release();
        g_passthroughHandler = nullptr;
    }
    return info.Env().Undefined();
}

/**
 * pushCDP(buffer: Buffer) -> void
 * Push a CEA-708 CDP packet for the next video frame.
 */
Napi::Value PushCDP(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!info[0].IsBuffer() && !info[0].IsTypedArray()) {
        Napi::TypeError::New(env, "Expected Buffer or Uint8Array").ThrowAsJavaScriptException();
        return env.Null();
    }

    const uint8_t* data;
    size_t size;

    if (info[0].IsBuffer()) {
        Napi::Buffer<uint8_t> buf = info[0].As<Napi::Buffer<uint8_t>>();
        data = buf.Data();
        size = buf.Length();
    } else {
        Napi::Uint8Array arr = info[0].As<Napi::Uint8Array>();
        data = arr.Data();
        size = arr.ByteLength();
    }

    if (g_outputHandler) {
        g_outputHandler->PushCDP(data, size);
    } else if (g_passthroughHandler) {
        g_passthroughHandler->PushCDP(data, size);
    }

    return env.Undefined();
}

/**
 * getStatus() -> {running, mode, framesOutput, droppedFrames}
 */
Napi::Value GetStatus(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object status = Napi::Object::New(env);

    if (g_outputHandler && g_outputHandler->IsRunning()) {
        status.Set("running", true);
        status.Set("mode", Napi::String::New(env, "standalone"));
        status.Set("framesOutput", Napi::Number::New(env, (double)g_outputHandler->GetFramesOutput()));
        status.Set("droppedFrames", Napi::Number::New(env, (double)g_outputHandler->GetDroppedFrames()));
    } else if (g_passthroughHandler && g_passthroughHandler->IsRunning()) {
        status.Set("running", true);
        status.Set("mode", Napi::String::New(env, "passthrough"));
        status.Set("framesOutput", Napi::Number::New(env, (double)g_passthroughHandler->GetFramesOutput()));
        status.Set("droppedFrames", Napi::Number::New(env, (double)g_passthroughHandler->GetDroppedFrames()));
    } else {
        status.Set("running", false);
        status.Set("mode", Napi::String::New(env, "stopped"));
        status.Set("framesOutput", Napi::Number::New(env, 0));
        status.Set("droppedFrames", Napi::Number::New(env, 0));
    }

    return status;
}

/**
 * Module initialization
 */
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("enumerateDevices", Napi::Function::New(env, EnumerateDevices));
    exports.Set("startOutput", Napi::Function::New(env, StartOutput));
    exports.Set("startPassthrough", Napi::Function::New(env, StartPassthrough));
    exports.Set("stopOutput", Napi::Function::New(env, StopOutput));
    exports.Set("pushCDP", Napi::Function::New(env, PushCDP));
    exports.Set("getStatus", Napi::Function::New(env, GetStatus));
    return exports;
}

NODE_API_MODULE(decklink_addon, Init)
