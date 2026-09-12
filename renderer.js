// Sharp bilinear: emulate an integer nearest prescale followed by bilinear
// interpolation in one pass. See README.md for the reference implementation.
export function fitViewport(width, height, mode, sourceWidth = 640, sourceHeight = 400) {
  if (mode === 3) return {width: sourceWidth, height: sourceHeight};
  const fit = Math.min(width / sourceWidth, height / sourceHeight);
  // On smaller screens use reciprocal integers so the full image stays visible.
  const scale = mode === 0 ? (fit >= 1 ? Math.floor(fit) : 1 / Math.ceil(1 / fit)) : fit;
  return { width: Math.max(1, Math.floor(sourceWidth * scale)), height: Math.max(1, Math.floor(sourceHeight * scale)) };
}

export class Renderer {
  constructor(canvas, source) {
    this.canvas = canvas;
    this.source = source;
    this.gl = canvas.getContext('webgl', {alpha: false, antialias: false});
    if (!this.gl) throw new Error('WebGL is required to display Web YU-NO.');
    this.captures = 0;
    this.dirty = true;
    this.initialize();
    canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.initialize(); this.lost = false; });
  }

  initialize() {
    const gl = this.gl;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, `
      attribute vec2 position;
      varying vec2 uv;
      void main() { uv = vec2(position.x * .5 + .5, .5 - position.y * .5); gl_Position = vec4(position, 0., 1.); }
    `);
    const fragment = compile(gl.FRAGMENT_SHADER, `
      precision highp float;
      varying vec2 uv;
      uniform sampler2D image;
      uniform vec2 sourceSize;
      uniform vec2 outputSize;
      uniform bool sharp;
      void main() {
        vec2 sampleUV = uv;
        if (sharp) {
          vec2 prescale = max(floor(outputSize / sourceSize), vec2(1.));
          vec2 pixel = uv * sourceSize;
          vec2 center = floor(pixel) + .5;
          vec2 fraction = fract(pixel) - .5;
          vec2 plateau = .5 - .5 / prescale;
          vec2 transition = (fraction - clamp(fraction, -plateau, plateau)) * prescale;
          sampleUV = (center + transition) / sourceSize;
        }
        gl_FragColor = texture2D(image, sampleUV);
      }
    `);
    this.program = gl.createProgram();
    gl.attachShader(this.program, vertex); gl.attachShader(this.program, fragment); gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program));
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    this.position = gl.getAttribLocation(this.program, 'position');
    this.texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.uniforms = Object.fromEntries(['sourceSize', 'outputSize', 'sharp'].map(key => [key, gl.getUniformLocation(this.program, key)]));

    const cursorVertex = compile(gl.VERTEX_SHADER, `
      attribute vec4 vertex;
      varying vec2 uv;
      void main() { gl_Position = vec4(vertex.xy, 0., 1.); uv = vertex.zw; }
    `);
    const cursorFragment = compile(gl.FRAGMENT_SHADER, `
      precision mediump float;
      varying vec2 uv;
      uniform sampler2D image;
      void main() { gl_FragColor = texture2D(image, uv); }
    `);
    this.cursorProgram = gl.createProgram();
    gl.attachShader(this.cursorProgram, cursorVertex); gl.attachShader(this.cursorProgram, cursorFragment);
    gl.linkProgram(this.cursorProgram);
    if (!gl.getProgramParameter(this.cursorProgram, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.cursorProgram));
    gl.deleteShader(cursorVertex); gl.deleteShader(cursorFragment);
    this.cursorPosition = gl.getAttribLocation(this.cursorProgram, 'vertex');
    this.cursorBuffer = gl.createBuffer();
    this.cursorTextures = new WeakMap();
    this.textureAllocated = false;
    this.dirty = true;
    this.lastFrameKey = '';
  }

  capture() {
    this.dirty = true;
    this.captures++;
  }

  invalidate() { this.dirty = true; }

  drawOverlay(canvas, x, y, width, height) {
    const gl = this.gl;
    let texture = this.cursorTextures.get(canvas);
    if (!texture) {
      texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      this.cursorTextures.set(canvas, texture);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, texture);
    }
    const left = x / this.canvas.width * 2 - 1;
    const right = (x + width) / this.canvas.width * 2 - 1;
    const top = 1 - y / this.canvas.height * 2;
    const bottom = 1 - (y + height) / this.canvas.height * 2;
    const vertices = new Float32Array([
      left,bottom,0,1, right,bottom,1,1, left,top,0,0,
      left,top,0,0, right,bottom,1,1, right,top,1,0,
    ]);
    gl.useProgram(this.cursorProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cursorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.cursorPosition);
    gl.vertexAttribPointer(this.cursorPosition, 4, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.BLEND);
  }

  draw(mode, cursor, sprite, captured) {
    if (this.lost) return;
    const frameKey = `${mode}:${this.canvas.width}:${this.canvas.height}:${captured}:${cursor.visible}:${cursor.id}:${cursor.x}:${cursor.y}`;
    if (!this.dirty && frameKey === this.lastFrameKey) return;
    this.lastFrameKey = frameKey;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(this.position);
    gl.vertexAttribPointer(this.position, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    const filter = mode === 2 ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.uniform2f(this.uniforms.sourceSize, this.source.width, this.source.height);
    gl.uniform2f(this.uniforms.outputSize, this.canvas.width, this.canvas.height);
    gl.uniform1i(this.uniforms.sharp, mode === 2);
    if (this.dirty) {
      if (this.textureAllocated)
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.source);
      else
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.source);
      this.textureAllocated = true;
      this.dirty = false;
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    if (captured && cursor.visible && sprite) {
      // Position follows game coordinates, but cursor pixels and its hotspot
      // stay one physical display pixel each instead of inheriting game scale.
      const x = cursor.x / this.source.width * this.canvas.width - sprite.hx;
      const y = cursor.y / this.source.height * this.canvas.height - sprite.hy;
      this.drawOverlay(sprite.canvas, x, y, sprite.canvas.width, sprite.canvas.height);
    }
  }
}
