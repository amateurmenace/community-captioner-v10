#include "ndi_passthrough.h"
#include "vanc_packet.h"
#include <cstring>
#include <cstdio>
#include <cmath>
#include <algorithm>

static const int DECKLINK_AUDIO_RATE = 48000;

// ─────────────────────────────────────────────────────
// NDI runtime (Windows: delay-loaded DLL)
// ─────────────────────────────────────────────────────
#ifdef _WIN32
static std::string DirOfThisModule() {
    HMODULE self = nullptr;
    if (!GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                            reinterpret_cast<LPCSTR>(&DirOfThisModule), &self)) return "";
    char path[MAX_PATH * 2];
    DWORD n = GetModuleFileNameA(self, path, (DWORD)sizeof(path));
    if (n == 0 || n >= sizeof(path)) return "";
    std::string p(path, n);
    size_t slash = p.find_last_of("\\/");
    return slash == std::string::npos ? "" : p.substr(0, slash);
}

static std::string EnvVar(const char* name) {
    char buf[1024];
    DWORD n = GetEnvironmentVariableA(name, buf, (DWORD)sizeof(buf));
    return (n > 0 && n < sizeof(buf)) ? std::string(buf, n) : std::string();
}
#endif

bool NdiPassthroughHandler::RuntimeAvailable(std::string* where) {
#ifdef _WIN32
    // The import is delay-loaded (/DELAYLOAD), so nothing touches the DLL until
    // the first NDI call. Load it here from where NDI Tools / the NDI Runtime put
    // it (not on PATH); the delay-load helper then finds the module already loaded.
    static int state = -1;  // -1 not tried, 0 missing, 1 loaded
    static std::string detail;
    if (state < 0) {
        const char* dll = "Processing.NDI.Lib.x64.dll";
        std::vector<std::string> candidates;
        for (const char* var : { "NDI_RUNTIME_DIR_V6", "NDI_RUNTIME_DIR_V5" }) {
            std::string dir = EnvVar(var);
            if (!dir.empty()) candidates.push_back(dir + "\\" + dll);
        }
        std::string self = DirOfThisModule();
        if (!self.empty()) candidates.push_back(self + "\\" + dll);
        candidates.push_back(dll);
        state = 0;
        detail = "Processing.NDI.Lib.x64.dll not found: install NDI Tools or the NDI 6 Runtime (ndi.video)";
        if (GetModuleHandleA(dll)) { state = 1; detail = "already loaded"; }
        for (size_t i = 0; state == 0 && i < candidates.size(); i++) {
            const std::string& c = candidates[i];
            bool full = c.find('\\') != std::string::npos;
            if (LoadLibraryExA(c.c_str(), nullptr, full ? LOAD_WITH_ALTERED_SEARCH_PATH : 0)) { state = 1; detail = c; }
        }
        fprintf(stderr, "[NDI] Runtime %s: %s\n", state == 1 ? "loaded" : "unavailable", detail.c_str());
    }
    if (where) *where = detail;
    return state == 1;
#else
    if (where) *where = "linked";
    return true;
#endif
}

// ─────────────────────────────────────────────────────
// BGRA/BGRX → UYVY (BT.709, video range), cropped/padded to the output size.
// dst must already be filled with black.
// ─────────────────────────────────────────────────────
void NdiPassthroughHandler::BgraToUyvy(const uint8_t* src, int32_t srcStride, int32_t srcWidth, int32_t srcHeight,
                                       uint8_t* dst, int32_t dstStride, int32_t dstWidth, int32_t dstHeight) {
    int32_t w = std::min(srcWidth, dstWidth) & ~1;
    int32_t h = std::min(srcHeight, dstHeight);
    for (int32_t y = 0; y < h; y++) {
        const uint8_t* s = src + (size_t)y * srcStride;
        uint8_t* d = dst + (size_t)y * dstStride;
        for (int32_t x = 0; x < w; x += 2, s += 8, d += 4) {
            int b0 = s[0], g0 = s[1], r0 = s[2];
            int b1 = s[4], g1 = s[5], r1 = s[6];
            int y0 = (47 * r0 + 157 * g0 + 16 * b0 + 4096 + 128) >> 8;
            int y1 = (47 * r1 + 157 * g1 + 16 * b1 + 4096 + 128) >> 8;
            int r = (r0 + r1) >> 1, g = (g0 + g1) >> 1, b = (b0 + b1) >> 1;
            int u = (-26 * r - 87 * g + 112 * b + 32768 + 128) >> 8;
            int v = (112 * r - 102 * g - 10 * b + 32768 + 128) >> 8;
            d[0] = (uint8_t)std::clamp(u, 16, 240);
            d[1] = (uint8_t)std::clamp(y0, 16, 235);
            d[2] = (uint8_t)std::clamp(v, 16, 240);
            d[3] = (uint8_t)std::clamp(y1, 16, 235);
        }
    }
}

