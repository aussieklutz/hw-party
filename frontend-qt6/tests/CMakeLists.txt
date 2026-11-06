# The party host rules (PartyHostCore, PartyLayout) have no UI and no network in
# them, so whole games can be played through them with fake phones and a fake
# engine. Added from the top level after enable_testing().
find_package(Qt6 6.4 REQUIRED COMPONENTS Core)

set(CMAKE_AUTOMOC ON)

qt_add_executable(party_host_core_test
    party_host_core_test.cpp
    ../partyhostcore.cpp
    ../partyhostcore.h
    ../partylayout.cpp
    ../partylayout.h
)

target_include_directories(party_host_core_test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/..)
target_link_libraries(party_host_core_test PRIVATE Qt::Core)

add_test(NAME party_host_core COMMAND party_host_core_test)
