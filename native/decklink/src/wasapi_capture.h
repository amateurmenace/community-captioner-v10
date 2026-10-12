#pragma once
// Windows audio capture (WASAPI, shared mode) for embedding a PC audio input on the
// SDI output — e.g. an NDI camera without audio plus a line/Dante/DeckLink input.
// Delivers 48 kHz 16-bit interleaved stereo, which is what the DeckLink output takes.
#ifdef _WIN32
#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

struct AudioCaptureDevice {
    std::string id;      // MMDevice endpoint id (pass back to WasapiCapture::Start); "loopback:<id>" for a playback device
    std::string name;    // friendly name, e.g. "Line In (Blackmagic DeckLink 8K Pro (2) Audio)"
    bool isDefault;
    bool isLoopback;     // what this PC plays on that output device (WASAPI loopback)
};

// Active capture endpoints (default first), then playback endpoints as loopback sources.
std::vector<AudioCaptureDevice> ListAudioCaptureDevices();

class WasapiCapture {
public:
    // Called from the capture thread with interleaved stereo int16 at 48 kHz.
    using Callback = std::function<void(const int16_t* samples, uint32_t frames)>;

    WasapiCapture();
    ~WasapiCapture();

    // deviceId: endpoint id from ListAudioCaptureDevices(), or "" for the default
    // capture device. Returns false with `error` set if the device can't be opened.
    bool Start(const std::string& deviceId, Callback cb, std::string* error = nullptr);
    void Stop();
    bool IsRunning() const { return m_running; }
    std::string DeviceName() const { return m_deviceName; }
    uint64_t FramesCaptured() const { return m_framesCaptured; }

private:
    void Loop(std::string deviceId);

    Callback m_cb;
    std::thread m_thread;
    std::atomic<bool> m_running;
    std::atomic<uint64_t> m_framesCaptured;
    std::string m_deviceName;
    // Start() waits for the thread to open the device so it can report failure.
    std::mutex m_initMutex;
    bool m_initDone = false;
    bool m_initOk = false;
    std::string m_initError;
    void* m_stopEvent = nullptr;  // HANDLE
};
#endif
