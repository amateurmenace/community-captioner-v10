#pragma once

#include <napi.h>
#include "DeckLinkAPI.h"
#include <mutex>
#include <vector>
#include <atomic>

/**
 * Standalone SDI output: generates black frames with CEA-708 VANC data.
 * Implements IDeckLinkVideoOutputCallback for scheduled playback.
 */
class OutputHandler : public IDeckLinkVideoOutputCallback {
public:
    OutputHandler();
    virtual ~OutputHandler();

    // Control
    bool Start(uint32_t deviceIndex, BMDDisplayMode displayMode);
    void Stop();
    bool IsRunning() const { return m_running; }

    // Push a CDP packet (called from JS thread)
    void PushCDP(const uint8_t* data, size_t size);

    // Stats
    uint64_t GetFramesOutput() const { return m_framesOutput; }
    uint64_t GetDroppedFrames() const { return m_droppedFrames; }

    // IDeckLinkVideoOutputCallback
    HRESULT ScheduledFrameCompleted(IDeckLinkVideoFrame* completedFrame,
                                     BMDOutputFrameCompletionResult result) override;
    HRESULT ScheduledPlaybackHasStopped() override;

    // IUnknown
    HRESULT QueryInterface(REFIID iid, void** ppv) override;
    ULONG AddRef() override;
    ULONG Release() override;

private:
    void ScheduleNextFrame();
    void CreateBlackFrame();

    IDeckLink* m_deckLink;
    IDeckLinkOutput* m_output;
    IDeckLinkMutableVideoFrame* m_frameA;
    IDeckLinkMutableVideoFrame* m_frameB;
    bool m_useFrameA;

    int32_t m_width;
    int32_t m_height;
    BMDTimeValue m_frameDuration;
    BMDTimeScale m_timeScale;
    BMDTimeValue m_totalFrames;

    std::mutex m_cdpMutex;
    std::vector<uint8_t> m_currentCDP;

    std::atomic<bool> m_running;
    std::atomic<uint64_t> m_framesOutput;
    std::atomic<uint64_t> m_droppedFrames;
    std::atomic<ULONG> m_refCount;
};
