#pragma once

#include "DeckLinkAPI.h"
#include "input_handler.h"
#include <mutex>
#include <vector>
#include <atomic>

/**
 * Pass-through mode: captures SDI input, copies frames to output,
 * and injects CEA-708 VANC data on every output frame.
 */
class PassthroughHandler : public IDeckLinkInputCallback {
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

    std::mutex m_cdpMutex;
    std::vector<uint8_t> m_currentCDP;

    std::atomic<bool> m_running;
    std::atomic<uint64_t> m_framesOutput;
    std::atomic<uint64_t> m_droppedFrames;
    std::atomic<ULONG> m_refCount;
};
