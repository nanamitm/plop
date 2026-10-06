const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return {promise, resolve};
}
async function readbackTest() {
    const scope = {GPUMapMode: {READ: 1}};
    vm.createContext(scope);
    vm.runInContext(fs.readFileSync(path.join(root, 'src/js/webgpu.js'), 'utf8') + ';globalThis.Renderer = WebGPURenderer;', scope);
    const renderer = Object.create(scope.Renderer.prototype), map = deferred();
    let unmapped = 0;
    const data = new Float32Array(75 * 75).fill(9);
    renderer.fluidReadback = {mapAsync: () => map.promise, getMappedRange: () => data.buffer, unmap: () => unmapped++};
    renderer.fluidSize = 75;
    renderer.fluidBindGroup = () => ({});
    renderer.device = {
        queue: {writeBuffer() {}, submit() {}},
        createCommandEncoder: () => ({
            beginComputePass: () => ({setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {}}),
            copyBufferToBuffer() {}, finish() {}
        })
    };
    const memory = new WebAssembly.Memory({initial: 1}), density = new Float32Array(memory.buffer, 0, 75 * 75);
    const pending = renderer.stepFluid(density, density, density);
    memory.grow(1);
    map.resolve();
    const result = await pending;
    assert.equal(result.length, 75 * 75);
    assert.equal(result[0], 9);
    assert.equal(unmapped, 1);
    assert.notEqual(result.buffer, data.buffer, 'readback returns owned memory');
    console.log('PASS GPU readback survives detached Wasm input views');
}
async function loopTest() {
    const {instance} = await WebAssembly.instantiate(fs.readFileSync(path.join(root, 'work/tests/sim.wasm')), {
        env: {log() {}, cos: Math.cos, sin: Math.sin, atan2: Math.atan2}
    });
    const e = instance.exports;
    e.setSizeWithFluid(75, 75, 1, 75);
    const canvas = {width: 75, height: 75}, maps = [];
    let presents = 0, resized = 0, mutation = 0, frames = 0;
    const renderer = {
        isWebGPU: true,
        resize() { resized++; },
        stepFluid(density) {
            assert.equal(density.length, 75 * 75, 'refresh views after tick grows memory');
            const map = deferred(); maps.push(map); return map.promise;
        },
        present(image, base, temperature) {
            assert.equal(image.length, canvas.width * canvas.height * 4);
            assert.equal(base.length, canvas.width * canvas.height);
            assert.equal(temperature.length, canvas.width * canvas.height);
            presents++;
        }
    };
    const scope = {
        document: {getElementById: () => canvas},
        window: {addEventListener() {}}, location: {search: '', hostname: 'localhost'},
        URLSearchParams, console, Uint32Array, Uint8ClampedArray, Float32Array,
        PaintTool: class {}, EraseTool: class {}, LineTool: class {}, WindTool: class {},
        EventHandler: class {tick() {}},
        requestAnimationFrame: () => frames++, frameExplosionPower: 0,
    };
    scope.window.Uint8ClampedArray = Uint8ClampedArray; scope.window.Uint32Array = Uint32Array; scope.window.Float32Array = Float32Array;
    vm.createContext(scope);
    let glue = fs.readFileSync(path.join(root, 'src/js/glue.js'), 'utf8');
    const startup = glue.indexOf('void async function main()');
    glue = glue.slice(0, startup) + glue.slice(glue.indexOf('async function loop()', startup));
    vm.runInContext(glue, scope);
    scope.testRenderer = renderer;
    scope.testWasm = {exports: {...e, tickGPUFluid: () => e.memory.grow(1)}};
    vm.runInContext('renderer = testRenderer; wasm = testWasm; refreshImageData();', scope);
    const first = vm.runInContext('loop()', scope);
    vm.runInContext('mutateSimulation(() => setSize(2))', scope);
    scope.testMutate = () => mutation++;
    vm.runInContext('mutateSimulation(testMutate)', scope);
    assert.equal(resized, 0, 'resize waits until GPU readback ends');
    assert.equal(mutation, 0);
    // A host-side memory grow while mapAsync is pending also detaches the old views.
    e.memory.grow(1);
    maps[0].resolve(new Float32Array(75 * 75).fill(8));
    await first;
    assert.equal(presents, 1); assert.equal(frames, 1);
    assert.equal(mutation, 0, 'actions remain queued through presentation');
    const second = vm.runInContext('loop()', scope);
    assert.equal(resized, 1); assert.equal(mutation, 1); assert.equal(canvas.width, 150);
    maps[1].resolve(new Float32Array(75 * 75).fill(7));
    await second;
    assert.equal(presents, 2); assert.equal(frames, 2);
    console.log('PASS frame loop refreshes grown memory and queues mutations/resizes through readback');
}
(async () => { await readbackTest(); await loopTest(); })().catch(error => {console.error(error); process.exitCode = 1;});
