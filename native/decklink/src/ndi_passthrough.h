#pragma once

#include "DeckLinkAPI.h"
#include <Processing.NDI.Lib.h>
#include <mutex>
#include <vector>
#include <queue>
#include <atomic>
#include <thread>
#include <string>

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

    // NDI source discovery
    struct NdiSource {
        std::string name;
        std::string url;
    };
    static std::vector<NdiSource> FindSources(uint32_t timeoutMs = 2000);

    // Start NDI receive → DeckLink output
    bool Start(const char* ndiSourceName,
               uint32_t outputDeviceIndex,
               BMDDisplayMode displayMode);
    void Stop();
    bool IsRunning() const { return m_running; }

    // Push CDP packet for VANC embedding
    void PushCDP(const uint8_t* data, size_t size);

    uint64_t GetFramesOutput() const { return m_framesOutput; }
    uint64_t GetDroppedFrames() const { return m_droppedFrames; }
    std::string GetSourceName() const { return m_sourceName; }

private:
    void RecvLoop();
    void OutputAudio(const NDIlib_audio_frame_v2_t& audioFrame);

    // Linear resampling: srcRate → 48kHz
    void ResampleAndOutput(const int16_t* interleavedIn, int numSamplesIn,
                           int srcRate, int numChannels);

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
