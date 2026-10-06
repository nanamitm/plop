// Optional integration check: build first, then set PLOP_BROWSER to a Chromium executable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const executable = process.env.PLOP_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
assert.ok(fs.existsSync(executable), 'Set PLOP_BROWSER to a Chromium executable');
const server = http.createServer((request, response) => {
    const name = new URL(request.url, 'http://localhost').pathname;
    const file = path.resolve(root, 'build', '.' + (name === '/' ? '/index.html' : name));
    if(!file.startsWith(path.join(root, 'build') + path.sep) || !fs.existsSync(file)) {
        response.writeHead(404); response.end(); return;
    }
    response.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' :
        file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    fs.createReadStream(file).pipe(response);
});
let browser, socket;
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const profile = path.join(root, 'work', 'browser-smoke', String(Date.now()));
    browser = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check',
        '--enable-unsafe-webgpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
        {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
    const endpoint = await new Promise((resolve, reject) => {
        let output = '';
        const timeout = setTimeout(() => reject(new Error('Chromium startup timed out')), 20000);
        browser.on('error', reject);
        browser.stderr.on('data', chunk => {
            output += chunk;
            const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
            if(match) {clearTimeout(timeout); resolve(match[1]);}
        });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {socket.onopen = resolve; socket.onerror = reject;});
    let sequence = 0;
    const waiting = new Map(), exceptions = [];
    socket.onmessage = event => {
        const data = JSON.parse(event.data);
        if(data.id) {
            const pending = waiting.get(data.id);
            if(!pending) return;
            clearTimeout(pending.timeout); waiting.delete(data.id);
            if(data.error) pending.reject(new Error(data.error.message)); else pending.resolve(data.result);
        } else if(data.method === 'Runtime.exceptionThrown') exceptions.push(data.params.exceptionDetails.text);
    };
    function send(method, params = {}, sessionId) {
        return new Promise((resolve, reject) => {
            const id = ++sequence;
            const timeout = setTimeout(() => {waiting.delete(id); reject(new Error(`${method} timed out`));}, 30000);
            waiting.set(id, {resolve, reject, timeout});
            socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
        });
    }
    const {targetId} = await send('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await send('Target.attachToTarget', {targetId, flatten: true});
    await send('Runtime.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    async function evaluate(expression) {
        const response = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, sessionId);
        if(response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
        return response.result.value;
    }
    const url = `http://127.0.0.1:${server.address().port}/?profile=1`;
    await send('Page.navigate', {url}, sessionId);
    await evaluate(`new Promise((resolve, reject) => {
        const start = Date.now();
        const timer = setInterval(() => {
            if(window.plopRenderer && typeof imageData !== 'undefined' && imageData) {clearInterval(timer); resolve(true);}
            else if(Date.now() - start > 15000) {clearInterval(timer); reject(new Error('startup timed out'));}
        }, 20);
    })`);
    const renderer = await evaluate('window.plopRenderer');
    assert.equal(renderer, 'webgpu', 'integration check requires a WebGPU adapter');
    await evaluate(`window.testGPUFailures = []; window.testFrames = 0;
        renderer.device.addEventListener('uncapturederror', event => testGPUFailures.push(event.error.message));
        const originalPresent = renderer.present.bind(renderer);
        renderer.present = (...args) => {testFrames++; return originalPresent(...args);};
        window.waitUntil = predicate => new Promise((resolve, reject) => {
            const start = Date.now(); const timer = setInterval(() => {
                if(predicate()) {clearInterval(timer); resolve(true);}
                else if(Date.now() - start > 10000) {clearInterval(timer); reject(new Error('frame stalled'));}
            }, 20);
        });`);
    for(const size of [1, 8, 4]) {
        await evaluate(`requestCanvasResize(${size}); waitUntil(() => canvas.width === ${size * 75})`);
        await evaluate(`(async () => {callSimulationExport('applyPaint', 37, 37, lookup.PHOTON.id, 0);
            callSimulationExport('applyPaint', 45, 37, lookup.ELECTRON.id, 0);
            callSimulationExport('applyPaint', 53, 37, lookup.PROTON.id, 0);
            const baseline = testFrames; await waitUntil(() => testFrames >= baseline + 4);})()`);
        await evaluate(`(async () => {mutateSimulation(() => {const bytes = exportData(); if(!importData(bytes)) throw new Error('round-trip failed');});
            const baseline = testFrames; await waitUntil(() => testFrames >= baseline + 4);})()`);
    }
    await evaluate(`(async () => {
        await waitUntil(() => simulationBusy);
        const baseline = testFrames;
        wasm.exports.memory.grow(1);
        mutateSimulation(() => wasm.exports.changeScene(1));
        await waitUntil(() => testFrames >= baseline + 4);
    })()`);
    assert.deepEqual(await evaluate('testGPUFailures'), []);
    assert.deepEqual(exceptions, []);
    console.log('PASS Chromium WebGPU startup, particles, fluid resize, import, memory growth and continued frames');
    await send('Page.addScriptToEvaluateOnNewDocument', {source: "Object.defineProperty(navigator, 'gpu', {value: undefined});"}, sessionId);
    await send('Page.navigate', {url}, sessionId);
    await evaluate(`new Promise((resolve, reject) => {
        const start = Date.now(); const timer = setInterval(() => {
            if(window.plopPerformance) {clearInterval(timer); resolve(true);}
            else if(Date.now() - start > 15000) {clearInterval(timer); reject(new Error('Canvas2D stalled'));}
        }, 20);
    })`);
    assert.equal(await evaluate('window.plopRenderer'), 'canvas2d');
    assert.deepEqual(exceptions, []);
    console.log('PASS Chromium Canvas2D fallback and continuing simulation');
})().catch(error => {console.error(error); process.exitCode = 1;}).finally(() => {
    if(socket) socket.close();
    if(browser) browser.kill();
    server.close();
});
