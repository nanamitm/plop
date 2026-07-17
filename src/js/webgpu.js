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
        this.resize();
    }

    resize() {
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
