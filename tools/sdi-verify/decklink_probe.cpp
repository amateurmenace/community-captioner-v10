// decklink_probe — what actually arrives on a DeckLink SDI input.
//
//   picture   detected mode, mean luma, the 8 bars of a 75% colour-bar pattern
//             (as sent by ndi_testsrc), one still saved as BMP
//   audio     48 kHz 16-bit stereo: level per channel and tone level at 1 kHz / 440 Hz
//   captions  SMPTE 334 CDP packets (DID 0x61, SDID 0x01) decoded to CEA-608 CC1 text
//
// Usage: decklink_probe <deviceIndex|scan|list> [seconds=6] [skipIndex=-1] [stillDir=.]
//   list   print the devices and exit
//   scan   probe every device except skipIndex (inputs in use by another app just fail to open)
//
// Builds on Windows and macOS with the addon's platform.h (see CMakeLists.txt / README.md).
#define _USE_MATH_DEFINES
#ifndef _CRT_SECURE_NO_WARNINGS
#define _CRT_SECURE_NO_WARNINGS
#endif
#include "platform.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifndef STDMETHODCALLTYPE
#define STDMETHODCALLTYPE
#endif

// Keep in sync with ndi_testsrc.cpp: 75% bars, BT.709 video range (Y, Cb, Cr)
static const uint8_t BARS[8][3] = {
    {180, 128, 128}, {168,  44, 136}, {145, 147,  44}, {133,  63,  52},
    { 63, 193, 204}, { 51, 109, 212}, { 28, 212, 120}, { 16, 128, 128},
};
static const char* BAR_NAMES[8] = { "white", "yellow", "cyan", "green", "magenta", "red", "blue", "black" };

// BMDStringToStd copies; the caller releases the DeckLink string on both platforms.
static std::string TakeString(BMDString s) {
    std::string out = BMDStringToStd(s);
    BMDStringFree(s);
    return out;
}

static double ToneAmp(const int16_t* x, int n, int stride, double f) {  // Goertzel, amplitude in sample units
    double k = 2.0 * cos(2.0 * M_PI * f / 48000.0), s1 = 0, s2 = 0;
    for (int i = 0; i < n; i++) { double s0 = x[i * stride] + k * s1 - s2; s2 = s1; s1 = s0; }
    double p = s1 * s1 + s2 * s2 - k * s1 * s2;
    return 2.0 * sqrt(std::max(0.0, p)) / n;
}
static double Db(double amp) { return amp > 0 ? 20.0 * log10(amp / 32768.0) : -999.0; }

