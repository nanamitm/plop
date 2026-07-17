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
        this.resize();
    }

    resize() {
        if(this.texture) this.texture.destroy();
        this.context.configure({device: this.device, format: this.format, alphaMode: 'opaque'});
        this.texture = this.device.createTexture({
            size: [this.canvas.width, this.canvas.height],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
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
    }

    present(imageData) {
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
        this.device.queue.submit([encoder.finish()]);
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
