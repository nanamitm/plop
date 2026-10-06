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
export void testTemperature(U16 x, U16 y, F32 value) { getCell(x, y)->temperature = value; }

static void replaceDuringUpdate(Element *el, Cell *cell, U16 x, U16 y) {
    freeCell(cell);
    spawnElement(getCell(x + 1, y), STONE);
}

static _Bool replaceDuringMove(Element *el, Cell *cell, Cell *target) {
    freeCell(cell);
    spawnElement(cell, STONE);
    return 1;
}

export _Bool testLifetime(_Bool duringMove) {
    extern void tick(void);
    Cell *cell = getCell(37, 37);
    spawnElement(cell, SAND);
    cell->el->tick = g_tick;
    ElementInfo original = elementLookup[SAND];
    if(duringMove) {
        elementLookup[SAND].attempt = replaceDuringMove;
        cell->el->sbpx = 2;
    } else elementLookup[SAND].handler = replaceDuringUpdate;
    tick();
    elementLookup[SAND] = original;
    Cell *replacement = duringMove ? cell : getCell(38, 37);
    return getType(replacement) == STONE && replacement->el->sbpy == 0 &&
           replacement->el->sbpx == 0 && !updatingElement;
}

export void testParticle(U16 x, U16 y, U8 wavelength, U8 angle) {
    createSubatomicHelper(x, y, wavelength, angle);
}
export void testParticleTick(void) { tickSubatomics(); }
