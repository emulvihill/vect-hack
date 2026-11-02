# Emscripten build for pinned Umoria 5.7.15. The guarded wrapper
# (build-moria-wasm.sh) invokes this file from the VectHack root.
#
# Every upstream C++ translation unit is compiled out-of-tree except main.cpp
# and ui_io.cpp. VectHack owns those two executable/platform seams so the
# official external/umoria checkout remains pristine and curses never enters
# the WebAssembly link.

MORIA_SOURCE ?= $(VECT_ROOT)/external/umoria
NATIVE := $(VECT_ROOT)/src/modules/moria/native
OUT := $(VECT_ROOT)/build/moria
SEED := $(OUT)/seed

CXX := em++

# Emscripten defines __unix__ but Umoria's pinned platform switch recognizes
# __linux__. The two excluded platform translation units own every unsupported
# Linux operation (curses, select, login/passwd and set-id calls); the remaining
# source uses only the POSIX headers and file APIs Emscripten provides.
CPPFLAGS := -D__linux__ -I$(MORIA_SOURCE)/src
# -ffile-prefix-map rewrites __FILE__ (helpers.cpp's asserts reach the wasm) to a
# relative path, for the checkout and for a --source-dir outside it;
# build-moria-wasm.sh refuses any artifact that still names the build machine
# (guard-host-paths.sh, vect-hack-uur5).
CXXFLAGS := -std=c++14 -O2 -w -ffile-prefix-map=$(VECT_ROOT)=. \
  -ffile-prefix-map=$(MORIA_SOURCE)=external/umoria

LDFLAGS := -O2 --no-entry \
  -s ENVIRONMENT=worker,node -s EXPORT_ES6=1 -s MODULARIZE=1 \
  -s 'EXPORT_NAME="createMoriaModule"' \
  -s ASYNCIFY=1 -s ASYNCIFY_ADVISE=1 -s ALLOW_MEMORY_GROWTH=1 \
  -Wl,--wrap=exit \
  -lidbfs.js \
  -s 'EXPORTED_FUNCTIONS=["_moria_start","_moria_describe"]' \
  -s 'EXPORTED_RUNTIME_METHODS=["FS","ccall","UTF8ToString"]'

UPSTREAM_SRCS := $(filter-out \
  $(MORIA_SOURCE)/src/main.cpp \
  $(MORIA_SOURCE)/src/game_save.cpp \
  $(MORIA_SOURCE)/src/ui_io.cpp, \
  $(wildcard $(MORIA_SOURCE)/src/*.cpp))
UPSTREAM_OBJS := $(patsubst $(MORIA_SOURCE)/src/%.cpp,$(OUT)/obj/upstream/%.o,$(UPSTREAM_SRCS))
NATIVE_SRCS := $(NATIVE)/main-wasm.cpp $(NATIVE)/ui_io_wasm.cpp $(NATIVE)/semantic-wasm.cpp \
  $(NATIVE)/game-save-wasm.cpp $(NATIVE)/checkpoint-wasm.cpp
NATIVE_OBJS := $(patsubst $(NATIVE)/%.cpp,$(OUT)/obj/native/%.o,$(NATIVE_SRCS))
OBJS := $(UPSTREAM_OBJS) $(NATIVE_OBJS)

.PHONY: all
all: $(OUT)/moria.js

# Linked from $(OUT) with relative -o and --preload-file: Emscripten bakes the
# output path into the glue as the .data package name.
$(OUT)/moria.js: $(OBJS)
	cd $(OUT) && $(CXX) $(CXXFLAGS) $(LDFLAGS) \
	  --preload-file seed@/moria-seed -o moria.js $(OBJS)

$(OUT)/obj/upstream/%.o: $(MORIA_SOURCE)/src/%.cpp
	mkdir -p $(@D)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -o $@ -c $<

# Pin command context to the only three direct reads in game_run.cpp. The two
# row-zero count reads stay literal at runtime; the hero-cursor read is outer.
$(OUT)/obj/upstream/game_run.o: $(MORIA_SOURCE)/src/game_run.cpp
	mkdir -p $(@D)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -DgetKeyInput=vectMoriaGameRunKeyInput -DshowScoresScreen=vectMoriaShowScoresScreen -DdisplayTextHelpFile=vectMoriaDisplayTextHelpFile -DdungeonDisplayMap=vectMoriaDungeonDisplayMap -DupdateMonsters=vectMoriaGameRunUpdateMonsters -DloadGame=vectMoriaCheckpointLoadGame -DchangeCharacterName=vectMoriaCheckpointChangeCharacterName -o $@ -c $<

# Both linked score displays use the same source-owned overlay marker. The
# game_run call nests inside terminalSaveScreen; the death path does not.
$(OUT)/obj/upstream/game_death.o: $(MORIA_SOURCE)/src/game_death.cpp
	mkdir -p $(@D)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -DshowScoresScreen=vectMoriaShowScoresScreen -o $@ -c $<

# Character creation uses the same file viewer for its welcome/help screens.
$(OUT)/obj/upstream/character.o: $(MORIA_SOURCE)/src/character.cpp
	mkdir -p $(@D)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -DdisplayTextHelpFile=vectMoriaDisplayTextHelpFile -o $@ -c $<

# Store screens do not use terminalSaveScreen(). The first blocking command
# read opens the semantic scope and the one exit cave redraw closes it, keeping
# purchase, sell, haggle and nested inventory prompts inside the store overlay.
$(OUT)/obj/upstream/store.o: $(MORIA_SOURCE)/src/store.cpp
	mkdir -p $(@D)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -DgetCommand=vectMoriaStoreGetCommand -DdrawCavePanel=vectMoriaStoreDrawCavePanel -o $@ -c $<

$(OUT)/obj/native/%.o: $(NATIVE)/%.cpp
	mkdir -p $(@D)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -o $@ -c $<
