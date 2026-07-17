#ifndef FLUIDSIM_H
#define FLUIDSIM_H

#define ITER 16
#define IX(x, y) (MAX(MIN(x, fluid.size - 1), 0) + (MAX(MIN(y, fluid.size - 1), 0) * fluid.size))

typedef struct FluidSim {
    F32 dt;
    F32 diff;
    F32 visc;
    U16 size;
    F32 *s;
    F32 *density;
    F32 *vx;
    F32 *vy;
    F32 *vx0;
    F32 *vy0;
} FluidSim;

FluidSim *initFluid(F32 diffusion, F32 viscosity, F32 dt);
void stepFluid(void);
void stepFluidVelocity(void);
void configureFluid(U16 size);

extern F32 FSCALE;
extern FluidSim fluid;

#endif
