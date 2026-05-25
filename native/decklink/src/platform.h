// Cross-platform helpers for the DeckLink C++ addon.
// macOS uses CFString and a C function `CreateDeckLinkIteratorInstance()`.
// Windows uses COM with BSTR strings and `CoCreateInstance(CLSID_CDeckLinkIterator, ...)`.

#pragma once

#include <string>

#ifdef _WIN32
    #ifndef NOMINMAX
    #define NOMINMAX
    #endif
    #include <windows.h>
    #include <comdef.h>
    #include <comutil.h>
    // Generated from DeckLinkAPI.idl by MIDL (shipped with the SDK)
    #include "DeckLinkAPI_h.h"

    using BMDString = BSTR;

    inline std::string BMDStringToStd(BMDString s) {
        if (!s) return "";
        _bstr_t b(s, false);
        std::string out((const char*)b);
        return out;
    }
    inline void BMDStringFree(BMDString s) { if (s) SysFreeString(s); }

    inline IDeckLinkIterator* CreateDeckLinkIterator() {
        IDeckLinkIterator* it = nullptr;
        HRESULT hr = CoCreateInstance(CLSID_CDeckLinkIterator, nullptr, CLSCTX_ALL, IID_IDeckLinkIterator, (void**)&it);
        return SUCCEEDED(hr) ? it : nullptr;
    }

    // On Windows the pixel-buffer accessor is on IDeckLinkVideoBuffer, obtained
    // via QueryInterface from any frame. On macOS it's directly on the frame.
    inline HRESULT GetFrameBytes(IDeckLinkVideoFrame* frame, void** buffer) {
        if (!frame || !buffer) return E_INVALIDARG;
        IDeckLinkVideoBuffer* buf = nullptr;
        HRESULT hr = frame->QueryInterface(IID_IDeckLinkVideoBuffer, (void**)&buf);
        if (FAILED(hr) || !buf) return hr;
        hr = buf->GetBytes(buffer);
        buf->Release();
        return hr;
    }

    // RAII for COM init on the current thread
    struct ComInit {
        bool ok;
        ComInit() { ok = SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED)); }
        ~ComInit() { if (ok) CoUninitialize(); }
    };
#else
    #include <CoreFoundation/CoreFoundation.h>
    #include "DeckLinkAPI.h"

    using BMDString = CFStringRef;

    inline std::string BMDStringToStd(BMDString s) {
        if (!s) return "";
        CFIndex len = CFStringGetLength(s);
        CFIndex maxSize = CFStringGetMaximumSizeForEncoding(len, kCFStringEncodingUTF8) + 1;
        std::string out(maxSize, '\0');
        if (CFStringGetCString(s, &out[0], maxSize, kCFStringEncodingUTF8)) {
            out.resize(strlen(out.c_str()));
            return out;
        }
        return "";
    }
    inline void BMDStringFree(BMDString s) { if (s) CFRelease(s); }

    inline IDeckLinkIterator* CreateDeckLinkIterator() {
        return CreateDeckLinkIteratorInstance();
    }

    inline HRESULT GetFrameBytes(IDeckLinkVideoFrame* frame, void** buffer) {
        if (!frame || !buffer) return E_INVALIDARG;
        return frame->GetBytes(buffer);
    }

    // No-op COM init on macOS
    struct ComInit { bool ok = true; ComInit() {} ~ComInit() {} };
#endif
