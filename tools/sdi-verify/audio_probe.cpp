// audio_probe (Windows): lists the audio capture endpoints and reads ~1.5 s from each,
// reporting the peak level, so you can tell which input actually carries programme audio
// before picking it in Caption Injection → "Audio on the SDI output".
// Build (VS Native Tools prompt, from the repo root):
//   cl /nologo /EHsc /std:c++17 /DUNICODE /D_WIN32 tools\sdi-verify\audio_probe.cpp native\decklink\src\wasapi_capture.cpp /Fe:audio_probe.exe ole32.lib
#include "../../native/decklink/src/wasapi_capture.h"
#include <windows.h>
#include <cmath>
#include <cstdio>
#include <atomic>

int main(int argc, char** argv) {
    int ms = argc > 1 ? atoi(argv[1]) : 1500;
    auto devices = ListAudioCaptureDevices();
    printf("%zu capture endpoints (listening %d ms each)\n", devices.size(), ms);
    for (const auto& d : devices) {
        std::atomic<int> peak{0};
        std::atomic<uint64_t> frames{0};
        WasapiCapture cap;
        std::string err;
        bool ok = cap.Start(d.id, [&](const int16_t* s, uint32_t n) {
            int p = peak.load();
            for (uint32_t i = 0; i < n * 2; i++) { int v = s[i] < 0 ? -s[i] : s[i]; if (v > p) p = v; }
            peak.store(p);
            frames += n;
        }, &err);
        if (!ok) { printf("  %-55s  FAILED: %s\n", d.name.c_str(), err.c_str()); continue; }
        Sleep(ms);
        cap.Stop();
        double db = peak > 0 ? 20.0 * log10(peak / 32767.0) : -999.0;
        printf("  %-55s  %s peak %6.1f dBFS  (%llu frames)%s\n", d.name.c_str(), d.isDefault ? "[default]" : "         ",
               db, (unsigned long long)frames.load(), db > -60 ? "  <-- has signal" : "");
    }
    return 0;
}
