function exportData() {
    const ptr = wasm.exports.exportData();
    if(!ptr) throw new Error('Could not allocate saved state');

    const [,,,cellLength, cellSize, cellArrayOffset] = new Uint32Array(wasm.exports.memory.buffer, ptr, 6);
    const byteLen = cellLength * cellSize + cellArrayOffset;

    const view = new Uint8Array(wasm.exports.memory.buffer, ptr, byteLen);
    const buffer = new Uint8Array(byteLen);

    for(let i = 0; i < byteLen; ++i) {
        buffer[i] = view[i];
    };
    wasm.exports.free(ptr);
    return pako.deflate(buffer);
}

function importData(compressed) {
    let ptr = 0;
    try {
        const buffer = pako.inflate(compressed);

        const byteLen = buffer.byteLength;
        ptr = wasm.exports.malloc(byteLen);
        if(!ptr) throw new Error('Could not allocate imported state');
        const view = new Uint8Array(wasm.exports.memory.buffer, ptr, byteLen);
        for(let i = 0; i < byteLen; ++i) {
            view[i] = buffer[i];
        }
        const success = wasm.exports.importData(ptr, byteLen);
    
        if(!success) {
            console.error('Invalid File!');
            return false;
        }
    
        const size = buffer[8];
    
        canvas.width = size * 75;
        canvas.height = size * 75;
        renderer.resize(wasm.exports.getFluidSize());
        refreshImageData();
    } catch(e) {
        console.error(e);
        console.error('Invalid File!');
        return false;
    } finally {
        if(ptr) wasm.exports.free(ptr);
    }
    return true;
}
