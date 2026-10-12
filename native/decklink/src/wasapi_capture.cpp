#ifdef _WIN32
#include "wasapi_capture.h"

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <condition_variable>
#include <cmath>
#include <cstdio>

namespace {

std::string WideToUtf8(const wchar_t* w) {
    if (!w) return "";
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    std::string s(n > 0 ? n - 1 : 0, '\0');
    if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
    return s;
}

std::wstring Utf8ToWide(const std::string& s) {
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
    std::wstring w(n > 0 ? n - 1 : 0, L'\0');
    if (n > 1) MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, &w[0], n);
    return w;
}

std::string DeviceFriendlyName(IMMDevice* dev) {
    IPropertyStore* props = nullptr;
    std::string name;
    if (dev && SUCCEEDED(dev->OpenPropertyStore(STGM_READ, &props)) && props) {
        PROPVARIANT v; PropVariantInit(&v);
        if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR) name = WideToUtf8(v.pwszVal);
        PropVariantClear(&v);
        props->Release();
    }
    return name;
}

struct ComScope {
    HRESULT hr;
    ComScope() : hr(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {}
    ~ComScope() { if (SUCCEEDED(hr)) CoUninitialize(); }
};

// Convert one WASAPI packet in the endpoint's mix format to interleaved stereo int16
// at the mix rate (rate conversion happens in the caller when needed).
void ToStereo16(const BYTE* src, uint32_t frames, const WAVEFORMATEX* fmt, bool isFloat, std::vector<int16_t>& out) {
    const uint32_t ch = fmt->nChannels;
    const uint32_t bytesPer = fmt->wBitsPerSample / 8;
    out.resize((size_t)frames * 2);
    for (uint32_t f = 0; f < frames; f++) {
        for (uint32_t o = 0; o < 2; o++) {
            uint32_t c = ch >= 2 ? o : 0;
            const BYTE* p = src + ((size_t)f * ch + c) * bytesPer;
            float v = 0.f;
            if (isFloat) {
                if (bytesPer == 4) v = *(const float*)p;
                else if (bytesPer == 8) v = (float)*(const double*)p;
            } else if (bytesPer == 2) {
                v = *(const int16_t*)p / 32768.f;
            } else if (bytesPer == 4) {
                v = *(const int32_t*)p / 2147483648.f;
            } else if (bytesPer == 3) {
                int32_t s = (int32_t)((p[0] << 8) | (p[1] << 16) | (p[2] << 24)) >> 8;
                v = s / 8388608.f;
            } else if (bytesPer == 1) {
                v = (p[0] - 128) / 128.f;
            }
            if (v > 1.f) v = 1.f; else if (v < -1.f) v = -1.f;
            out[(size_t)f * 2 + o] = (int16_t)lrintf(v * 32767.f);
        }
    }
}

}  // namespace

std::vector<AudioCaptureDevice> ListAudioCaptureDevices() {
    std::vector<AudioCaptureDevice> list;
    ComScope com;
    IMMDeviceEnumerator* en = nullptr;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&en)) || !en)
        return list;
    std::string defaultId;
    IMMDevice* def = nullptr;
    if (SUCCEEDED(en->GetDefaultAudioEndpoint(eCapture, eConsole, &def)) && def) {
        LPWSTR id = nullptr;
        if (SUCCEEDED(def->GetId(&id)) && id) { defaultId = WideToUtf8(id); CoTaskMemFree(id); }
        def->Release();
    }
    for (int pass = 0; pass < 2; pass++) {
        const bool loopback = pass == 1;
        IMMDeviceCollection* coll = nullptr;
        if (FAILED(en->EnumAudioEndpoints(loopback ? eRender : eCapture, DEVICE_STATE_ACTIVE, &coll)) || !coll) continue;
        UINT n = 0; coll->GetCount(&n);
        for (UINT i = 0; i < n; i++) {
            IMMDevice* dev = nullptr;
            if (FAILED(coll->Item(i, &dev)) || !dev) continue;
            LPWSTR id = nullptr;
            if (SUCCEEDED(dev->GetId(&id)) && id) {
                AudioCaptureDevice d;
                d.id = (loopback ? "loopback:" : "") + WideToUtf8(id);
                d.name = (loopback ? "What this PC plays on: " : "") + DeviceFriendlyName(dev);
                d.isDefault = !loopback && (d.id == defaultId);
                d.isLoopback = loopback;
                if (d.isDefault) list.insert(list.begin(), d); else list.push_back(d);
                CoTaskMemFree(id);
            }
            dev->Release();
        }
        coll->Release();
    }
    en->Release();
    return list;
}

