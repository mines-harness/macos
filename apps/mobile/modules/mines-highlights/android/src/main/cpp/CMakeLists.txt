cmake_minimum_required(VERSION 3.22.1)

project(mineshighlights LANGUAGES C)

set(MINES_HIGHLIGHTS_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../..")

add_library(
  mineshighlights SHARED
  mines_highlights_jni.c
  "${MINES_HIGHLIGHTS_ROOT}/cpp/mines_highlights.c"
  "${MINES_HIGHLIGHTS_ROOT}/Vendor/highlights/highlights.c"
  "${MINES_HIGHLIGHTS_ROOT}/Vendor/wasm2c/wasm-rt-impl.c"
  "${MINES_HIGHLIGHTS_ROOT}/Vendor/wasm2c/wasm-rt-mem-impl.c"
)

target_include_directories(
  mineshighlights
  PRIVATE "${MINES_HIGHLIGHTS_ROOT}/cpp" "${MINES_HIGHLIGHTS_ROOT}/Vendor"
          "${MINES_HIGHLIGHTS_ROOT}/Vendor/highlights" "${MINES_HIGHLIGHTS_ROOT}/Vendor/wasm2c"
)

# Plain malloc memory with explicit bounds checks: no guard-page signal
# handlers competing with ART's.
target_compile_definitions(
  mineshighlights PRIVATE WASM_RT_USE_MMAP=0 WASM_RT_MEMCHECK_BOUNDS_CHECK=1
                       WASM_RT_SKIP_SIGNAL_RECOVERY=1
)

# The lexers are generated code; keep them fast in debug builds too.
target_compile_options(mineshighlights PRIVATE -O2)

target_link_options(
  mineshighlights PRIVATE "-Wl,-z,common-page-size=16384" "-Wl,-z,max-page-size=16384"
)
