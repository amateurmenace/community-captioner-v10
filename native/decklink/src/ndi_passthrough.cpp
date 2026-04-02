#include "ndi_passthrough.h"
#include "vanc_packet.h"
#include <cstring>
#include <cstdio>
#include <cmath>
#include <algorithm>

static const int DECKLINK_AUDIO_RATE = 48000;

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
    recvCreate.allow_video_fields = true;
    recvCreate.p_ndi_recv_name = "Community Captioner SDI";

    m_ndiRecv = NDIlib_recv_create_v3(&recvCreate);
    NDIlib_find_destroy(finder);

    if (!m_ndiRecv) {
        fprintf(stderr, "[NDI→SDI] Failed to create NDI receiver\n");
        return false;
    }

    fprintf(stderr, "[NDI→SDI] NDI receiver connected to '%s'\n", ndiSourceName);

    // --- Open DeckLink Output ---
    IDeckLinkIterator* iterator = CreateDeckLinkIteratorInstance();
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
    bool audioLogged = false;

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
                void* outBuf = nullptr;
                outFrame->GetBytes(&outBuf);

                if (outBuf && videoFrame.p_data) {
                    int32_t srcRowBytes = videoFrame.line_stride_in_bytes;
                    int32_t srcWidth = videoFrame.xres;
                    int32_t srcHeight = videoFrame.yres;

                    if (srcWidth == m_width && srcHeight == m_height && srcRowBytes == m_rowBytes) {
                        // Perfect match — direct copy
                        memcpy(outBuf, videoFrame.p_data, m_height * m_rowBytes);
                    } else if (videoFrame.FourCC == NDIlib_FourCC_video_type_UYVY) {
                        // Same format, different resolution — crop/pad
                        int32_t copyWidth = std::min(srcWidth, m_width) * 2;
                        int32_t copyHeight = std::min(srcHeight, m_height);

                        // Black fill first
                        uint8_t* dst = (uint8_t*)outBuf;
                        for (int32_t i = 0; i < m_height * m_rowBytes; i += 4) {
                            dst[i]     = 0x80; // Cb
                            dst[i + 1] = 0x10; // Y
                            dst[i + 2] = 0x80; // Cr
                            dst[i + 3] = 0x10; // Y
                        }

                        for (int32_t y = 0; y < copyHeight; y++) {
                            memcpy(dst + y * m_rowBytes,
                                   videoFrame.p_data + y * srcRowBytes,
                                   copyWidth);
                        }
                    } else {
                        // Non-UYVY — fill black
                        uint8_t* dst = (uint8_t*)outBuf;
                        for (int32_t i = 0; i < m_height * m_rowBytes; i += 4) {
                            dst[i]     = 0x80;
                            dst[i + 1] = 0x10;
                            dst[i + 2] = 0x80;
                            dst[i + 3] = 0x10;
                        }
                        m_droppedFrames++;
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
