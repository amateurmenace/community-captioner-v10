#pragma once

#include "platform.h"
#include <Processing.NDI.Lib.h>
#include <mutex>
#include <vector>
#include <queue>
#include <atomic>
#include <thread>
#include <string>
#ifdef _WIN32
#include "wasapi_capture.h"
#endif

/**
 * NDI-to-SDI passthrough with CEA-708 VANC caption embedding.
 *
 * Receives an NDI source (video + audio), converts to UYVY, outputs
 * via DeckLink SDI with VANC ancillary data containing CEA-708 CDP packets.
 * Audio is resampled to 48kHz if the NDI source uses a different rate.
 *
 * This replaces the need for a separate NDI-to-SDI bridge application.
 */
class NdiPassthroughHandler {
public:
    NdiPassthroughHandler();
    ~NdiPassthroughHandler();

    // Whether the NDI runtime library can be loaded. On Windows the DLL is
    // delay-loaded: this loads it from NDI_RUNTIME_DIR_V6/V5 (NDI Tools or the
    // NDI Runtime), next to the addon, or the normal search path, and must
    // succeed before any other NDI call. `where` receives the path or the reason.
    static bool RuntimeAvailable(std::string* where = nullptr);

    // NDI source discovery
    struct NdiSource {
        std::string name;
        std::string url;
    };
    static std::vector<NdiSource> FindSources(uint32_t timeoutMs = 2000);

    // Start NDI receive → DeckLink output. audioDeviceId (Windows): embed this
    // audio input device instead of the NDI source's audio ("" / null = NDI audio).
    bool Start(const char* ndiSourceName,
               uint32_t outputDeviceIndex,
               BMDDisplayMode displayMode,
               const char* audioDeviceId = nullptr);
    void Stop();
    bool IsRunning() const { return m_running; }

    // Push CDP packet for VANC embedding
    void PushCDP(const uint8_t* data, size_t size);

    uint64_t GetFramesOutput() const { return m_framesOutput; }
    uint64_t GetDroppedFrames() const { return m_droppedFrames; }
    std::string GetSourceName() const { return m_sourceName; }
    std::string GetAudioDeviceName() const { return m_audioDeviceName; }
    uint64_t GetAudioInputFrames() const { return m_audioInFrames; }
    int GetAudioInputPeak() const { return m_audioInPeak; }   // 0..32767, decays per video frame

private:
    void RecvLoop();
    void OutputAudio(const NDIlib_audio_frame_v2_t& audioFrame);

    // Linear resampling: srcRate → 48kHz
    void ResampleAndOutput(const int16_t* interleavedIn, int numSamplesIn,
                           int srcRate, int numChannels);

    // Sources with alpha arrive as BGRA/BGRX even when UYVY is requested;
    // convert them (BT.709, video range) instead of sending black.
    static void BgraToUyvy(const uint8_t* src, int32_t srcStride, int32_t srcWidth, int32_t srcHeight,
                           uint8_t* dst, int32_t dstStride, int32_t dstWidth, int32_t dstHeight);

    // NDI
    NDIlib_recv_instance_t m_ndiRecv;
    std::string m_sourceName;

    // DeckLink
    IDeckLink* m_deckLink;
    IDeckLinkOutput* m_output;

    int32_t m_width;
    int32_t m_height;
    int32_t m_rowBytes;

    // Audio
    bool m_audioEnabled;
    uint64_t m_audioSampleCount; // running count for ScheduleAudioSamples
    bool m_externalAudio = false;    // audio comes from a PC input device, not the NDI stream
    std::string m_audioDeviceName;
    std::atomic<uint64_t> m_audioInFrames{0};
    std::atomic<int> m_audioInPeak{0};
    // Captured samples wait here until the video thread writes them (interleaved stereo int16)
    std::mutex m_audioInMutex;
    std::vector<int16_t> m_audioInBuf;
    void DrainAudioInput();
#ifdef _WIN32
    WasapiCapture m_audioCapture;
#endif

    // Output timing (for RP188 timecode on every frame)
    double m_fps = 29.97;
    bool m_dropFrame = false;

    // Resample state (fractional accumulator for non-48k sources)
    double m_resampleFrac;

    // Caption data — queue of CDP packets, one consumed per output frame
    std::mutex m_cdpMutex;
    std::queue<std::vector<uint8_t>> m_cdpQueue;

    // Thread
    std::thread m_recvThread;
    std::atomic<bool> m_running;
    std::atomic<uint64_t> m_framesOutput;
    std::atomic<uint64_t> m_droppedFrames;
};
