#include "main.h"
#include "fluidsim.h"
#include "elements/elements.h"
#include "elements/subatomics.h"
#include "api.h"
#include "walloc.h"
#include "random.h"

export F32 getTemp(U16 x, U16 y) {
    return cells[y * width + x].temperature;
}

export void fluidVelocity(U16 x, U16 y, F32 vx, F32 vy) {
    Cell *target = getCell(x, y);
    if(target) {
        fluid.vx[target->fluidInd] += vx;
        fluid.vy[target->fluidInd] += vy;
    }
}

export U32 getNSubatomics(void) {
    return nSubatomics;
}

export void applyPaint(U16 mx, U16 my, ElementType type, U8 areaOfEffect) {
    if((type == PHOTON || type == ELECTRON || type == PROTON) && nSubatomics >= MAX_SUBATOMICS) return;

    for(I16 y = -areaOfEffect; y <= areaOfEffect; ++y) {
        I32 py = my + y;
        if(py < 0) continue;
        else if(py >= height) break;

        for(I16 x = -areaOfEffect; x <= areaOfEffect; ++x) {
            I32 px = mx + x;
            if(px < 0) continue;
            else if(px >= width) break;

            if(areaOfEffect > 3 && y * y + x * x >= areaOfEffect * areaOfEffect) continue;

            Cell *target = getCell(px, py);
            if(getType(target) == EMPTY) {
                spawnElement(target, type);
                if(type == ICE) fluid.density[target->fluidInd] = -5.0f;
                else if(type == SNOW) fluid.density[target->fluidInd] = -2.8f;
            }
        }
    }
}

export void eraseArea(U16 mx, U16 my, U8 areaOfEffect) {
    for(I16 y = -areaOfEffect; y <= areaOfEffect; ++y) {
        I32 py = my + y;
        if(py < 0) continue;
        else if(py >= height) break;

        for(I16 x = -areaOfEffect; x <= areaOfEffect; ++x) {
            I32 px = mx + x;
            if(px < 0) continue;
            else if(px >= width) break;

            if(areaOfEffect > 3 && y * y + x * x >= areaOfEffect * areaOfEffect) continue;

            Cell *target = getCell(px, py);
            if(getType(target) > EMPTY) freeCell(target);
        }
    }
}

const char *magic = "PLOP :]";

export IOCanvas* exportData(void) {
    U32 len = width * height;
    U32 nonEmptyCells = 0;
    for(U32 i = 0; i < len; ++i) {
        if(cells[i].el) nonEmptyCells += 1;
    }

    U32 fluidCount = fluid.size * fluid.size;
    U32 cellStart = sizeof(IOCanvas) + fluidCount * sizeof(F32) * 3;
    IOCanvas *canvas = malloc(cellStart + nonEmptyCells * sizeof(IOCell));
    memcpy(canvas->magic, magic, 8);
    canvas->size = width / 75;
    canvas->cellLength = nonEmptyCells;
    canvas->cellSize = sizeof(IOCell);
    canvas->cellArrStart = cellStart;
    F32 *fvx = (F32 *)((U8 *)canvas + sizeof(IOCanvas));
    F32 *fvy = fvx + fluidCount;
    F32 *tmp = fvy + fluidCount;
    IOCell *ioCells = (IOCell *)((U8 *)canvas + cellStart);

    U32 i = len;
    U32 ci = 0;
    while(i --> 0) {
        if(cells[i].el && cells[i].el->type > EMPTY) {
            ioCells[ci].index = i;
            ioCells[ci].el.type =               cells[i].el->type;
            ioCells[ci].el.rv =                 cells[i].el->rv;
            ioCells[ci].el.r0 =                 cells[i].el->r0;
            ioCells[ci].el.color =              cells[i].el->color;
            ioCells[ci].el.halted =             cells[i].el->halted;
            ioCells[ci].el.electricityState =   cells[i].el->electricityState;
            ioCells[ci].el.sbpx =               cells[i].el->sbpx;
            ioCells[ci].el.sbpy =               cells[i].el->sbpy;
            ci += 1;
        }
    }

    U32 fi = fluidCount;
    while(fi --> 0) {
        fvx[fi] = fluid.vx[fi];
        fvy[fi] = fluid.vy[fi];
        tmp[fi] = fluid.density[fi];
    }

    return canvas;
}

export _Bool importData(IOCanvas *canvas) {
    if(canvas->size == 0 || canvas->size > 20) return 0;
    for(U8 i = 0; i < 8; ++i) {
        if(magic[i] != canvas->magic[i]) return 0;
    }
    if(canvas->cellArrStart < sizeof(IOCanvas)) return 0;
    U32 fluidCount = (canvas->cellArrStart - sizeof(IOCanvas)) / (sizeof(F32) * 3);
    U16 fluidSize = fluidCount == 75 * 75 ? 75 : fluidCount == 150 * 150 ? 150 : fluidCount == 300 * 300 ? 300 : 0;
    if(!fluidSize) return 0;
    F32 *fvx = (F32 *)((U8 *)canvas + sizeof(IOCanvas));
    F32 *fvy = fvx + fluidCount;
    F32 *tmp = fvy + fluidCount;
    IOCell *ioCells = (IOCell *)((U8 *)canvas + canvas->cellArrStart);
    for(U32 i = 0; i < canvas->cellLength; ++i) {
        if(ioCells[i].el.type >= type_length) {
            return 0;
        } 
    }

    setSizeWithFluid(canvas->size * 75, canvas->size * 75, 1, fluidSize);

    for(U32 i = 0; i < canvas->cellLength; ++i) {
        U32 ti = ioCells[i].index;
        spawnElement(&cells[ti], ioCells[i].el.type);
        cells[ti].el->rv =               ioCells[i].el.rv;
        cells[ti].el->r0 =               ioCells[i].el.r0;
        cells[ti].el->color =            ioCells[i].el.color;
        cells[ti].el->halted =           ioCells[i].el.halted;
        cells[ti].el->electricityState = ioCells[i].el.electricityState;
        cells[ti].el->sbpx =             ioCells[i].el.sbpx;
        cells[ti].el->sbpy =             ioCells[i].el.sbpy;
    }

    U32 fi = fluidCount;
    while(fi --> 0) {
        fluid.vx[fi] =      fvx[fi];
        fluid.vy[fi] =      fvy[fi];
        fluid.density[fi] = tmp[fi];
    }

    return 1;
}
