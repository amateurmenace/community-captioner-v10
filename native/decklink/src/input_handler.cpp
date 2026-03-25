#include "input_handler.h"
#include <cstdio>
#include <cstring>

InputHandler::InputHandler()
    : m_deckLink(nullptr)
    , m_input(nullptr)
    , m_latestFrame(nullptr)
    , m_running(false)
    , m_refCount(1)
{
}

InputHandler::~InputHandler() {
    Stop();
}

bool InputHandler::Start(uint32_t deviceIndex, BMDDisplayMode displayMode) {
    if (m_running) return false;

    IDeckLinkIterator* iterator = CreateDeckLinkIteratorInstance();
    if (!iterator) return false;

    IDeckLink* deckLink = nullptr;
    uint32_t idx = 0;
    while (iterator->Next(&deckLink) == S_OK) {
        if (idx == deviceIndex) break;
        deckLink->Release();
        deckLink = nullptr;
        idx++;
    }
    iterator->Release();

    if (!deckLink) {
        fprintf(stderr, "[DeckLink Input] Device index %u not found\n", deviceIndex);
        return false;
    }

    m_deckLink = deckLink;

    if (deckLink->QueryInterface(IID_IDeckLinkInput, (void**)&m_input) != S_OK) {
        fprintf(stderr, "[DeckLink Input] Device does not support input\n");
        m_deckLink->Release();
        m_deckLink = nullptr;
        return false;
    }

    m_input->SetCallback(this);

    HRESULT hr = m_input->EnableVideoInput(displayMode, bmdFormat8BitYUV,
                                            bmdVideoInputEnableFormatDetection);
    if (hr != S_OK) {
        fprintf(stderr, "[DeckLink Input] EnableVideoInput failed: 0x%08X\n", (unsigned)hr);
        m_input->Release();
        m_input = nullptr;
        m_deckLink->Release();
        m_deckLink = nullptr;
        return false;
    }

    hr = m_input->StartStreams();
    if (hr != S_OK) {
        fprintf(stderr, "[DeckLink Input] StartStreams failed: 0x%08X\n", (unsigned)hr);
        m_input->DisableVideoInput();
        m_input->Release();
        m_input = nullptr;
        m_deckLink->Release();
        m_deckLink = nullptr;
        return false;
    }

    m_running = true;
    fprintf(stderr, "[DeckLink Input] Started on device %u\n", deviceIndex);
    return true;
}

void InputHandler::Stop() {
    if (m_input && m_running) {
        m_running = false;
        m_input->StopStreams();
        m_input->DisableVideoInput();
        m_input->SetCallback(nullptr);
    }

    {
        std::lock_guard<std::mutex> lock(m_frameMutex);
        if (m_latestFrame) {
            m_latestFrame->Release();
            m_latestFrame = nullptr;
        }
    }

    if (m_input) { m_input->Release(); m_input = nullptr; }
    if (m_deckLink) { m_deckLink->Release(); m_deckLink = nullptr; }
}

IDeckLinkVideoInputFrame* InputHandler::GetLatestFrame() {
    std::lock_guard<std::mutex> lock(m_frameMutex);
    if (m_latestFrame) {
        m_latestFrame->AddRef();
    }
    return m_latestFrame;
}

HRESULT InputHandler::VideoInputFrameArrived(IDeckLinkVideoInputFrame* videoFrame,
                                              IDeckLinkAudioInputPacket* audioPacket) {
    if (!videoFrame) return S_OK;

    std::lock_guard<std::mutex> lock(m_frameMutex);
    if (m_latestFrame) {
        m_latestFrame->Release();
    }
    videoFrame->AddRef();
    m_latestFrame = videoFrame;

    return S_OK;
}

HRESULT InputHandler::VideoInputFormatChanged(BMDVideoInputFormatChangedEvents events,
                                               IDeckLinkDisplayMode* newDisplayMode,
                                               BMDDetectedVideoInputFormatFlags flags) {
    if (!newDisplayMode) return S_OK;

    BMDDisplayMode newMode = newDisplayMode->GetDisplayMode();
    BMDPixelFormat pixelFormat = bmdFormat8BitYUV;

    // Restart input with new format
    if (m_input) {
        m_input->StopStreams();
        m_input->EnableVideoInput(newMode, pixelFormat, bmdVideoInputEnableFormatDetection);
        m_input->StartStreams();
    }

    if (m_formatChangeCb) {
        m_formatChangeCb(newMode, pixelFormat);
    }

    fprintf(stderr, "[DeckLink Input] Format changed, restarted\n");
    return S_OK;
}

// IUnknown
HRESULT InputHandler::QueryInterface(REFIID iid, void** ppv) {
    if (!ppv) return E_INVALIDARG;
    *ppv = nullptr;
    return E_NOINTERFACE;
}

ULONG InputHandler::AddRef() { return ++m_refCount; }
ULONG InputHandler::Release() {
    ULONG count = --m_refCount;
    if (count == 0) delete this;
    return count;
}
