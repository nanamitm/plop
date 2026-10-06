const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const build = path.join(root, 'build', 'tests');
fs.mkdirSync(build, {recursive: true});
function sources(dir) {
    return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry =>
        entry.isDirectory() ? sources(path.join(dir, entry.name)) :
        entry.name.endsWith('.c') ? [path.join(dir, entry.name)] : []);
}
const output = path.join(build, 'sim.wasm');
execFileSync('clang', ['-O3', '-ffast-math', '-DNDEBUG', '--target=wasm32',
    '--no-standard-libraries', '-Wno-switch', '-Wl,--no-entry', '-Wl,--export-dynamic',
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
}
(async () => { await ioTests(); await simulationTests(); })().catch(error => { console.error(error); process.exitCode = 1; });
