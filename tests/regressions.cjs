const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const build = path.join(root, 'work', 'tests');
fs.mkdirSync(build, {recursive: true});
function sources(dir) {
    return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry =>
        entry.isDirectory() ? sources(path.join(dir, entry.name)) :
        entry.name.endsWith('.c') ? [path.join(dir, entry.name)] : []);
}
const sanitized = process.argv.includes('--sanitize');
const output = path.join(build, sanitized ? 'sim-null.wasm' : 'sim.wasm');
execFileSync('clang', ['-O3', '-ffast-math', '-DNDEBUG', '--target=wasm32',
    '--no-standard-libraries', '-Wno-switch', '-Wl,--no-entry', '-Wl,--export-dynamic',
    ...(sanitized ? ['-fsanitize=null', '-fsanitize-trap=null'] : []),
    '-o', output, ...sources(path.join(root, 'src', 'c')), path.join(__dirname, 'sim-fixtures.c')], {stdio: 'inherit'});
async function fresh(side = 75, fluid = 75) {
    const {instance} = await WebAssembly.instantiate(fs.readFileSync(output), {
        env: {log() {}, cos: Math.cos, sin: Math.sin, atan2: Math.atan2}
    });
    const e = instance.exports;
    e.seed(1, 2, 3, 4, 5, 6);
    e.setSizeWithFluid(side, side, 1, fluid);
    return e;
}
function types(e) {
    const d = new DataView(e.memory.buffer), bytes = new Uint8Array(e.memory.buffer);
    const list = ['VOID', 'EMPTY'];
    for(let p = e.enumToString.value, at; (at = d.getUint32(p, true)); p += 4) {
        let end = at;
        while(bytes[end]) end++;
        list.push(Buffer.from(bytes.subarray(at, end)).toString());
    }
    return Object.fromEntries(list.map((name, index) => [name, index]));
}
function saved(e) {
    const ptr = e.exportData();
    const header = new Uint32Array(e.memory.buffer, ptr, 6);
    const bytes = new Uint8Array(e.memory.buffer, ptr, header[5] + header[3] * header[4]).slice();
    e.free(ptr);
    return bytes;
}
function load(e, bytes) {
    const ptr = e.malloc(bytes.length || 1);
    new Uint8Array(e.memory.buffer, ptr, bytes.length).set(bytes);
    try { return e.importData(ptr, bytes.length); }
    finally { e.free(ptr); }
}
async function ioTests() {
    const e = await fresh(), t = types(e);
    e.applyPaint(37, 37, t.WOOD, 0);
    e.testElementState(37, 37, 0, 20, 0, true);
    const bytes = saved(e), offset = new DataView(bytes.buffer).getUint32(20, true);
    assert.equal(load(e, bytes), 1);
    assert.equal(e.testScorched(37, 37), 1, 'restore scorched state');
    const legacy = bytes.slice();
    legacy.set(Buffer.from('PLOP :]\0'));
    assert.equal(legacy[offset + 10] & 8, 8, 'fixture sets the scorched bit');
    assert.equal(load(e, legacy), 1, 'load legacy saves');
    assert.equal(e.testScorched(37, 37), 0, 'ignore uninitialised legacy scorched bit');
    assert.equal(load(e, bytes), 1);
    const mutations = [
        b => b.subarray(0, 8),
        b => b.subarray(0, b.length - 1),
        b => { new DataView(b.buffer).setUint32(16, 4, true); return b; },
        b => { new DataView(b.buffer).setUint32(20, offset + 1, true); return b; },
        b => { new DataView(b.buffer).setUint32(12, 0xffffffff, true); return b; },
        b => { new DataView(b.buffer).setUint32(offset, 100000000, true); return b; },
        b => { new DataView(b.buffer).setUint32(offset + 4, t.PHOTON, true); return b; },
        b => { new DataView(b.buffer).setFloat32(24, NaN, true); return b; },
        b => { new DataView(b.buffer).setFloat32(offset + 12, Infinity, true); return b; },
    ];
    for(const [index, mutate] of mutations.entries()) {
        assert.equal(load(e, mutate(bytes.slice())), 0, `reject malformed input ${index}`);
        assert.equal(e.getType(e.getCell(37, 37)), t.WOOD, 'invalid input preserves scene');
        assert.equal(e.testScorched(37, 37), 1);
    }
    const dup = new Uint8Array(bytes.length + 20);
    dup.set(bytes); dup.set(bytes.subarray(offset), bytes.length);
    new DataView(dup.buffer).setUint32(12, 2, true);
    assert.equal(load(e, dup), 0, 'reject duplicate coordinates');
    for(const name of ['PUMP', 'CLONER', 'DEBRIS', 'UNBREAKABLECLONER']) {
        const sim = await fresh();
        sim.applyPaint(37, 37, t[name], 0);
        assert.equal(load(sim, saved(sim)), 1, `round-trip ${name} with default state`);
    }
    for(const name of ['PUMP', 'DEBRIS']) {
        const sim = await fresh();
        sim.applyPaint(37, 37, t[name], 0);
        const invalid = saved(sim), d = new DataView(invalid.buffer), at = d.getUint32(20, true);
        invalid[at + 9] = t.PHOTON;
        assert.equal(load(sim, invalid), 0, `${name} cannot hold a cell-free particle`);
    }
    for(const [side, fluid] of [[75, 75], [600, 150], [1200, 300]]) {
        const sim = await fresh(side, fluid);
        assert.equal(load(sim, saved(sim)), 1);
        assert.equal(sim.getFluidSize(), fluid);
    }
    console.log('PASS saved-state validation, legacy/new fluid sizes, scorched round-trip');
}
async function simulationTests() {
    for(const moving of [0, 1]) {
        const e = await fresh();
        assert.equal(e.testLifetime(moving), 1, 'callbacks cannot mutate a reused element');
    }
    let e = await fresh(), t = types(e);
    e.applyPaint(37, 37, t.PUMP, 0);
    e.testElementState(37, 37, t.SAND, 2, 3, false);
    e.tick();
    const neighbors = [];
    for(let y = 36; y <= 38; y++) for(let x = 36; x <= 38; x++) {
        if(x !== 37 || y !== 37) neighbors.push(e.getType(e.getCell(x, y)));
    }
    assert.equal(neighbors.filter(type => type === t.SAND).length, 1);
    assert.equal(neighbors.filter(type => type === t.EMPTY).length, 7);
    // All particles leave the right edge together. Deleting the head must not skip its successor.
    e = await fresh();
    for(let i = 0; i < 10; i++) e.testParticle(74, 37, 255, 0);
    e.testParticleTick();
    assert.equal(e.getNSubatomics(), 0);
    e.testParticle(37, 37, 255, 0);
    e.changeScene(1);
    const initialMemory = e.memory.buffer.byteLength;
    for(let i = 0; i < 1000; i++) {
        e.testParticle(37, 37, 255, 0);
        e.changeScene(1);
    }
    assert.equal(e.getNSubatomics(), 0);
    assert.equal(e.memory.buffer.byteLength, initialMemory, 'reset reuses all particle allocations');
    console.log('PASS callback lifetimes, pump discharge, particle removal and reset reuse');
    for(const name of ['COPPER', 'WATER', 'PUMP', 'CONVEYER', 'FIREWORK', 'ELECTRON', 'PROTON', 'PHOTON', 'LIGHTNING', 'CLONER']) {
        const sim = await fresh();
        sim.applyPaint(0, 0, t[name], 0);
        if(name === 'CLONER') sim.testElementState(0, 0, t.SAND, 0, 0, false);
        for(let i = 0; i < 10; i++) sim.tick();
    }
    e = await fresh();
    e.applyPaint(37, 37, t.ACID, 0); e.applyPaint(37, 38, t.WOOD, 0);
    for(let i = 0; i < 10; i++) e.tick();
    console.log('PASS empty/boundary conductivity, nuclear particles, lightning, cloner and acid');
}
async function renderingTests() {
    for(const wavelength of [0, 1, 2, 3, 4, 5, 6, 254, 255]) {
        for(const temperature of [-10, 5, 600]) {
            const e = await fresh();
            e.testTemperature(37, 37, temperature);
            e.testParticle(37, 37, wavelength, 0);
            e.draw(); e.prepareGPUFrame();
            const d = new DataView(e.memory.buffer), offset = (37 * 75 + 37) * 4;
            const cpu = d.getUint32(d.getUint32(e.imageData.value, true) + offset, true) & 0xffffff;
            const base = d.getUint32(d.getUint32(e.renderBaseData.value, true) + offset, true);
            // Compare the actual CPU pixel with the GPU's packed particle overlay.
            if(wavelength >= 254) {
                assert.equal(base & 0xffffff, cpu);
                assert.ok(base & 0x01000000, 'replacement particles bypass heat');
            } else {
                assert.equal(base & 0x01000000, 0);
                assert.equal((base & cpu), base, 'photon RGB is present in both render paths');
                assert.notEqual(base, 0);
            }
        }
    }
    console.log('PASS CPU/GPU particle colours at cold, ambient and hot temperatures');
}
(async () => { await ioTests(); await simulationTests(); await renderingTests(); })().catch(error => { console.error(error); process.exitCode = 1; });
