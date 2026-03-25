#include "device_manager.h"
#include <CoreFoundation/CoreFoundation.h>

// Helper to convert CFString to std::string
static std::string CFStringToStdString(CFStringRef cfStr) {
    if (!cfStr) return "";
    CFIndex len = CFStringGetLength(cfStr);
    CFIndex maxSize = CFStringGetMaximumSizeForEncoding(len, kCFStringEncodingUTF8) + 1;
    std::string result(maxSize, '\0');
    if (CFStringGetCString(cfStr, &result[0], maxSize, kCFStringEncodingUTF8)) {
        result.resize(strlen(result.c_str()));
        return result;
    }
    return "";
}

Napi::Value DeviceManager::EnumerateDevices(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array devices = Napi::Array::New(env);

    IDeckLinkIterator* iterator = CreateDeckLinkIteratorInstance();
    if (!iterator) {
        // No DeckLink driver installed
        return devices;
    }

    IDeckLink* deckLink = nullptr;
    uint32_t index = 0;

    while (iterator->Next(&deckLink) == S_OK) {
        Napi::Object device = Napi::Object::New(env);

        // Get device name
        CFStringRef name = nullptr;
        if (deckLink->GetDisplayName(&name) == S_OK && name) {
            device.Set("name", Napi::String::New(env, CFStringToStdString(name)));
            CFRelease(name);
        } else {
            device.Set("name", Napi::String::New(env, "Unknown Device"));
        }

        device.Set("index", Napi::Number::New(env, index));

        // Check for input capability
        IDeckLinkInput* input = nullptr;
        bool hasInput = (deckLink->QueryInterface(IID_IDeckLinkInput, (void**)&input) == S_OK);
        if (input) input->Release();
        device.Set("hasInput", Napi::Boolean::New(env, hasInput));

        // Check for output capability
        IDeckLinkOutput* output = nullptr;
        bool hasOutput = (deckLink->QueryInterface(IID_IDeckLinkOutput, (void**)&output) == S_OK);
        device.Set("hasOutput", Napi::Boolean::New(env, hasOutput));

        // Get supported display modes for output
        if (output) {
            Napi::Array modes = Napi::Array::New(env);
            IDeckLinkDisplayModeIterator* modeIter = nullptr;
            if (output->GetDisplayModeIterator(&modeIter) == S_OK) {
                IDeckLinkDisplayMode* mode = nullptr;
                uint32_t modeIdx = 0;
                while (modeIter->Next(&mode) == S_OK) {
                    Napi::Object modeObj = Napi::Object::New(env);

                    CFStringRef modeName = nullptr;
                    if (mode->GetName(&modeName) == S_OK && modeName) {
                        modeObj.Set("name", Napi::String::New(env, CFStringToStdString(modeName)));
                        CFRelease(modeName);
                    }

                    modeObj.Set("mode", Napi::Number::New(env, (double)mode->GetDisplayMode()));
                    modeObj.Set("width", Napi::Number::New(env, mode->GetWidth()));
                    modeObj.Set("height", Napi::Number::New(env, mode->GetHeight()));

                    BMDTimeValue duration, timeScale;
                    mode->GetFrameRate(&duration, &timeScale);
                    double fps = (double)timeScale / (double)duration;
                    modeObj.Set("fps", Napi::Number::New(env, fps));

                    modes.Set(modeIdx++, modeObj);
                    mode->Release();
                }
                modeIter->Release();
            }
            device.Set("displayModes", modes);
            output->Release();
        }

        devices.Set(index, device);
        deckLink->Release();
        index++;
    }

    iterator->Release();
    return devices;
}