WasapiCapture::WasapiCapture() : m_running(false), m_framesCaptured(0) {}
WasapiCapture::~WasapiCapture() { Stop(); }

bool WasapiCapture::Start(const std::string& deviceId, Callback cb, std::string* error) {
    if (m_running) { if (error) *error = "already running"; return false; }
    m_cb = std::move(cb);
    m_initDone = false; m_initOk = false; m_initError.clear();
    m_framesCaptured = 0;
    m_stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    m_running = true;
    m_thread = std::thread(&WasapiCapture::Loop, this, deviceId);
    // Wait for the device to open (or fail) so the caller gets a real answer.
    for (int i = 0; i < 500; i++) {
        { std::lock_guard<std::mutex> lk(m_initMutex); if (m_initDone) break; }
        Sleep(10);
    }
    std::lock_guard<std::mutex> lk(m_initMutex);
    if (!m_initOk) {
        if (error) *error = m_initDone ? m_initError : "timed out opening the audio device";
        m_running = false;
        SetEvent((HANDLE)m_stopEvent);
        if (m_thread.joinable()) m_thread.join();
        CloseHandle((HANDLE)m_stopEvent); m_stopEvent = nullptr;
        return false;
    }
    return true;
}

void WasapiCapture::Stop() {
    if (!m_running && !m_thread.joinable()) return;
    m_running = false;
    if (m_stopEvent) SetEvent((HANDLE)m_stopEvent);
    if (m_thread.joinable()) m_thread.join();
    if (m_stopEvent) { CloseHandle((HANDLE)m_stopEvent); m_stopEvent = nullptr; }
}

