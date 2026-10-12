# SDI verification tools: decklink_probe (DeckLink SDK) and ndi_testsrc (NDI SDK).
# Not part of the app. Windows: run cmake from an x64 Native Tools / vcvars64 shell
# (MIDL must be on PATH). See README.md.
cmake_minimum_required(VERSION 3.15)
project(sdi_verify C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(ADDON_SRC "${CMAKE_CURRENT_SOURCE_DIR}/../../native/decklink/src")  # platform.h

# ---- decklink_probe ----------------------------------------------------------
if(WIN32)
    if(NOT DEFINED BMD_SDK_DIR)
        message(FATAL_ERROR "Set -DBMD_SDK_DIR=<DeckLink SDK>/Win/include")
    endif()
    set(BMD_GEN_DIR "${CMAKE_BINARY_DIR}/bmd_gen")
    file(MAKE_DIRECTORY ${BMD_GEN_DIR})
    add_custom_command(
        OUTPUT ${BMD_GEN_DIR}/DeckLinkAPI_h.h ${BMD_GEN_DIR}/DeckLinkAPI_i.c
        COMMAND midl /nologo /win64 /h DeckLinkAPI_h.h /iid DeckLinkAPI_i.c /out ${BMD_GEN_DIR} ${BMD_SDK_DIR}/DeckLinkAPI.idl
        DEPENDS ${BMD_SDK_DIR}/DeckLinkAPI.idl
        COMMENT "Generating DeckLink COM headers from IDL")
    add_executable(decklink_probe decklink_probe.cpp ${BMD_GEN_DIR}/DeckLinkAPI_h.h ${BMD_GEN_DIR}/DeckLinkAPI_i.c)
    target_include_directories(decklink_probe PRIVATE ${BMD_GEN_DIR} ${BMD_SDK_DIR} ${ADDON_SRC})
    target_compile_definitions(decklink_probe PRIVATE NOMINMAX _CRT_SECURE_NO_WARNINGS)
    target_link_libraries(decklink_probe ole32.lib oleaut32.lib comsuppw.lib)
elseif(APPLE)
    if(NOT DEFINED BMD_SDK_DIR)
        set(BMD_SDK_DIR "/Library/NDI SDK for Apple/examples/C++/NDIlib_Send_BMD/BMDSDK/Mac/include")  # same default as the addon
    endif()
    add_executable(decklink_probe decklink_probe.cpp "${BMD_SDK_DIR}/DeckLinkAPIDispatch.cpp")
    target_include_directories(decklink_probe PRIVATE "${BMD_SDK_DIR}" ${ADDON_SRC})
    target_link_libraries(decklink_probe "-framework CoreFoundation")
endif()

# ---- ndi_testsrc (optional: needs the NDI SDK) -------------------------------
if(NOT DEFINED NDI_SDK_DIR AND DEFINED ENV{NDI_SDK_DIR})
    file(TO_CMAKE_PATH "$ENV{NDI_SDK_DIR}" NDI_SDK_DIR)
endif()
if(APPLE AND NOT DEFINED NDI_SDK_DIR)
    set(NDI_SDK_DIR "/Library/NDI SDK for Apple")
endif()
if(WIN32 AND EXISTS "${NDI_SDK_DIR}/Include/Processing.NDI.Lib.h")
    add_executable(ndi_testsrc ndi_testsrc.cpp)
    target_include_directories(ndi_testsrc PRIVATE "${NDI_SDK_DIR}/Include")
    target_link_libraries(ndi_testsrc "${NDI_SDK_DIR}/Lib/x64/Processing.NDI.Lib.x64.lib")
    message(STATUS "ndi_testsrc: NDI SDK at ${NDI_SDK_DIR} (run with the NDI runtime folder on PATH)")
elseif(APPLE AND EXISTS "${NDI_SDK_DIR}/include/Processing.NDI.Lib.h")
    add_executable(ndi_testsrc ndi_testsrc.cpp)
    target_include_directories(ndi_testsrc PRIVATE "${NDI_SDK_DIR}/include")
    target_link_libraries(ndi_testsrc "${NDI_SDK_DIR}/lib/macOS/libndi.dylib")
    set_target_properties(ndi_testsrc PROPERTIES BUILD_RPATH "${NDI_SDK_DIR}/lib/macOS;/usr/local/lib")
    message(STATUS "ndi_testsrc: NDI SDK at ${NDI_SDK_DIR}")
else()
    message(STATUS "ndi_testsrc: NDI SDK not found, skipped (set NDI_SDK_DIR)")
endif()
