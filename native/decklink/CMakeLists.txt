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

    # DeckLink framework (system-installed by Desktop Video). Linking it is
    # optional: DeckLinkAPIDispatch.cpp loads /Library/Frameworks/DeckLinkAPI.framework
    # at runtime via CFBundle, so CI machines without Desktop Video can still
    # build the addon from the SDK headers alone (BMD_LINK_FRAMEWORK=OFF).
    option(BMD_LINK_FRAMEWORK "Link DeckLinkAPI.framework directly (requires Desktop Video installed)" ON)
    set(DECKLINK_LINK "")
    if(BMD_LINK_FRAMEWORK)
        find_library(DECKLINK_FRAMEWORK DeckLinkAPI PATHS /Library/Frameworks)
        if(DECKLINK_FRAMEWORK)
            set(DECKLINK_LINK ${DECKLINK_FRAMEWORK})
        else()
            message(STATUS "DeckLinkAPI.framework not found — relying on DeckLinkAPIDispatch.cpp to load it at runtime")
        endif()
    endif()

    # NDI → SDI passthrough (optional). Needs the NDI SDK for Apple at build time
    # (-DNDI_SDK_DIR=…, $NDI_SDK_DIR, or the default install location). The
    # dylib is linked WEAKLY: the addon still loads with the six SDI functions on
    # a Mac without libndi.dylib, and NdiPassthroughHandler::RuntimeAvailable()
    # checks at module init whether the weak import actually resolved.
    if(NOT DEFINED NDI_SDK_DIR AND DEFINED ENV{NDI_SDK_DIR})
        set(NDI_SDK_DIR "$ENV{NDI_SDK_DIR}")
    endif()
    if(NOT DEFINED NDI_SDK_DIR)
        set(NDI_SDK_DIR "/Library/NDI SDK for Apple")
    endif()
    set(NDI_SOURCES "")
    if(EXISTS "${NDI_SDK_DIR}/include/Processing.NDI.Lib.h" AND EXISTS "${NDI_SDK_DIR}/lib/macOS/libndi.dylib")
        message(STATUS "NDI SDK: ${NDI_SDK_DIR} (building NDI passthrough, weak-linked libndi.dylib)")
        set(NDI_SOURCES src/ndi_passthrough.cpp)
    else()
        message(STATUS "NDI SDK not found at ${NDI_SDK_DIR}: building without NDI passthrough (set NDI_SDK_DIR to enable)")
    endif()

    add_library(${PROJECT_NAME} SHARED
        ${COMMON_SOURCES}
        ${NDI_SOURCES}
        ${BMD_SDK_DIR}/DeckLinkAPIDispatch.cpp
    )

    target_link_libraries(${PROJECT_NAME}
        ${CMAKE_JS_LIB}
        ${DECKLINK_LINK}
        "-framework CoreFoundation"
    )

    if(NDI_SOURCES)
        target_include_directories(${PROJECT_NAME} PRIVATE "${NDI_SDK_DIR}/include")
        target_compile_definitions(${PROJECT_NAME} PRIVATE HAVE_NDI)
        # Weak link: unresolved NDIlib_* symbols become NULL instead of failing
        # require(). The LINKER: form keeps the path (which contains spaces) intact.
        target_link_options(${PROJECT_NAME} PRIVATE "LINKER:-weak_library,${NDI_SDK_DIR}/lib/macOS/libndi.dylib")
        # Where the dylib is looked for at load time (install name @rpath/libndi.dylib):
        #   a copy bundled in the app (Contents/Frameworks), next to the addon (dev/test),
        #   NDI Tools for Mac (/usr/local/lib), then the SDK itself.
        set_target_properties(${PROJECT_NAME} PROPERTIES
            BUILD_RPATH "@loader_path/../Frameworks;@loader_path;/usr/local/lib;${NDI_SDK_DIR}/lib/macOS"
            INSTALL_RPATH "@loader_path/../Frameworks;@loader_path;/usr/local/lib;${NDI_SDK_DIR}/lib/macOS"
            BUILD_WITH_INSTALL_RPATH TRUE
        )
    endif()

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

    # NDI → SDI passthrough (optional). Needs the NDI SDK at build time (the
    # installer sets NDI_SDK_DIR, e.g. C:/Program Files/NDI/NDI 6 SDK). The
    # runtime DLL is delay-loaded and found through NDI_RUNTIME_DIR_V6 (NDI Tools
    # / NDI Runtime), so the addon still loads, SDI included, on a PC without NDI.
    if(NOT DEFINED NDI_SDK_DIR AND DEFINED ENV{NDI_SDK_DIR})
        file(TO_CMAKE_PATH "$ENV{NDI_SDK_DIR}" NDI_SDK_DIR)
    endif()
    set(NDI_SOURCES "")
    if(NDI_SDK_DIR AND EXISTS "${NDI_SDK_DIR}/Include/Processing.NDI.Lib.h")
        message(STATUS "NDI SDK: ${NDI_SDK_DIR} (building NDI passthrough)")
        set(NDI_SOURCES src/ndi_passthrough.cpp)
    else()
        message(STATUS "NDI SDK not found: building without NDI passthrough (set NDI_SDK_DIR to enable)")
    endif()

    # CMAKE_JS_SRC = win_delay_load_hook.cc — required so that delay-loaded
    # NODE.EXE symbols resolve against the host binary when the addon is loaded
    # inside a pkg-bundled executable (where the host is CommunityCaptioner.exe,
    # not node.exe). Without this hook, the addon segfaults on require() inside
    # the standalone build.
    add_library(${PROJECT_NAME} SHARED
        ${COMMON_SOURCES}
        ${NDI_SOURCES}
        src/wasapi_capture.cpp
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

    if(NDI_SOURCES)
        target_include_directories(${PROJECT_NAME} PRIVATE "${NDI_SDK_DIR}/Include")
        target_link_libraries(${PROJECT_NAME} "${NDI_SDK_DIR}/Lib/x64/Processing.NDI.Lib.x64.lib" delayimp.lib)
        target_link_options(${PROJECT_NAME} PRIVATE "/DELAYLOAD:Processing.NDI.Lib.x64.dll")
        target_compile_definitions(${PROJECT_NAME} PRIVATE HAVE_NDI)
    endif()
endif()

set_target_properties(${PROJECT_NAME} PROPERTIES
    PREFIX ""
    SUFFIX ".node"
    CXX_STANDARD 17
)
