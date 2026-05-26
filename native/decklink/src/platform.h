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
        // Ensure COM is initialized on the calling thread. CoInitializeEx is
        // reference-counted per thread; calling it from multiple code paths is
        // safe. We intentionally don't pair this with CoUninitialize — the JS
        // thread keeps COM live for the lifetime of the addon. Without this,
        // call sites other than EnumerateDevices (which uses ComInit) hit
        // CO_E_NOTINITIALIZED and CoCreateInstance returns null, surfacing
        // as a bogus "No driver installed" / "device in use" error.
        CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        IDeckLinkIterator* it = nullptr;
        HRESULT hr = CoCreateInstance(CLSID_CDeckLinkIterator, nullptr, CLSCTX_ALL, IID_IDeckLinkIterator, (void**)&it);
        return SUCCEEDED(hr) ? it : nullptr;
    }

    // RAII helper for the pixel buffer of a DeckLink frame. On Windows the
    // SDK requires the IDeckLinkVideoBuffer interface to be kept alive AND
    // StartAccess()/EndAccess() to bracket every read/write — without this
    // GetBytes() returns a pointer to invalid memory and downstream encoders
    // see zeroed UYVY (renders as a solid green frame).
    struct VideoFrameAccess {
        IDeckLinkVideoBuffer* m_buf;
        BMDBufferAccessFlags  m_flags;
        void*                 data;

        VideoFrameAccess(IDeckLinkVideoFrame* frame, BMDBufferAccessFlags flags)
            : m_buf(nullptr), m_flags(flags), data(nullptr) {
            if (!frame) return;
            if (FAILED(frame->QueryInterface(IID_IDeckLinkVideoBuffer, (void**)&m_buf)) || !m_buf) return;
            if (FAILED(m_buf->StartAccess(flags))) { m_buf->Release(); m_buf = nullptr; return; }
            if (FAILED(m_buf->GetBytes(&data))) {
                data = nullptr;
                m_buf->EndAccess(flags);
                m_buf->Release();
                m_buf = nullptr;
            }
        }
        ~VideoFrameAccess() {
            if (m_buf) { m_buf->EndAccess(m_flags); m_buf->Release(); }
        }
        VideoFrameAccess(const VideoFrameAccess&) = delete;
        VideoFrameAccess& operator=(const VideoFrameAccess&) = delete;
    };

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

    // BMDBufferAccessFlags isn't exposed on the macOS framework header — declare
    // a stand-in so the cross-platform call sites compile without #ifdefs. It's
    // unused on Mac because IDeckLinkVideoFrame::GetBytes works without locking.
    using BMDBufferAccessFlags = int;
    static const BMDBufferAccessFlags bmdBufferAccessRead  = 1;
    static const BMDBufferAccessFlags bmdBufferAccessWrite = 2;

    struct VideoFrameAccess {
        void* data;
        VideoFrameAccess(IDeckLinkVideoFrame* frame, BMDBufferAccessFlags /*flags*/)
            : data(nullptr) {
            if (frame) frame->GetBytes(&data);
        }
        ~VideoFrameAccess() {}
        VideoFrameAccess(const VideoFrameAccess&) = delete;
        VideoFrameAccess& operator=(const VideoFrameAccess&) = delete;
    };

    // No-op COM init on macOS
    struct ComInit { bool ok = true; ComInit() {} ~ComInit() {} };
#endif
