cmake_minimum_required(VERSION 3.15)
project(decklink_addon)

# cmake-js populates these
include_directories(${CMAKE_JS_INC})

# Node-addon-api headers
execute_process(
    COMMAND node -p "require('path').resolve(require('node-addon-api').include_dir)"
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}/../..
    OUTPUT_VARIABLE NAPI_INCLUDE_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
include_directories("${NAPI_INCLUDE_DIR}")

# Define NAPI_VERSION for node-addon-api
add_definitions(-DNAPI_VERSION=8)
add_definitions(-DNAPI_DISABLE_CPP_EXCEPTIONS)

set(COMMON_SOURCES
    src/addon.cpp
    src/device_manager.cpp
    src/output_handler.cpp
    src/input_handler.cpp
    src/passthrough.cpp
    src/vanc_packet.cpp
)

if(APPLE)
    # ---- macOS build ----
    # DeckLink SDK headers (bundled with NDI SDK on this dev machine, or override
    # by setting BMD_SDK_DIR before cmake)
    if(NOT DEFINED BMD_SDK_DIR)
        set(BMD_SDK_DIR "/Library/NDI SDK for Apple/examples/C++/NDIlib_Send_BMD/BMDSDK/Mac/include")
    endif()
    include_directories(${BMD_SDK_DIR})

    # DeckLink framework (system-installed by Desktop Video)
    find_library(DECKLINK_FRAMEWORK DeckLinkAPI PATHS /Library/Frameworks)

    add_library(${PROJECT_NAME} SHARED
        ${COMMON_SOURCES}
        ${BMD_SDK_DIR}/DeckLinkAPIDispatch.cpp
    )

    target_link_libraries(${PROJECT_NAME}
        ${CMAKE_JS_LIB}
        ${DECKLINK_FRAMEWORK}
        "-framework CoreFoundation"
    )

elseif(WIN32)
    # ---- Windows build ----
    # BMD_SDK_DIR must point at the unpacked DeckLink SDK's Win/include directory.
    # CI workflow downloads this from the BMD_SDK_URL secret and unpacks it under
    # the runner's workspace, then sets BMD_SDK_DIR via -DBMD_SDK_DIR=...
    if(NOT DEFINED BMD_SDK_DIR)
        message(FATAL_ERROR "BMD_SDK_DIR must be set on Windows. Pass -DBMD_SDK_DIR=<path-to-DeckLinkSDK/Win/include>")
    endif()
    include_directories(${BMD_SDK_DIR})

    # Generate DeckLinkAPI_h.h + DeckLinkAPI_i.c from the IDL via MIDL.
    # The DeckLink SDK ships DeckLinkAPI.idl in Win/include/.
    set(BMD_IDL "${BMD_SDK_DIR}/DeckLinkAPI.idl")
    set(BMD_GEN_DIR "${CMAKE_BINARY_DIR}/bmd_gen")
    file(MAKE_DIRECTORY ${BMD_GEN_DIR})
    set(BMD_HEADER "${BMD_GEN_DIR}/DeckLinkAPI_h.h")
    set(BMD_IID    "${BMD_GEN_DIR}/DeckLinkAPI_i.c")

    add_custom_command(
        OUTPUT ${BMD_HEADER} ${BMD_IID}
        COMMAND midl /nologo /win64 /h DeckLinkAPI_h.h /iid DeckLinkAPI_i.c /out ${BMD_GEN_DIR} ${BMD_IDL}
        DEPENDS ${BMD_IDL}
        COMMENT "Generating DeckLink COM headers from IDL"
    )

    include_directories(${BMD_GEN_DIR})

    # CMAKE_JS_SRC = win_delay_load_hook.cc — required so that delay-loaded
    # NODE.EXE symbols resolve against the host binary when the addon is loaded
    # inside a pkg-bundled executable (where the host is CommunityCaptioner.exe,
    # not node.exe). Without this hook, the addon segfaults on require() inside
    # the standalone build.
    add_library(${PROJECT_NAME} SHARED
        ${COMMON_SOURCES}
        ${BMD_HEADER}
        ${BMD_IID}
        ${CMAKE_JS_SRC}
    )

    target_link_libraries(${PROJECT_NAME}
        ${CMAKE_JS_LIB}
        comsuppw.lib
        ole32.lib
        oleaut32.lib
    )

    target_compile_definitions(${PROJECT_NAME} PRIVATE NOMINMAX)
endif()

set_target_properties(${PROJECT_NAME} PROPERTIES
    PREFIX ""
    SUFFIX ".node"
    CXX_STANDARD 17
)