static void FillBlackUyvy(uint8_t* dst, int32_t bytes) {
    for (int32_t i = 0; i + 3 < bytes; i += 4) {
        dst[i] = 0x80; dst[i + 1] = 0x10; dst[i + 2] = 0x80; dst[i + 3] = 0x10;
    }
}

NdiPassthroughHandler::NdiPassthroughHandler()
    : m_ndiRecv(nullptr)
    , m_deckLink(nullptr)
    , m_output(nullptr)
    , m_width(1920)
    , m_height(1080)
    , m_rowBytes(1920 * 2)
    , m_audioEnabled(false)
    , m_audioSampleCount(0)
    , m_resampleFrac(0.0)
    , m_running(false)
    , m_framesOutput(0)
    , m_droppedFrames(0)
{
}

NdiPassthroughHandler::~NdiPassthroughHandler() {
    Stop();
}

// ─────────────────────────────────────────────────────
// NDI Source Discovery
// ─────────────────────────────────────────────────────
std::vector<NdiPassthroughHandler::NdiSource> NdiPassthroughHandler::FindSources(uint32_t timeoutMs) {
    std::vector<NdiSource> result;

    if (!RuntimeAvailable()) return result;
    if (!NDIlib_initialize()) {
        fprintf(stderr, "[NDI] Failed to initialize NDI library\n");
        return result;
    }

    NDIlib_find_create_t findCreate;
    findCreate.show_local_sources = true;
    findCreate.p_groups = nullptr;
    findCreate.p_extra_ips = nullptr;

    NDIlib_find_instance_t finder = NDIlib_find_create_v2(&findCreate);
    if (!finder) {
        fprintf(stderr, "[NDI] Failed to create finder\n");
        return result;
    }

    NDIlib_find_wait_for_sources(finder, timeoutMs);

    uint32_t numSources = 0;
    const NDIlib_source_t* sources = NDIlib_find_get_current_sources(finder, &numSources);

    for (uint32_t i = 0; i < numSources; i++) {
        NdiSource src;
        src.name = sources[i].p_ndi_name ? sources[i].p_ndi_name : "";
        src.url = sources[i].p_url_address ? sources[i].p_url_address : "";
        result.push_back(src);
        fprintf(stderr, "[NDI] Found source: %s (%s)\n", src.name.c_str(), src.url.c_str());
    }

    NDIlib_find_destroy(finder);
    return result;
}

