#pragma once

#include "platform.h"
#include "input_handler.h"
#include <mutex>
#include <vector>
#include <queue>
#include <atomic>

/**
 * Pass-through mode: captures SDI input, copies frames to output,
 * and injects CEA-708 VANC data on every output frame.
 */
class PassthroughHandler : public IDeckLinkInputCallback,
                            public IDeckLinkVideoOutputCallback {
public:
    PassthroughHandler();
    virtual ~PassthroughHandler();

    bool Start(uint32_t inputDeviceIndex, uint32_t outputDeviceIndex,
               BMDDisplayMode displayMode);
    void Stop();
    bool IsRunning() const { return m_running; }

    void PushCDP(const uint8_t* data, size_t size);

    uint64_t GetFramesOutput() const { return m_framesOutput; }
    uint64_t GetDroppedFrames() const { return m_droppedFrames; }

    // IDeckLinkInputCallback
    HRESULT VideoInputFrameArrived(IDeckLinkVideoInputFrame* videoFrame,
                                    IDeckLinkAudioInputPacket* audioPacket) override;
    HRESULT VideoInputFormatChanged(BMDVideoInputFormatChangedEvents events,
                                     IDeckLinkDisplayMode* newDisplayMode,
                                     BMDDetectedVideoInputFormatFlags flags) override;

    // IDeckLinkVideoOutputCallback
    HRESULT ScheduledFrameCompleted(IDeckLinkVideoFrame* completedFrame,
                                     BMDOutputFrameCompletionResult result) override;
    HRESULT ScheduledPlaybackHasStopped() override;

    // IUnknown
    HRESULT QueryInterface(REFIID iid, void** ppv) override;
    ULONG AddRef() override;
    ULONG Release() override;

private:
    IDeckLink* m_inputDeckLink;
    IDeckLink* m_outputDeckLink;
    IDeckLinkInput* m_input;
    IDeckLinkOutput* m_output;

    int32_t m_width;
    int32_t m_height;
    int32_t m_rowBytes;
    BMDDisplayMode m_currentMode;
    BMDTimeValue m_frameDuration;
    BMDTimeScale m_timeScale;
    std::atomic<bool> m_playbackStarted;
    BMDTimeValue m_outputFrameCount;
    int m_prerollCount;

    // Fixed pool of pre-allocated output frames. The device caps the number
    // of distinct frame references it tracks in flight (we saw ~35), so we
    // reuse a small set of frames in round-robin order instead of allocating
    // a fresh IDeckLinkMutableVideoFrame on every input callback.
    static const int kFrameCount = 4;
    IDeckLinkMutableVideoFrame* m_frames[kFrameCount];
    std::atomic<uint64_t> m_nextWriteIdx;       // input-side: next index to fill
    std::atomic<uint64_t> m_nextCompletedIdx;   // device-side: highest index the device has finished
    void AllocateFramePool();
    void ReleaseFramePool();

    std::mutex m_cdpMutex;
    std::queue<std::vector<uint8_t>> m_cdpQueue;

    std::atomic<bool> m_running;
    std::atomic<uint64_t> m_framesOutput;
    std::atomic<uint64_t> m_droppedFrames;
    std::atomic<ULONG> m_refCount;
};
