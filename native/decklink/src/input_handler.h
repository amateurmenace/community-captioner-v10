#pragma once

#include "DeckLinkAPI.h"
#include <mutex>
#include <atomic>
#include <functional>

/**
 * SDI input capture handler. Implements IDeckLinkInputCallback
 * to receive video frames for pass-through mode.
 */
class InputHandler : public IDeckLinkInputCallback {
public:
    InputHandler();
    virtual ~InputHandler();

    using FormatChangeCallback = std::function<void(BMDDisplayMode newMode, BMDPixelFormat pixelFormat)>;

    bool Start(uint32_t deviceIndex, BMDDisplayMode displayMode);
    void Stop();
    bool IsRunning() const { return m_running; }

    // Get latest captured frame (caller must Release it)
    IDeckLinkVideoInputFrame* GetLatestFrame();

    void SetFormatChangeCallback(FormatChangeCallback cb) { m_formatChangeCb = cb; }

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
    IDeckLink* m_deckLink;
    IDeckLinkInput* m_input;

    std::mutex m_frameMutex;
    IDeckLinkVideoInputFrame* m_latestFrame;

    FormatChangeCallback m_formatChangeCb;

    std::atomic<bool> m_running;
    std::atomic<ULONG> m_refCount;
};