void WasapiCapture::Loop(std::string deviceId) {
    ComScope com;
    auto fail = [&](const std::string& why) {
        std::lock_guard<std::mutex> lk(m_initMutex);
        m_initDone = true; m_initOk = false; m_initError = why;
    };

    IMMDeviceEnumerator* en = nullptr;
    IMMDevice* dev = nullptr;
    IAudioClient* client = nullptr;
    IAudioCaptureClient* capture = nullptr;
    WAVEFORMATEX* mix = nullptr;
    HANDLE dataEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);

    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&en);
    if (FAILED(hr) || !en) { fail("MMDeviceEnumerator unavailable"); CloseHandle(dataEvent); return; }
    const bool loopback = deviceId.rfind("loopback:", 0) == 0;
    if (loopback) deviceId = deviceId.substr(9);
    if (deviceId.empty()) hr = en->GetDefaultAudioEndpoint(loopback ? eRender : eCapture, eConsole, &dev);
    else hr = en->GetDevice(Utf8ToWide(deviceId).c_str(), &dev);
    if (FAILED(hr) || !dev) { fail("audio input device not found: " + deviceId); en->Release(); CloseHandle(dataEvent); return; }
    m_deviceName = (loopback ? "What this PC plays on: " : "") + DeviceFriendlyName(dev);

    hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&client);
    if (FAILED(hr) || !client) { fail("cannot activate the audio device"); dev->Release(); en->Release(); CloseHandle(dataEvent); return; }
    hr = client->GetMixFormat(&mix);
    if (FAILED(hr) || !mix) { fail("cannot read the device's mix format"); client->Release(); dev->Release(); en->Release(); CloseHandle(dataEvent); return; }

    bool isFloat = mix->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
    if (mix->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
        auto* ext = (WAVEFORMATEXTENSIBLE*)mix;
        isFloat = IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
    }
    const uint32_t srcRate = mix->nSamplesPerSec;

    // 40 ms buffer, event driven, shared mode in the engine's own format.
    // Loopback capture of a playback device gets no event callbacks unless something
    // renders on it, so that case is polled (the wait below times out every 20 ms).
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                            loopback ? AUDCLNT_STREAMFLAGS_LOOPBACK : AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                            400000, 0, mix, nullptr);
    if (FAILED(hr)) { fail("cannot open the audio device for capture (hr 0x" + std::to_string((unsigned)hr) + ")"); CoTaskMemFree(mix); client->Release(); dev->Release(); en->Release(); CloseHandle(dataEvent); return; }
    if (!loopback) client->SetEventHandle(dataEvent);
    hr = client->GetService(__uuidof(IAudioCaptureClient), (void**)&capture);
    if (FAILED(hr) || !capture) { fail("no capture client"); CoTaskMemFree(mix); client->Release(); dev->Release(); en->Release(); CloseHandle(dataEvent); return; }
    hr = client->Start();
    if (FAILED(hr)) { fail("cannot start capture"); capture->Release(); CoTaskMemFree(mix); client->Release(); dev->Release(); en->Release(); CloseHandle(dataEvent); return; }

    fprintf(stderr, "[Audio in] '%s': %u Hz, %u ch, %u-bit %s → 48 kHz stereo on SDI\n",
            m_deviceName.c_str(), srcRate, mix->nChannels, mix->wBitsPerSample, isFloat ? "float" : "pcm");
    { std::lock_guard<std::mutex> lk(m_initMutex); m_initDone = true; m_initOk = true; }

    std::vector<int16_t> stereo, out;
    double frac = 0.0;          // linear resampler position for srcRate != 48000
    int16_t prevL = 0, prevR = 0;
    HANDLE waits[2] = { dataEvent, (HANDLE)m_stopEvent };
    while (m_running) {
        DWORD w = WaitForMultipleObjects(2, waits, FALSE, loopback ? 20 : 200);
        if (w == WAIT_OBJECT_0 + 1) break;
        UINT32 packet = 0;
        while (m_running && SUCCEEDED(capture->GetNextPacketSize(&packet)) && packet > 0) {
            BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0;
            if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
            if (frames) {
                if (flags & AUDCLNT_BUFFERFLAGS_SILENT) stereo.assign((size_t)frames * 2, 0);
                else ToStereo16(data, frames, mix, isFloat, stereo);
                if (srcRate == 48000) {
                    m_cb(stereo.data(), frames);
                } else {
                    // Linear interpolation srcRate → 48 kHz (keeps the previous packet's last sample).
                    const double step = (double)srcRate / 48000.0;
                    out.clear();
                    while (frac < frames) {
                        int i = (int)frac; double t = frac - i;
                        int16_t l0 = i == 0 ? prevL : stereo[(size_t)(i - 1) * 2], r0 = i == 0 ? prevR : stereo[(size_t)(i - 1) * 2 + 1];
                        if (i == 0 && t < 1e-9) { l0 = stereo[0]; r0 = stereo[1]; }
                        int16_t l1 = stereo[(size_t)i * 2], r1 = stereo[(size_t)i * 2 + 1];
                        out.push_back((int16_t)(l0 + (l1 - l0) * t));
                        out.push_back((int16_t)(r0 + (r1 - r0) * t));
                        frac += step;
                    }
                    frac -= frames;
                    prevL = stereo[(size_t)(frames - 1) * 2]; prevR = stereo[(size_t)(frames - 1) * 2 + 1];
                    if (!out.empty()) m_cb(out.data(), (uint32_t)(out.size() / 2));
                }
                m_framesCaptured += frames;
            }
            capture->ReleaseBuffer(frames);
        }
    }

    client->Stop();
    capture->Release();
    CoTaskMemFree(mix);
    client->Release();
    dev->Release();
    en->Release();
    CloseHandle(dataEvent);
    fprintf(stderr, "[Audio in] '%s' stopped after %llu frames\n", m_deviceName.c_str(), (unsigned long long)m_framesCaptured.load());
}
#endif