// ─────────────────────────────────────────────────────
// Start: NDI Receive → DeckLink Output (Video + Audio)
// ─────────────────────────────────────────────────────
bool NdiPassthroughHandler::Start(const char* ndiSourceName,
                                   uint32_t outputDeviceIndex,
                                   BMDDisplayMode displayMode) {
    if (m_running) return false;

    // --- Initialize NDI ---
    std::string runtime;
    if (!RuntimeAvailable(&runtime)) {
        fprintf(stderr, "[NDI→SDI] %s\n", runtime.c_str());
        return false;
    }
    if (!NDIlib_initialize()) {
        fprintf(stderr, "[NDI→SDI] Failed to initialize NDI\n");
        return false;
    }

    // Find the named source
    NDIlib_find_create_t findCreate;
    findCreate.show_local_sources = true;
    findCreate.p_groups = nullptr;
    findCreate.p_extra_ips = nullptr;

    NDIlib_find_instance_t finder = NDIlib_find_create_v2(&findCreate);
    if (!finder) {
        fprintf(stderr, "[NDI→SDI] Failed to create NDI finder\n");
        return false;
    }

    const NDIlib_source_t* targetSource = nullptr;
    NDIlib_source_t matchedSource;

    for (int attempt = 0; attempt < 5; attempt++) {
        NDIlib_find_wait_for_sources(finder, 1000);

        uint32_t numSources = 0;
        const NDIlib_source_t* sources = NDIlib_find_get_current_sources(finder, &numSources);

        for (uint32_t i = 0; i < numSources; i++) {
            if (sources[i].p_ndi_name && strcmp(sources[i].p_ndi_name, ndiSourceName) == 0) {
                matchedSource = sources[i];
                targetSource = &matchedSource;
                break;
            }
        }
        if (targetSource) break;
        fprintf(stderr, "[NDI→SDI] Waiting for source '%s' (attempt %d)...\n", ndiSourceName, attempt + 1);
    }

    if (!targetSource) {
        fprintf(stderr, "[NDI→SDI] Source '%s' not found\n", ndiSourceName);
        NDIlib_find_destroy(finder);
        return false;
    }

    m_sourceName = ndiSourceName;

    // Create NDI receiver — UYVY for video (matches DeckLink), full bandwidth
    NDIlib_recv_create_v3_t recvCreate;
    recvCreate.source_to_connect_to = *targetSource;
    recvCreate.color_format = NDIlib_recv_color_format_UYVY_BGRA;
    recvCreate.bandwidth = NDIlib_recv_bandwidth_highest;
    // Whole (interleaved) frames only: separate fields arrive at half height and
    // would be cropped into the output; DeckLink's interlaced modes take woven frames.
    recvCreate.allow_video_fields = false;
    recvCreate.p_ndi_recv_name = "Community Captioner SDI";

    m_ndiRecv = NDIlib_recv_create_v3(&recvCreate);
    NDIlib_find_destroy(finder);

    if (!m_ndiRecv) {
        fprintf(stderr, "[NDI→SDI] Failed to create NDI receiver\n");
        return false;
    }

    fprintf(stderr, "[NDI→SDI] NDI receiver connected to '%s'\n", ndiSourceName);

    // --- Open DeckLink Output ---
    IDeckLinkIterator* iterator = CreateDeckLinkIterator();  // platform.h: COM init + CoCreateInstance on Windows
    if (!iterator) {
        fprintf(stderr, "[NDI→SDI] DeckLink driver not installed\n");
        NDIlib_recv_destroy(m_ndiRecv);
        m_ndiRecv = nullptr;
        return false;
    }

    IDeckLink* deckLink = nullptr;
    uint32_t idx = 0;
    while (iterator->Next(&deckLink) == S_OK) {
        if (idx == outputDeviceIndex) break;
        deckLink->Release();
        deckLink = nullptr;
        idx++;
    }
    iterator->Release();

    if (!deckLink) {
        fprintf(stderr, "[NDI→SDI] DeckLink device %u not found\n", outputDeviceIndex);
        NDIlib_recv_destroy(m_ndiRecv);
        m_ndiRecv = nullptr;
        return false;
    }

    m_deckLink = deckLink;

    if (deckLink->QueryInterface(IID_IDeckLinkOutput, (void**)&m_output) != S_OK) {
        fprintf(stderr, "[NDI→SDI] Device has no output interface\n");
        Stop();
        return false;
    }

    // Get display mode dimensions
    IDeckLinkDisplayModeIterator* modeIter = nullptr;
    m_output->GetDisplayModeIterator(&modeIter);
    if (modeIter) {
        IDeckLinkDisplayMode* modeObj = nullptr;
        while (modeIter->Next(&modeObj) == S_OK) {
            if (modeObj->GetDisplayMode() == displayMode) {
                m_width = modeObj->GetWidth();
                m_height = modeObj->GetHeight();
                m_rowBytes = m_width * 2; // UYVY
                modeObj->Release();
                break;
            }
            modeObj->Release();
        }
        modeIter->Release();
    }

    // Enable video output with VANC support
    HRESULT hr = m_output->EnableVideoOutput(displayMode, bmdVideoOutputVANC);
    if (hr != S_OK) {
        fprintf(stderr, "[NDI→SDI] EnableVideoOutput failed: 0x%08X\n", (unsigned)hr);
        Stop();
        return false;
    }

    // Enable audio output — always 48kHz 16-bit stereo (SDI standard)
    // We resample from whatever the NDI source provides
    hr = m_output->EnableAudioOutput(
        bmdAudioSampleRate48kHz,
        bmdAudioSampleType16bitInteger,
        2,  // stereo
        bmdAudioOutputStreamContinuous
    );
    if (hr == S_OK) {
        m_audioEnabled = true;
        m_audioSampleCount = 0;
        m_resampleFrac = 0.0;
        // Continuous mode: no preroll needed. Samples are written directly
        // and flow in sync with DisplayVideoFrameSync.
        fprintf(stderr, "[NDI→SDI] Audio output enabled: 48kHz 16-bit stereo (continuous)\n");
    } else {
        m_audioEnabled = false;
        fprintf(stderr, "[NDI→SDI] Audio output failed: 0x%08X (video-only mode)\n", (unsigned)hr);
    }

    fprintf(stderr, "[NDI→SDI] DeckLink output enabled: %dx%d\n", m_width, m_height);

    // --- Start receive thread ---
    m_running = true;
    m_framesOutput = 0;
    m_droppedFrames = 0;
    m_recvThread = std::thread(&NdiPassthroughHandler::RecvLoop, this);

    fprintf(stderr, "[NDI→SDI] Pipeline started: '%s' → DeckLink %u (%dx%d + audio)\n",
            ndiSourceName, outputDeviceIndex, m_width, m_height);
    return true;
}

