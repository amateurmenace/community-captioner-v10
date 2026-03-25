#include "passthrough.h"
#include "vanc_packet.h"
#include <cstring>
#include <cstdio>

PassthroughHandler::PassthroughHandler()
    : m_inputDeckLink(nullptr)
    , m_outputDeckLink(nullptr)
    , m_input(nullptr)
    , m_output(nullptr)
    , m_width(1920)
    , m_height(1080)
    , m_rowBytes(1920 * 2)
    , m_running(false)
    , m_framesOutput(0)
    , m_droppedFrames(0)
    , m_refCount(1)
{
}

PassthroughHandler::~PassthroughHandler() {
    Stop();
}

static IDeckLink* GetDeviceByIndex(uint32_t index) {
    IDeckLinkIterator* iterator = CreateDeckLinkIteratorInstance();
    if (!iterator) return nullptr;

    IDeckLink* deckLink = nullptr;
    uint32_t idx = 0;
    while (iterator->Next(&deckLink) == S_OK) {
        if (idx == index) { iterator->Release(); return deckLink; }
        deckLink->Release();
        deckLink = nullptr;
        idx++;
    }
    iterator->Release();
    return nullptr;
}

bool PassthroughHandler::Start(uint32_t inputDeviceIndex, uint32_t outputDeviceIndex,
                                BMDDisplayMode displayMode) {
    if (m_running) return false;

    // Open input device
    m_inputDeckLink = GetDeviceByIndex(inputDeviceIndex);
    if (!m_inputDeckLink) {
        fprintf(stderr, "[Passthrough] Input device %u not found\n", inputDeviceIndex);
        return false;
    }

    if (m_inputDeckLink->QueryInterface(IID_IDeckLinkInput, (void**)&m_input) != S_OK) {
        fprintf(stderr, "[Passthrough] Input device has no input interface\n");
        Stop();
        return false;
    }

    // Open output device (may be same physical card, different sub-device)
    m_outputDeckLink = GetDeviceByIndex(outputDeviceIndex);
    if (!m_outputDeckLink) {
        fprintf(stderr, "[Passthrough] Output device %u not found\n", outputDeviceIndex);
        Stop();
        return false;
    }

    if (m_outputDeckLink->QueryInterface(IID_IDeckLinkOutput, (void**)&m_output) != S_OK) {
        fprintf(stderr, "[Passthrough] Output device has no output interface\n");
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

    // Enable output with VANC
    HRESULT hr = m_output->EnableVideoOutput(displayMode, bmdVideoOutputVANC);
    if (hr != S_OK) {
        fprintf(stderr, "[Passthrough] EnableVideoOutput failed: 0x%08X\n", (unsigned)hr);
        Stop();
        return false;
    }

    // Enable input with format detection
    m_input->SetCallback(this);
    hr = m_input->EnableVideoInput(displayMode, bmdFormat8BitYUV,
                                    bmdVideoInputEnableFormatDetection);
    if (hr != S_OK) {
        fprintf(stderr, "[Passthrough] EnableVideoInput failed: 0x%08X\n", (unsigned)hr);
        Stop();
        return false;
    }

    hr = m_input->StartStreams();
    if (hr != S_OK) {
        fprintf(stderr, "[Passthrough] StartStreams failed: 0x%08X\n", (unsigned)hr);
        Stop();
        return false;
    }

    m_running = true;
    m_framesOutput = 0;
    m_droppedFrames = 0;
    fprintf(stderr, "[Passthrough] Started: in=%u out=%u %dx%d\n",
            inputDeviceIndex, outputDeviceIndex, m_width, m_height);
    return true;
}

void PassthroughHandler::Stop() {
    m_running = false;

    if (m_input) {
        m_input->StopStreams();
        m_input->DisableVideoInput();
        m_input->SetCallback(nullptr);
        m_input->Release();
        m_input = nullptr;
    }
    if (m_output) {
        m_output->DisableVideoOutput();
        m_output->Release();
        m_output = nullptr;
    }
    if (m_inputDeckLink) { m_inputDeckLink->Release(); m_inputDeckLink = nullptr; }
    if (m_outputDeckLink) { m_outputDeckLink->Release(); m_outputDeckLink = nullptr; }
}

void PassthroughHandler::PushCDP(const uint8_t* data, size_t size) {
    std::lock_guard<std::mutex> lock(m_cdpMutex);
    m_currentCDP.assign(data, data + size);
}

HRESULT PassthroughHandler::VideoInputFrameArrived(IDeckLinkVideoInputFrame* videoFrame,
                                                    IDeckLinkAudioInputPacket* audioPacket) {
    if (!videoFrame || !m_running || !m_output) return S_OK;

    // Create output frame matching input dimensions
    IDeckLinkMutableVideoFrame* outFrame = nullptr;
    HRESULT hr = m_output->CreateVideoFrame(
        m_width, m_height, m_rowBytes,
        bmdFormat8BitYUV, bmdFrameFlagDefault, &outFrame);

    if (hr != S_OK || !outFrame) {
        m_droppedFrames++;
        return S_OK;
    }

    // Copy pixel data from input to output
    void* inBuf = nullptr;
    void* outBuf = nullptr;
    videoFrame->GetBytes(&inBuf);
    outFrame->GetBytes(&outBuf);

    if (inBuf && outBuf) {
        memcpy(outBuf, inBuf, m_height * m_rowBytes);
    }

    // Attach VANC caption data
    {
        std::lock_guard<std::mutex> lock(m_cdpMutex);
        if (!m_currentCDP.empty()) {
            IDeckLinkVideoFrameAncillaryPackets* packets = nullptr;
            if (outFrame->QueryInterface(IID_IDeckLinkVideoFrameAncillaryPackets,
                                          (void**)&packets) == S_OK) {
                CaptionAncillaryPacket* pkt = new CaptionAncillaryPacket(
                    m_currentCDP.data(), m_currentCDP.size());
                packets->AttachPacket(pkt);
                pkt->Release();
                packets->Release();
            }
        }
    }

    // Output synchronously (input drives timing)
    hr = m_output->DisplayVideoFrameSync(outFrame);
    if (hr == S_OK) {
        m_framesOutput++;
    } else {
        m_droppedFrames++;
    }

    outFrame->Release();
    return S_OK;
}

HRESULT PassthroughHandler::VideoInputFormatChanged(BMDVideoInputFormatChangedEvents events,
                                                     IDeckLinkDisplayMode* newDisplayMode,
                                                     BMDDetectedVideoInputFormatFlags flags) {
    if (!newDisplayMode || !m_input) return S_OK;

    BMDDisplayMode newMode = newDisplayMode->GetDisplayMode();
    m_width = newDisplayMode->GetWidth();
    m_height = newDisplayMode->GetHeight();
    m_rowBytes = m_width * 2;

    // Restart with new format
    m_input->StopStreams();
    m_input->EnableVideoInput(newMode, bmdFormat8BitYUV, bmdVideoInputEnableFormatDetection);

    if (m_output) {
        m_output->DisableVideoOutput();
        m_output->EnableVideoOutput(newMode, bmdVideoOutputVANC);
    }

    m_input->StartStreams();
    fprintf(stderr, "[Passthrough] Format changed to %dx%d\n", m_width, m_height);
    return S_OK;
}

// IUnknown
HRESULT PassthroughHandler::QueryInterface(REFIID iid, void** ppv) {
    if (!ppv) return E_INVALIDARG;
    *ppv = nullptr;
    return E_NOINTERFACE;
}

ULONG PassthroughHandler::AddRef() { return ++m_refCount; }
ULONG PassthroughHandler::Release() {
    ULONG count = --m_refCount;
    if (count == 0) delete this;
    return count;
}