class Probe : public IDeckLinkInputCallback {
public:
    std::mutex m;
    IDeckLinkInput* input = nullptr;
    std::string stillPath;
    long frames = 0, noSignal = 0, vancFrames = 0, cdpPackets = 0, otherAnc = 0, formatChanges = 0;
    double sumY = 0; long ySamples = 0;
    int width = 0, height = 0; std::string mode = "1080p29.97 (initial)";
    int barsMatchedBest = -1; uint8_t barYUV[8][3] = {};
    bool saved = false;
    long long audioFrames = 0; double sqL = 0, sqR = 0, peakL = 0, peakR = 0;
    double a1kL = 0, a440L = 0, a1kR = 0, a440R = 0; long audioPackets = 0;
    std::string text, lastPair;
    std::atomic<ULONG> refs{1};

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, LPVOID* ppv) override { *ppv = nullptr; return E_NOINTERFACE; }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
    ULONG STDMETHODCALLTYPE Release() override { return --refs; }

    HRESULT STDMETHODCALLTYPE VideoInputFormatChanged(BMDVideoInputFormatChangedEvents, IDeckLinkDisplayMode* newMode, BMDDetectedVideoInputFormatFlags) override {
        std::lock_guard<std::mutex> l(m);
        formatChanges++;
        BMDString name = nullptr;
        if (newMode->GetName(&name) == S_OK && name) mode = TakeString(name);
        input->PauseStreams();
        input->EnableVideoInput(newMode->GetDisplayMode(), bmdFormat8BitYUV, bmdVideoInputEnableFormatDetection);
        input->FlushStreams();
        input->StartStreams();
        return S_OK;
    }

    void Decode608(uint8_t a, uint8_t b) {
        a &= 0x7F; b &= 0x7F;
        if (a == 0 && b == 0) return;
        std::string pair = { (char)a, (char)b };
        if (a >= 0x10 && a <= 0x1F) {  // control code, sent twice: act once
            if (pair == lastPair) { lastPair.clear(); return; }
            lastPair = pair;
            if ((a == 0x14 || a == 0x1C) && (b == 0x2D || b == 0x2C)) { if (!text.empty() && text.back() != '\n') text += '\n'; }  // CR / erase
            return;
        }
        lastPair.clear();
        if (a >= 0x20) text += (char)a;
        if (b >= 0x20) text += (char)b;
    }

    int dumpLeft = getenv("CC_DUMP") ? atoi(getenv("CC_DUMP")) : 0;
    std::string lastDump;
    void ParseCdp(const uint8_t* d, uint32_t n) {
        if (n < 11 || d[0] != 0x96 || d[1] != 0x69) return;
        cdpPackets++;
        if (dumpLeft > 0) {  // CC_DUMP=N: print the first N distinct packets as hex (sequence/footer ignored for the comparison)
            std::string h; char b[4];
            for (uint32_t k = 0; k < n; k++) { snprintf(b, sizeof b, "%02x", d[k]); h += b; }
            std::string key = h.size() > 22 ? h.substr(14, h.size() - 22) : h;
            if (key != lastDump) { printf("    CDP %u bytes: %s%c", n, h.c_str(), 10); lastDump = key; dumpLeft--; }
        }
        uint32_t i = 7;
        while (i + 1 < n) {
            uint8_t id = d[i];
            if (id == 0x72) {
                uint8_t cnt = d[i + 1] & 0x1F; i += 2;
                for (int k = 0; k < cnt && i + 2 < n; k++, i += 3)
                    if ((d[i] & 0x04) && (d[i] & 0x03) == 0) Decode608(d[i + 1], d[i + 2]);
            } else if (id == 0x71) { i += 5; }
            else if (id == 0x73) { uint8_t cnt = d[i + 1] & 0x0F; i += 2 + cnt * 7; }
            else break;  // 0x74 footer
        }
    }

    void SaveStill(const uint8_t* p, long rowBytes) {
        const int sw = width / 4, sh = height / 4, stride = (sw * 3 + 3) & ~3;
        std::vector<uint8_t> img((size_t)stride * sh);
        for (int y = 0; y < sh; y++) for (int x = 0; x < sw; x++) {
            const uint8_t* q = p + (size_t)(y * 4) * rowBytes + (size_t)((x * 4) & ~1) * 2;
            double Y = q[1] - 16, Cb = q[0] - 128, Cr = q[2] - 128;
            double r = 1.164 * Y + 1.793 * Cr, g = 1.164 * Y - 0.213 * Cb - 0.533 * Cr, b = 1.164 * Y + 2.112 * Cb;
            uint8_t* o = img.data() + (size_t)(sh - 1 - y) * stride + x * 3;
            o[0] = (uint8_t)std::clamp(b, 0.0, 255.0); o[1] = (uint8_t)std::clamp(g, 0.0, 255.0); o[2] = (uint8_t)std::clamp(r, 0.0, 255.0);
        }
        FILE* f = fopen(stillPath.c_str(), "wb"); if (!f) return;
        uint8_t h[54] = { 'B', 'M' };
        uint32_t fileSize = 54 + (uint32_t)img.size(), off = 54, dib = 40, isz = (uint32_t)img.size();
        int32_t w32 = sw, h32 = sh; uint16_t planes = 1, bpp = 24;
        memcpy(h + 2, &fileSize, 4); memcpy(h + 10, &off, 4); memcpy(h + 14, &dib, 4); memcpy(h + 18, &w32, 4);
        memcpy(h + 22, &h32, 4); memcpy(h + 26, &planes, 2); memcpy(h + 28, &bpp, 2); memcpy(h + 34, &isz, 4);
        fwrite(h, 1, 54, f); fwrite(img.data(), 1, img.size(), f); fclose(f);
        saved = true;
    }

    HRESULT STDMETHODCALLTYPE VideoInputFrameArrived(IDeckLinkVideoInputFrame* vf, IDeckLinkAudioInputPacket* ap) override {
        std::lock_guard<std::mutex> l(m);
        if (vf) {
            frames++;
            if (vf->GetFlags() & bmdFrameHasNoInputSource) noSignal++;
            else {
                width = (int)vf->GetWidth(); height = (int)vf->GetHeight();
                long rowBytes = vf->GetRowBytes();
                VideoFrameAccess access(vf, bmdBufferAccessRead);
                const uint8_t* p = (const uint8_t*)access.data;
                if (p && vf->GetPixelFormat() == bmdFormat8BitYUV) {
                    for (int y = 0; y < height; y += 16) for (int x = 0; x < width; x += 16) { sumY += p[(size_t)y * rowBytes + (size_t)x * 2 + 1]; ySamples++; }
                    int row = height / 3, matched = 0; uint8_t yuv[8][3];
                    for (int b = 0; b < 8; b++) {
                        int x = (((2 * b + 1) * width) / 16) & ~1;
                        const uint8_t* q = p + (size_t)row * rowBytes + (size_t)x * 2;
                        yuv[b][0] = q[1]; yuv[b][1] = q[0]; yuv[b][2] = q[2];
                        if (abs(q[1] - BARS[b][0]) <= 8 && abs(q[0] - BARS[b][1]) <= 8 && abs(q[2] - BARS[b][2]) <= 8) matched++;
                    }
                    if (matched > barsMatchedBest) { barsMatchedBest = matched; memcpy(barYUV, yuv, sizeof(yuv)); }
                    if (!saved && frames > 10 && !stillPath.empty()) SaveStill(p, rowBytes);
                }
            }
            IDeckLinkVideoFrameAncillaryPackets* anc = nullptr;
            if (vf->QueryInterface(IID_IDeckLinkVideoFrameAncillaryPackets, (void**)&anc) == S_OK && anc) {
                IDeckLinkAncillaryPacketIterator* it = nullptr; bool any = false;
                if (anc->GetPacketIterator(&it) == S_OK && it) {
                    IDeckLinkAncillaryPacket* pkt = nullptr;
                    while (it->Next(&pkt) == S_OK) {
                        any = true;
                        if (pkt->GetDID() == 0x61 && pkt->GetSDID() == 0x01) {
                            const void* data = nullptr; uint32_t size = 0;
                            if (pkt->GetBytes(bmdAncillaryPacketFormatUInt8, &data, &size) == S_OK && data) ParseCdp((const uint8_t*)data, size);
                        } else otherAnc++;
                        pkt->Release();
                    }
                    it->Release();
                }
                if (any) vancFrames++;
                anc->Release();
            }
        }
        if (ap) {
            void* bytes = nullptr; ap->GetBytes(&bytes);
            long n = ap->GetSampleFrameCount();
            const int16_t* s = (const int16_t*)bytes;
            if (s && n > 0) {
                for (long i = 0; i < n; i++) {
                    double lv = s[i * 2], rv = s[i * 2 + 1];
                    sqL += lv * lv; sqR += rv * rv; peakL = std::max(peakL, fabs(lv)); peakR = std::max(peakR, fabs(rv));
                }
                a1kL += ToneAmp(s, (int)n, 2, 1000); a440L += ToneAmp(s, (int)n, 2, 440);
                a1kR += ToneAmp(s + 1, (int)n, 2, 1000); a440R += ToneAmp(s + 1, (int)n, 2, 440);
                audioFrames += n; audioPackets++;
            }
        }
        return S_OK;
    }
};