// ─────────────────────────────────────────────────────
// Audio: Convert NDI float32 planar → int16 interleaved, resample to 48kHz
// ─────────────────────────────────────────────────────
void NdiPassthroughHandler::OutputAudio(const NDIlib_audio_frame_v2_t& audioFrame) {
    if (!m_audioEnabled || !m_output) return;

    int srcSamples = audioFrame.no_samples;
    int srcChannels = audioFrame.no_channels;
    int srcRate = audioFrame.sample_rate;

    if (srcSamples <= 0 || srcChannels <= 0 || srcRate <= 0) return;

    // Use NDI's built-in converter: float32 planar → int16 interleaved
    // This handles channel stride correctly
    NDIlib_audio_frame_interleaved_16s_t interleaved;
    interleaved.sample_rate = srcRate;
    interleaved.no_channels = srcChannels;
    interleaved.no_samples = srcSamples;
    interleaved.timecode = audioFrame.timecode;

    std::vector<int16_t> interleavedBuf(srcSamples * srcChannels);
    interleaved.p_data = interleavedBuf.data();

    NDIlib_util_audio_to_interleaved_16s_v2(&audioFrame, &interleaved);

    // Resample to 48kHz stereo and output
    ResampleAndOutput(interleavedBuf.data(), srcSamples, srcRate, srcChannels);
}

// ─────────────────────────────────────────────────────
// Linear resample from srcRate → 48kHz, mix down to stereo
// ─────────────────────────────────────────────────────
void NdiPassthroughHandler::ResampleAndOutput(const int16_t* interleavedIn,
                                               int numSamplesIn,
                                               int srcRate,
                                               int numChannels) {
    if (numSamplesIn <= 0 || numChannels <= 0) return;

    const int outChannels = 2; // DeckLink stereo

    if (srcRate == DECKLINK_AUDIO_RATE) {
        // No resampling needed — just mix down to stereo if needed
        std::vector<int16_t> outBuf(numSamplesIn * outChannels);

        for (int s = 0; s < numSamplesIn; s++) {
            if (numChannels >= 2) {
                // Take first two channels
                outBuf[s * 2 + 0] = interleavedIn[s * numChannels + 0];
                outBuf[s * 2 + 1] = interleavedIn[s * numChannels + 1];
            } else {
                // Mono → stereo
                outBuf[s * 2 + 0] = interleavedIn[s * numChannels];
                outBuf[s * 2 + 1] = interleavedIn[s * numChannels];
            }
        }

        uint32_t written = 0;
        HRESULT ahr = m_output->WriteAudioSamplesSync(
            outBuf.data(),
            numSamplesIn,
            &written
        );
        m_audioSampleCount += written;
        if (ahr != S_OK && m_audioSampleCount < 96000) {
            fprintf(stderr, "[NDI→SDI] WriteAudioSamplesSync failed: 0x%08X (wrote %u/%d)\n",
                    (unsigned)ahr, written, numSamplesIn);
        }
        return;
    }

    // ── Linear interpolation resample ──
    // Calculate how many output samples this input block produces
    double ratio = (double)DECKLINK_AUDIO_RATE / (double)srcRate;
    int numSamplesOut = (int)((double)numSamplesIn * ratio + m_resampleFrac);
    if (numSamplesOut <= 0) return;

    std::vector<int16_t> outBuf(numSamplesOut * outChannels);

    for (int outIdx = 0; outIdx < numSamplesOut; outIdx++) {
        // Position in the source buffer (fractional)
        double srcPos = ((double)outIdx - m_resampleFrac) / ratio;
        if (srcPos < 0.0) srcPos = 0.0;

        int srcIdx = (int)srcPos;
        double frac = srcPos - (double)srcIdx;

        // Clamp
        if (srcIdx >= numSamplesIn - 1) {
            srcIdx = numSamplesIn - 2;
            frac = 1.0;
        }
        if (srcIdx < 0) {
            srcIdx = 0;
            frac = 0.0;
        }

        for (int c = 0; c < outChannels; c++) {
            int srcCh = (c < numChannels) ? c : 0; // mono→stereo fallback

            int16_t s0 = interleavedIn[srcIdx * numChannels + srcCh];
            int16_t s1 = interleavedIn[(srcIdx + 1) * numChannels + srcCh];

            double interpolated = (double)s0 + frac * ((double)s1 - (double)s0);
            // Clamp to int16 range
            if (interpolated > 32767.0) interpolated = 32767.0;
            if (interpolated < -32768.0) interpolated = -32768.0;

            outBuf[outIdx * outChannels + c] = (int16_t)interpolated;
        }
    }

    // Track fractional remainder for seamless next block
    double totalSrcConsumed = (double)numSamplesOut / ratio;
    m_resampleFrac = (totalSrcConsumed - (double)numSamplesIn) * ratio;
    if (m_resampleFrac < 0.0) m_resampleFrac = 0.0;

    uint32_t written = 0;
    HRESULT ahr = m_output->WriteAudioSamplesSync(
        outBuf.data(),
        numSamplesOut,
        &written
    );
    m_audioSampleCount += written;
    if (ahr != S_OK && m_audioSampleCount < 96000) {
        fprintf(stderr, "[NDI→SDI] WriteAudioSamplesSync (resampled) failed: 0x%08X (wrote %u/%d)\n",
                (unsigned)ahr, written, numSamplesOut);
    }
}

