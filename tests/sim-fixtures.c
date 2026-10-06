#include "../src/c/main.h"
#include "../src/c/elements/elements.h"
#include "../src/c/elements/subatomics.h"
#include "../src/c/fluidsim.h"

export void testElementState(U16 x, U16 y, U8 r0, U8 rv, U8 electricity, _Bool scorched) {
    Element *el = getCell(x, y)->el;
    el->r0 = r0;
    el->rv = rv;
    el->electricityState = electricity;
    el->scorched = scorched;
    el->tick = g_tick;
}

export _Bool testScorched(U16 x, U16 y) { return getCell(x, y)->el->scorched; }
export F32 testSubpixelY(U16 x, U16 y) { return getCell(x, y)->el->sbpy; }
export U32 testSubatomicBytes(void) { return sizeof(Subatomic); }