static std::vector<std::pair<IDeckLink*, std::string>> Devices() {
    std::vector<std::pair<IDeckLink*, std::string>> out;
    IDeckLinkIterator* it = CreateDeckLinkIterator();
    if (!it) return out;
    IDeckLink* d = nullptr;
    while (it->Next(&d) == S_OK) {
        BMDString name = nullptr;
        std::string n = (d->GetDisplayName(&name) == S_OK && name) ? TakeString(name) : "?";
        out.push_back({ d, n });
    }
    it->Release();
    return out;
}

static void RunOne(int idx, IDeckLink* dev, const std::string& name, int seconds, const std::string& stillDir) {
    printf("\n[%d] %s\n", idx, name.c_str());
    Probe probe;
    if (dev->QueryInterface(IID_IDeckLinkInput, (void**)&probe.input) != S_OK || !probe.input) { printf("    no input interface\n"); return; }
    probe.stillPath = stillDir + "/probe_dev" + std::to_string(idx) + ".bmp";
    probe.input->SetCallback(&probe);
    HRESULT hr = probe.input->EnableVideoInput(bmdModeHD1080p2997, bmdFormat8BitYUV, bmdVideoInputEnableFormatDetection);
    if (hr != S_OK) {
        printf("    could not open the input (0x%08X): in use by another application, or the connector is busy as an output\n", (unsigned)hr);
        probe.input->SetCallback(nullptr); probe.input->Release(); return;
    }
    if (probe.input->EnableAudioInput(bmdAudioSampleRate48kHz, bmdAudioSampleType16bitInteger, 2) != S_OK) printf("    audio input not available\n");
    probe.input->StartStreams();
    std::this_thread::sleep_for(std::chrono::seconds(seconds));
    probe.input->StopStreams();
    probe.input->DisableAudioInput();
    probe.input->DisableVideoInput();
    probe.input->SetCallback(nullptr);
    probe.input->Release();

    std::lock_guard<std::mutex> l(probe.m);
    long withSignal = probe.frames - probe.noSignal;
    printf("    video: %ld frames (%ld with signal), mode %s, %dx%d\n", probe.frames, withSignal, probe.mode.c_str(), probe.width, probe.height);
    bool picOk = false, audioOk = false, capOk = !probe.text.empty();
    if (withSignal > 0) {
        printf("    picture: mean luma %.1f; test bars matched %d/8:", probe.ySamples ? probe.sumY / probe.ySamples : 0.0, probe.barsMatchedBest);
        for (int b = 0; b < 8; b++) printf(" %s(%d,%d,%d)", BAR_NAMES[b], probe.barYUV[b][0], probe.barYUV[b][1], probe.barYUV[b][2]);
        printf("\n    still: %s\n", probe.saved ? probe.stillPath.c_str() : "(not saved)");
        picOk = probe.barsMatchedBest == 8;
    }
    if (probe.audioFrames > 0) {
        double np = probe.audioPackets ? (double)probe.audioPackets : 1.0;
        double l1k = Db(probe.a1kL / np), l440 = Db(probe.a440L / np), r1k = Db(probe.a1kR / np), r440 = Db(probe.a440R / np);
        printf("    audio: %lld samples; L rms %.1f dBFS (peak %.1f) | R rms %.1f dBFS (peak %.1f)\n", probe.audioFrames,
               Db(sqrt(probe.sqL / probe.audioFrames) * sqrt(2.0)), Db(probe.peakL), Db(sqrt(probe.sqR / probe.audioFrames) * sqrt(2.0)), Db(probe.peakR));
        printf("    tones: L 1 kHz %.1f dBFS, 440 Hz %.1f | R 1 kHz %.1f, 440 Hz %.1f dBFS\n", l1k, l440, r1k, r440);
        // ndi_testsrc at its default level (NDI reference level) should arrive at -20 dBFS
        audioOk = fabs(l1k + 20.0) <= 1.5 && fabs(r440 + 20.0) <= 1.5 && l440 < -40.0 && r1k < -40.0;
    } else printf("    audio: none\n");
    printf("    VANC: %ld frames with ancillary data, %ld CEA-708 CDP packets, %ld other packets\n", probe.vancFrames, probe.cdpPackets, probe.otherAnc);
    if (capOk) {
        printf("    caption text (CEA-608 CC1):\n");
        std::string line;
        for (char c : probe.text) { if (c == '\n') { if (!line.empty()) printf("      | %s\n", line.c_str()); line.clear(); } else line += c; }
        if (!line.empty()) printf("      | %s\n", line.c_str());
    }
    if (withSignal > 0)
        printf("    RESULT vs ndi_testsrc: picture %s, audio %s, captions %s\n", picOk ? "PASS" : "FAIL", audioOk ? "PASS" : "FAIL", capOk ? "PASS" : "FAIL");
    fflush(stdout);
}

int main(int argc, char** argv) {
    setvbuf(stdout, nullptr, _IONBF, 0);
    if (argc < 2) { printf("usage: decklink_probe <deviceIndex|scan|list> [seconds=6] [skipIndex=-1] [stillDir=.]\n"); return 1; }
    std::string target = argv[1];
    int seconds = argc > 2 ? atoi(argv[2]) : 6;
    int skip = argc > 3 ? atoi(argv[3]) : -1;
    std::string stillDir = argc > 4 ? argv[4] : ".";
    ComInit com;
    auto devs = Devices();
    printf("%zu DeckLink devices\n", devs.size());
    for (size_t i = 0; i < devs.size(); i++) {
        if (target == "list") printf("  [%zu] %s\n", i, devs[i].second.c_str());
        else if (target == "scan") { if ((int)i != skip) RunOne((int)i, devs[i].first, devs[i].second, seconds, stillDir); }
        else if ((int)i == atoi(target.c_str())) RunOne((int)i, devs[i].first, devs[i].second, seconds, stillDir);
    }
    for (auto& d : devs) d.first->Release();
    return 0;
}