// ─────────────────────────────────────────────────────
// Receive Loop: NDI frames → DeckLink output + VANC
// ─────────────────────────────────────────────────────
void NdiPassthroughHandler::RecvLoop() {
    ComInit com;  // Windows: this thread makes DeckLink COM calls (no-op on macOS)
    bool audioLogged = false;
    bool videoLogged = false;

    while (m_running) {
        NDIlib_video_frame_v2_t videoFrame;
        NDIlib_audio_frame_v2_t audioFrame;

        // Capture — NDI returns one frame type per call
        NDIlib_frame_type_e frameType = NDIlib_recv_capture_v2(
            m_ndiRecv, &videoFrame, &audioFrame, nullptr, 33);

        if (frameType == NDIlib_frame_type_video && m_output) {
            // Create DeckLink output frame
            IDeckLinkMutableVideoFrame* outFrame = nullptr;
            HRESULT hr = m_output->CreateVideoFrame(
                m_width, m_height, m_rowBytes,
                bmdFormat8BitYUV, bmdFrameFlagDefault, &outFrame);

            if (hr == S_OK && outFrame) {
                if (!videoLogged) {
                    char cc[5] = { (char)(videoFrame.FourCC & 0xFF), (char)((videoFrame.FourCC >> 8) & 0xFF),
                                   (char)((videoFrame.FourCC >> 16) & 0xFF), (char)((videoFrame.FourCC >> 24) & 0xFF), 0 };
                    fprintf(stderr, "[NDI→SDI] First video frame: %dx%d %s, %d/%d fps, format %d → output %dx%d\n",
                            videoFrame.xres, videoFrame.yres, cc, videoFrame.frame_rate_N, videoFrame.frame_rate_D,
                            (int)videoFrame.frame_format_type, m_width, m_height);
                    videoLogged = true;
                }
                // The pixel pointer is only valid inside this scope (Windows: StartAccess/
                // EndAccess on IDeckLinkVideoBuffer), and the buffer has to be released
                // before the frame is displayed.
                {
                    VideoFrameAccess access(outFrame, bmdBufferAccessWrite);
                    uint8_t* dst = (uint8_t*)access.data;
                    if (dst && videoFrame.p_data) {
                        int32_t srcRowBytes = videoFrame.line_stride_in_bytes;
                        int32_t srcWidth = videoFrame.xres;
                        int32_t srcHeight = videoFrame.yres;
                        bool uyvy = videoFrame.FourCC == NDIlib_FourCC_video_type_UYVY;
                        bool bgra = videoFrame.FourCC == NDIlib_FourCC_video_type_BGRA || videoFrame.FourCC == NDIlib_FourCC_video_type_BGRX;

                        if (uyvy && srcWidth == m_width && srcHeight == m_height && srcRowBytes == m_rowBytes) {
                            // Perfect match — direct copy
                            memcpy(dst, videoFrame.p_data, (size_t)m_height * m_rowBytes);
                        } else if (uyvy) {
                            // Same format, different resolution — crop/pad
                            int32_t copyWidth = std::min(srcWidth, m_width) * 2;
                            int32_t copyHeight = std::min(srcHeight, m_height);
                            FillBlackUyvy(dst, m_height * m_rowBytes);
                            for (int32_t y = 0; y < copyHeight; y++) {
                                memcpy(dst + (size_t)y * m_rowBytes,
                                       videoFrame.p_data + (size_t)y * srcRowBytes,
                                       copyWidth);
                            }
                        } else if (bgra) {
                            // Sources with alpha (graphics, keys) arrive as BGRA
                            FillBlackUyvy(dst, m_height * m_rowBytes);
                            BgraToUyvy(videoFrame.p_data, srcRowBytes, srcWidth, srcHeight,
                                       dst, m_rowBytes, m_width, m_height);
                        } else {
                            // Anything else — fill black
                            FillBlackUyvy(dst, m_height * m_rowBytes);
                            m_droppedFrames++;
                        }
                    }
                }

                // Attach VANC caption data — consume one CDP per frame
                {
                    std::lock_guard<std::mutex> lock(m_cdpMutex);
                    if (!m_cdpQueue.empty()) {
                        auto& cdp = m_cdpQueue.front();
                        IDeckLinkVideoFrameAncillaryPackets* packets = nullptr;
                        HRESULT ancHr = outFrame->QueryInterface(IID_IDeckLinkVideoFrameAncillaryPackets,
                                                                   (void**)&packets);
                        if (ancHr == S_OK && packets) {
                            CaptionAncillaryPacket* pkt = new CaptionAncillaryPacket(
                                cdp.data(), cdp.size());
                            packets->AttachPacket(pkt);
                            pkt->Release();
                            packets->Release();
                        }
                        m_cdpQueue.pop();  // Consume — each CDP used exactly once
                    }
                }

                // Display frame
                hr = m_output->DisplayVideoFrameSync(outFrame);
                if (hr == S_OK) {
                    m_framesOutput++;
                } else {
                    m_droppedFrames++;
                }

                outFrame->Release();
            } else {
                m_droppedFrames++;
            }

            NDIlib_recv_free_video_v2(m_ndiRecv, &videoFrame);

        } else if (frameType == NDIlib_frame_type_audio && m_output) {
            // Log first audio frame details
            if (!audioLogged) {
                fprintf(stderr, "[NDI→SDI] First audio frame: %d ch, %d Hz, %d samples\n",
                        audioFrame.no_channels, audioFrame.sample_rate, audioFrame.no_samples);
                audioLogged = true;
            }

            // Pass audio through to DeckLink (with resampling if needed)
            OutputAudio(audioFrame);
            NDIlib_recv_free_audio_v2(m_ndiRecv, &audioFrame);
        }
    }
}

// ─────────────────────────────────────────────────────
// Stop
// ─────────────────────────────────────────────────────
void NdiPassthroughHandler::Stop() {
    m_running = false;

    if (m_recvThread.joinable()) {
        m_recvThread.join();
    }

    if (m_ndiRecv) {
        NDIlib_recv_destroy(m_ndiRecv);
        m_ndiRecv = nullptr;
    }

    if (m_output) {
        if (m_audioEnabled) {
            m_output->DisableAudioOutput();
            m_audioEnabled = false;
        }
        m_output->DisableVideoOutput();
        m_output->Release();
        m_output = nullptr;
    }

    if (m_deckLink) {
        m_deckLink->Release();
        m_deckLink = nullptr;
    }

    fprintf(stderr, "[NDI→SDI] Pipeline stopped (total samples scheduled: %llu)\n", m_audioSampleCount);
}

void NdiPassthroughHandler::PushCDP(const uint8_t* data, size_t size) {
    std::lock_guard<std::mutex> lock(m_cdpMutex);
    // Cap queue at ~60 CDPs (~2 seconds) to prevent unbounded growth
    if (m_cdpQueue.size() < 60) {
        m_cdpQueue.push(std::vector<uint8_t>(data, data + size));
    }
}
