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

# DeckLink SDK headers
set(BMD_SDK_DIR "/Library/NDI SDK for Apple/examples/C++/NDIlib_Send_BMD/BMDSDK/Mac/include")
include_directories(${BMD_SDK_DIR})

# DeckLink framework
find_library(DECKLINK_FRAMEWORK DeckLinkAPI PATHS /Library/Frameworks)

# Node headers (cmake-js provides these)
include_directories(${CMAKE_JS_INC})

add_library(${PROJECT_NAME} SHARED
    src/addon.cpp
    src/device_manager.cpp
    src/output_handler.cpp
    src/input_handler.cpp
    src/passthrough.cpp
    src/vanc_packet.cpp
    ${BMD_SDK_DIR}/DeckLinkAPIDispatch.cpp
)

target_link_libraries(${PROJECT_NAME}
    ${CMAKE_JS_LIB}
    ${DECKLINK_FRAMEWORK}
    "-framework CoreFoundation"
)

set_target_properties(${PROJECT_NAME} PROPERTIES
    PREFIX ""
    SUFFIX ".node"
    CXX_STANDARD 17
)
