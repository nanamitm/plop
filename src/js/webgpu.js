class Canvas2DRenderer {
    constructor(canvas) {
        this.ctx = canvas.getContext('2d');
    }

    resize() {}

    present(imageData) {
        this.ctx.putImageData(imageData, 0, 0);
    }

    get isWebGPU() {
        return false;
    }
}

class WebGPURenderer {
    static async create(canvas) {
        if(!navigator.gpu) throw new Error('WebGPU is unavailable');

        const adapter = await navigator.gpu.requestAdapter();
        if(!adapter) throw new Error('No WebGPU adapter found');

        const device = await adapter.requestDevice();
        const context = canvas.getContext('webgpu');
        if(!context) throw new Error('Could not create a WebGPU canvas context');

        return new WebGPURenderer(canvas, device, context, navigator.gpu.getPreferredCanvasFormat());
    }

    constructor(canvas, device, context, format) {
        this.canvas = canvas;
        this.device = device;
        this.context = context;
        this.format = format;
        this.sampler = device.createSampler({magFilter: 'nearest', minFilter: 'nearest'});
        this.pipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: device.createShaderModule({code: `
                    struct VertexOutput {
                        @builtin(position) position: vec4f,
                        @location(0) uv: vec2f,
                    };

                    @vertex fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
                        var positions = array<vec2f, 3>(
                            vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)
                        );
                        var uvs = array<vec2f, 3>(
                            vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0)
                        );
                        return VertexOutput(vec4f(positions[index], 0.0, 1.0), uvs[index]);
                    }

                    @group(0) @binding(0) var pixels: texture_2d<f32>;
                    @group(0) @binding(1) var pixelSampler: sampler;

                    @fragment fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
                        return textureSample(pixels, pixelSampler, uv);
                    }
                `}),
                entryPoint: 'vertexMain'
            },
            fragment: {
                module: device.createShaderModule({code: `
                    @group(0) @binding(0) var pixels: texture_2d<f32>;
                    @group(0) @binding(1) var pixelSampler: sampler;

                    @fragment fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
                        return textureSample(pixels, pixelSampler, uv);
                    }
                `}),
                entryPoint: 'fragmentMain',
                targets: [{format}]
            },
            primitive: {topology: 'triangle-list'}
        });
        this.computePipeline = device.createComputePipeline({
            layout: 'auto',
            compute: {
                module: device.createShaderModule({code: `
                    struct Dimensions { width: u32, height: u32 };
                    @group(0) @binding(0) var<storage, read> baseColours: array<u32>;
                    @group(0) @binding(1) var<storage, read> temperatures: array<f32>;
                    @group(0) @binding(2) var output: texture_storage_2d<rgba8unorm, write>;
                    @group(0) @binding(3) var<uniform> dimensions: Dimensions;

                    @compute @workgroup_size(8, 8)
                    fn computeMain(@builtin(global_invocation_id) id: vec3u) {
                        if(id.x >= dimensions.width || id.y >= dimensions.height) { return; }
                        let index = id.y * dimensions.width + id.x;
                        let packed = baseColours[index];
                        var rgb = vec3u(packed & 255u, (packed >> 8u) & 255u, (packed >> 16u) & 255u);
                        let temperature = temperatures[index];
                        if(temperature >= 0.0) {
                            var heat = temperature * 0.5;
                            if(heat >= 50.0 && heat < 130.0) { heat = 50.0; }
                            else if(heat >= 130.0) { heat = heat - 80.0; }
                            rgb.x = rgb.x | u32(min(255.0, heat));
                        } else {
                            rgb.z = rgb.z | u32(min(255.0, temperature * -4.0));
                        }
                        textureStore(output, id.xy, vec4f(vec3f(rgb) / 255.0, 1.0));
                    }
                `}),
                entryPoint: 'computeMain'
            }
        });
        const fluidModule = device.createShaderModule({code: `
            struct FluidParams { a: f32, c: f32, dt: f32, mode: u32, size: u32 };
            @group(0) @binding(0) var<storage, read> source: array<f32>;
            @group(0) @binding(1) var<storage, read> current: array<f32>;
            @group(0) @binding(2) var<storage, read> velocityX: array<f32>;
            @group(0) @binding(3) var<storage, read> velocityY: array<f32>;
            @group(0) @binding(4) var<storage, read_write> output: array<f32>;
            @group(0) @binding(5) var<uniform> params: FluidParams;

            fn index(x: i32, y: i32) -> u32 {
                let maximum = i32(params.size) - 1;
                return u32(clamp(x, 0, maximum) + clamp(y, 0, maximum) * i32(params.size));
            }

            @compute @workgroup_size(8, 8)
            fn fluidMain(@builtin(global_invocation_id) id: vec3u) {
                if(id.x >= params.size || id.y >= params.size) { return; }
                let x = i32(id.x); let y = i32(id.y); let at = index(x, y);
                let maximum = i32(params.size) - 1;
                if(x == 0 || y == 0 || x == maximum || y == maximum) {
                    output[at] = current[index(clamp(x, 1, maximum - 1), clamp(y, 1, maximum - 1))];
                    return;
                }
                if(params.mode == 0u) {
                    output[at] = (source[at] + params.a * (
                        current[index(x + 1, y)] + current[index(x - 1, y)] +
                        current[index(x, y + 1)] + current[index(x, y - 1)])) / params.c;
                } else {
                    let innerSize = f32(params.size - 2u);
                    let px = clamp(f32(x) - params.dt * innerSize * velocityX[at], 0.5, f32(params.size) - 0.5);
                    let py = clamp(f32(y) - params.dt * innerSize * velocityY[at], 0.5, f32(params.size) - 0.5);
                    let x0 = i32(floor(px)); let y0 = i32(floor(py));
                    let sx = px - f32(x0); let sy = py - f32(y0);
                    output[at] = mix(
                        mix(current[index(x0, y0)], current[index(x0 + 1, y0)], sx),
                        mix(current[index(x0, y0 + 1)], current[index(x0 + 1, y0 + 1)], sx), sy);
                }
            }
        `});
        this.fluidPipeline = device.createComputePipeline({layout: 'auto', compute: {module: fluidModule, entryPoint: 'fluidMain'}});
        this.cellTemperaturePipeline = device.createComputePipeline({
            layout: 'auto',
            compute: {
                module: device.createShaderModule({code: `
                    @group(0) @binding(0) var<storage, read> inputTemperature: array<f32>;
                    @group(0) @binding(1) var<storage, read> fluidDensity: array<f32>;
                    @group(0) @binding(2) var<storage, read> fluidNodes: array<u32>;
                    @group(0) @binding(3) var<storage, read> fluidWeights: array<f32>;
                    @group(0) @binding(4) var<storage, read_write> outputTemperature: array<f32>;
                    @group(0) @binding(5) var<uniform> cellCount: u32;

                    @compute @workgroup_size(256)
                    fn cellTemperatureMain(@builtin(global_invocation_id) id: vec3u) {
                        if(id.x >= cellCount) { return; }
                        var value = inputTemperature[id.x];
                        for(var j = 4u; j > 0u; j--) {
                            let mapIndex = id.x * 4u + (j - 1u);
                            let target = fluidDensity[fluidNodes[mapIndex]];
                            value = (value - target) * fluidWeights[mapIndex] + target;
                        }
                        outputTemperature[id.x] = value;
                    }
                `}),
                entryPoint: 'cellTemperatureMain'
            }
        });
        this.resize();
    }

    resize(fluidSize = 75) {
        if(this.texture) this.texture.destroy();
        this.context.configure({device: this.device, format: this.format, alphaMode: 'opaque'});
        this.texture = this.device.createTexture({
            size: [this.canvas.width, this.canvas.height],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.STORAGE_BINDING
        });
        this.bindGroup = this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                {binding: 0, resource: this.texture.createView()},
                {binding: 1, resource: this.sampler}
            ]
        });
        this.bytesPerRow = this.canvas.width * 4;
        this.alignedBytesPerRow = Math.ceil(this.bytesPerRow / 256) * 256;
        this.uploadBuffer = this.alignedBytesPerRow === this.bytesPerRow ? null : new Uint8Array(this.alignedBytesPerRow * this.canvas.height);
        const pixelCount = this.canvas.width * this.canvas.height;
        if(this.baseBuffer) this.baseBuffer.destroy();
        if(this.temperatureBuffer) this.temperatureBuffer.destroy();
        this.baseBuffer = this.device.createBuffer({size: pixelCount * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
        this.temperatureBuffer = this.device.createBuffer({size: pixelCount * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
        if(!this.dimensionsBuffer) this.dimensionsBuffer = this.device.createBuffer({size: 8, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
        this.device.queue.writeBuffer(this.dimensionsBuffer, 0, new Uint32Array([this.canvas.width, this.canvas.height]));
        this.computeBindGroup = this.device.createBindGroup({
            layout: this.computePipeline.getBindGroupLayout(0),
            entries: [
                {binding: 0, resource: {buffer: this.baseBuffer}},
                {binding: 1, resource: {buffer: this.temperatureBuffer}},
                {binding: 2, resource: this.texture.createView()},
                {binding: 3, resource: {buffer: this.dimensionsBuffer}}
            ]
        });
        this.setupFluidBuffers(fluidSize);
        this.setupCellBuffers(pixelCount);
    }

    setupCellBuffers(cellCount) {
        for(const buffer of [this.cellTemperatureInput, this.cellTemperatureOutput, this.cellNodes, this.cellWeights, this.cellReadback]) {
            if(buffer) buffer.destroy();
        }
        const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
        this.cellTemperatureInput = this.device.createBuffer({size: cellCount * 4, usage: storage});
        this.cellTemperatureOutput = this.device.createBuffer({size: cellCount * 4, usage: storage});
        this.cellNodes = this.device.createBuffer({size: cellCount * 16, usage: storage});
        this.cellWeights = this.device.createBuffer({size: cellCount * 16, usage: storage});
        this.cellReadback = this.device.createBuffer({size: cellCount * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
        if(!this.cellCountBuffer) this.cellCountBuffer = this.device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
        this.device.queue.writeBuffer(this.cellCountBuffer, 0, new Uint32Array([cellCount]));
        this.cellMapKey = null;
        this.cellTemperatureBindGroup = this.device.createBindGroup({layout: this.cellTemperaturePipeline.getBindGroupLayout(0), entries: [
            {binding: 0, resource: {buffer: this.cellTemperatureInput}},
            {binding: 1, resource: {buffer: this.fluidSource}},
            {binding: 2, resource: {buffer: this.cellNodes}},
            {binding: 3, resource: {buffer: this.cellWeights}},
            {binding: 4, resource: {buffer: this.cellTemperatureOutput}},
            {binding: 5, resource: {buffer: this.cellCountBuffer}}
        ]});
    }

    async stepCellTemperatures(temperatures, density, nodes, weights) {
        const mapKey = `${nodes.byteOffset}:${nodes.length}`;
        if(this.cellMapKey !== mapKey) {
            this.device.queue.writeBuffer(this.cellNodes, 0, nodes);
            this.device.queue.writeBuffer(this.cellWeights, 0, weights);
            this.cellMapKey = mapKey;
        }
        this.device.queue.writeBuffer(this.cellTemperatureInput, 0, temperatures);
        this.device.queue.writeBuffer(this.fluidSource, 0, density);
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.cellTemperaturePipeline);
        pass.setBindGroup(0, this.cellTemperatureBindGroup);
        pass.dispatchWorkgroups(Math.ceil(temperatures.length / 256));
        pass.end();
        encoder.copyBufferToBuffer(this.cellTemperatureOutput, 0, this.cellReadback, 0, temperatures.byteLength);
        this.device.queue.submit([encoder.finish()]);
        await this.cellReadback.mapAsync(GPUMapMode.READ);
        temperatures.set(new Float32Array(this.cellReadback.getMappedRange()).slice());
        this.cellReadback.unmap();
    }

    setupFluidBuffers(fluidSize) {
        if(this.fluidSize === fluidSize) return;
        for(const buffer of [this.fluidSource, this.fluidA, this.fluidB, this.fluidVX, this.fluidVY, this.fluidReadback, this.fluidDiffuseParams, this.fluidAdvectParams]) {
            if(buffer) buffer.destroy();
        }
        this.fluidSize = fluidSize;
        const size = fluidSize * fluidSize * 4;
        const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
        this.fluidSource = this.device.createBuffer({size, usage: storage});
        this.fluidA = this.device.createBuffer({size, usage: storage});
        this.fluidB = this.device.createBuffer({size, usage: storage});
        this.fluidVX = this.device.createBuffer({size, usage: storage});
        this.fluidVY = this.device.createBuffer({size, usage: storage});
        this.fluidReadback = this.device.createBuffer({size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
        this.fluidDiffuseParams = this.device.createBuffer({size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
        this.fluidAdvectParams = this.device.createBuffer({size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
        const a = 0.0005 * 0.1 * (fluidSize - 2) * (fluidSize - 2);
        const diffuse = new ArrayBuffer(32);
        new Float32Array(diffuse).set([a, 1 + 4 * a, 0.0005]);
        new Uint32Array(diffuse).set([0, fluidSize], 3);
        this.device.queue.writeBuffer(this.fluidDiffuseParams, 0, diffuse);
        const advect = new ArrayBuffer(32);
        new Float32Array(advect).set([0, 1, 0.0005]);
        new Uint32Array(advect).set([1, fluidSize], 3);
        this.device.queue.writeBuffer(this.fluidAdvectParams, 0, advect);
    }

    fluidBindGroup(current, output, params) {
        return this.device.createBindGroup({layout: this.fluidPipeline.getBindGroupLayout(0), entries: [
            {binding: 0, resource: {buffer: this.fluidSource}},
            {binding: 1, resource: {buffer: current}},
            {binding: 2, resource: {buffer: this.fluidVX}},
            {binding: 3, resource: {buffer: this.fluidVY}},
            {binding: 4, resource: {buffer: output}},
            {binding: 5, resource: {buffer: params}}
        ]});
    }

    async stepFluid(density, vx, vy) {
        this.device.queue.writeBuffer(this.fluidSource, 0, density);
        this.device.queue.writeBuffer(this.fluidA, 0, density);
        this.device.queue.writeBuffer(this.fluidVX, 0, vx);
        this.device.queue.writeBuffer(this.fluidVY, 0, vy);
        const encoder = this.device.createCommandEncoder();
        let current = this.fluidA, output = this.fluidB;
        for(let iteration = 0; iteration < 16; ++iteration) {
            const pass = encoder.beginComputePass();
            pass.setPipeline(this.fluidPipeline);
            pass.setBindGroup(0, this.fluidBindGroup(current, output, this.fluidDiffuseParams));
            pass.dispatchWorkgroups(Math.ceil(this.fluidSize / 8), Math.ceil(this.fluidSize / 8));
            pass.end();
            [current, output] = [output, current];
        }
        const advect = encoder.beginComputePass();
        advect.setPipeline(this.fluidPipeline);
        advect.setBindGroup(0, this.fluidBindGroup(current, output, this.fluidAdvectParams));
        advect.dispatchWorkgroups(Math.ceil(this.fluidSize / 8), Math.ceil(this.fluidSize / 8));
        advect.end();
        encoder.copyBufferToBuffer(output, 0, this.fluidReadback, 0, density.byteLength);
        this.device.queue.submit([encoder.finish()]);
        await this.fluidReadback.mapAsync(GPUMapMode.READ);
        density.set(new Float32Array(this.fluidReadback.getMappedRange()).slice());
        this.fluidReadback.unmap();
    }

    present(imageData, baseData, temperatureData) {
        if(baseData && temperatureData) {
            this.device.queue.writeBuffer(this.baseBuffer, 0, baseData);
            this.device.queue.writeBuffer(this.temperatureBuffer, 0, temperatureData);
            const encoder = this.device.createCommandEncoder();
            const compute = encoder.beginComputePass();
            compute.setPipeline(this.computePipeline);
            compute.setBindGroup(0, this.computeBindGroup);
            compute.dispatchWorkgroups(Math.ceil(this.canvas.width / 8), Math.ceil(this.canvas.height / 8));
            compute.end();
            this.drawTexture(encoder);
            this.device.queue.submit([encoder.finish()]);
            return;
        }
        const pixels = imageData.data || imageData;
        let upload = pixels;

        if(this.uploadBuffer) {
            for(let y = 0; y < this.canvas.height; ++y) {
                const sourceStart = y * this.bytesPerRow;
                this.uploadBuffer.set(pixels.subarray(sourceStart, sourceStart + this.bytesPerRow), y * this.alignedBytesPerRow);
            }
            upload = this.uploadBuffer;
        }

        this.device.queue.writeTexture(
            {texture: this.texture},
            upload,
            {bytesPerRow: this.alignedBytesPerRow, rowsPerImage: this.canvas.height},
            {width: this.canvas.width, height: this.canvas.height}
        );

        const encoder = this.device.createCommandEncoder();
        this.drawTexture(encoder);
        this.device.queue.submit([encoder.finish()]);
    }

    drawTexture(encoder) {
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.context.getCurrentTexture().createView(),
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: [0, 0, 0, 1]
            }]
        });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup);
        pass.draw(3);
        pass.end();
    }

    get isWebGPU() {
        return true;
    }
}

async function createRenderer(canvas) {
    try {
        return await WebGPURenderer.create(canvas);
    } catch(error) {
        console.warn('WebGPU rendering is unavailable; using Canvas 2D instead.', error);
        return new Canvas2DRenderer(canvas);
    }
}
