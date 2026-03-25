#pragma once

#include "DeckLinkAPI.h"
#include <cstdint>
#include <vector>
#include <atomic>

/**
 * Custom IDeckLinkAncillaryPacket implementation for CEA-708 CDP data.
 * DID=0x61, SDID=0x01 per SMPTE 334.
 */
class CaptionAncillaryPacket : public IDeckLinkAncillaryPacket {
public:
    CaptionAncillaryPacket(const uint8_t* cdpData, size_t cdpSize);
    virtual ~CaptionAncillaryPacket();

    // IUnknown
    HRESULT QueryInterface(REFIID iid, void** ppv) override;
    ULONG AddRef() override;
    ULONG Release() override;

    // IDeckLinkAncillaryPacket
    HRESULT GetBytes(BMDAncillaryPacketFormat format, const void** data, uint32_t* size) override;
    uint8_t GetDID() override;
    uint8_t GetSDID() override;
    uint32_t GetLineNumber() override;
    uint8_t GetDataStreamIndex() override;

private:
    std::vector<uint8_t> m_data;
    std::atomic<ULONG> m_refCount;
};
