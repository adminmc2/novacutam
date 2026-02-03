/**
 * Novacutan - Orb WebGL Shader
 * Logo animado con colores corporativos y transiciones intensas
 */

(function() {
    // Colores corporativos Novacutan (para referencia en mood tint)
    const COLORS = {
        blue: { r: 102, g: 126, b: 234 },    // #667eea
        purple: { r: 118, g: 75, b: 162 },   // #764ba2
        pink: { r: 240, g: 147, b: 251 },    // #f093fb
        cyan: { r: 107, g: 217, b: 255 },    // #6BD9FF
    };

    // Estados
    let isListening = false;
    let currentMood = 'c'; // a=calma, b=moderado, c=vibrante
    const orbInstances = [];

    // Vertex shader (simple quad)
    const vertexShaderSource = `#version 300 es
precision highp float;
in vec4 position;
void main() {
    gl_Position = position;
}`;

    // Fragment shader con colores Novacutan
    const fragmentShaderSource = `#version 300 es
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

out vec4 O;
uniform float time;
uniform vec2 resolution;
uniform float intensity; // 0.0 = idle, 1.0 = listening
uniform float mood;      // 0.0 = calma, 0.5 = moderado, 1.0 = vibrante
uniform float smallMode; // 1.0 = tamaño pequeño (<80px), 0.0 = normal

#define FC gl_FragCoord.xy
#define R resolution
#define T time
#define S smoothstep
#define SE(v,a) S(fwidth(a),-7e-3,v-a)
#define MN min(R.x,R.y)
#define MX max(R.x,R.y)
#define reveal(p) SE(MN/MX*length(p),sqrt(S(1.,.0,1./T*1.8)))
#define TAU radians(360.)
#define PI (TAU/2.)

// Paleta Novacutan con transiciones suaves y elegantes
vec3 novacutanHue(float a) {
    // Colores Novacutan
    vec3 blue = vec3(0.4, 0.494, 0.918);      // #667eea
    vec3 purple = vec3(0.463, 0.294, 0.635);  // #764ba2
    vec3 pink = vec3(0.941, 0.576, 0.984);    // #f093fb
    vec3 cyan = vec3(0.42, 0.85, 1.0);        // cyan accent

    // Transición muy suave entre colores
    float t = fract(a);
    vec3 col;

    // Ciclo suave: blue -> purple -> pink -> cyan -> blue
    float phase = t * 4.0;
    if (phase < 1.0) {
        col = mix(blue, purple, smoothstep(0.0, 1.0, phase));
    } else if (phase < 2.0) {
        col = mix(purple, pink, smoothstep(0.0, 1.0, phase - 1.0));
    } else if (phase < 3.0) {
        col = mix(pink, cyan, smoothstep(0.0, 1.0, phase - 2.0));
    } else {
        col = mix(cyan, blue, smoothstep(0.0, 1.0, phase - 3.0));
    }

    // Variación de brillo muy sutil (no discoteca)
    float brightness = 0.08 + intensity * 0.12;
    col += brightness * sin(PI * a * 0.5 + vec3(0.0, 1.0, 2.0));

    return clamp(col, 0.0, 1.0);
}

#define hue(a) novacutanHue(a)

mat2 rot(float a) {
    float c = cos(a), s = sin(a);
    return mat2(c, -s, s, c);
}

vec2 pmod(vec2 p, float n) {
    float a = atan(p.x, p.y);
    float b = TAU / n;
    a = floor(0.5 + a / b) * b;
    return rot(-a) * p;
}

vec3 pattern(inout vec2 uv) {
    // Número de pétalos: menos en modo pequeño para mejor visibilidad
    float petals = mix(7.0 + mood * 4.0, 4.0 + mood * 1.0, smallMode);
    uv = pmod(uv, petals);
    uv = uv.yx;
    vec2 p = uv;
    float n = 2.8;
    uv.x -= clamp(round(uv.x * n), 1.0, 4.0) / n;
    float id = clamp(round(uv.x * n), 1.0, 4.0);

    // Velocidad de animación suave (sync con voz, no discoteca)
    float speed = 0.15 + intensity * 0.6 + mood * 0.2;
    uv.x -= sin(-1.6 + id + T * PI * speed + p.x * id) * 0.0125 + 0.005;

    float d = SE(length(uv), 0.023 * (6.0 - round(p.x * n)));
    vec3 col = vec3(0);
    // Transición de color suave y elegante
    float colorSpeed = 0.3 + intensity * 1.2;
    vec3 c = hue(0.2 * (round(p.x * n) - T * colorSpeed) + S(-0.25, 1.0, uv.x) * 0.5);
    col += tanh(c * c * c) * clamp(d * d * d, 0.0, 1.0);
    return sqrt(col);
}

void main() {
    vec2 uv = (FC - 0.5 * R) / MN;
    vec2 p, st = uv;

    // Zoom según mood y tamaño (menor zoom en pequeño = más visible)
    float zoom = mix(3.5 + mood * 1.0, 2.0 + mood * 0.5, smallMode);
    uv *= zoom;

    // Rotación muy suave y elegante
    float rotSpeed = 0.005 + intensity * 0.015;
    uv *= rot(rotSpeed * sin(T * (0.3 + intensity * 0.3) - uv.y * 2.0) - 0.0125);
    p = uv;
    p *= rot(0.0125);

    vec3 col;
    vec3 c = pattern(uv);
    // Pulso central suave
    float pulseSpeed = 0.15 + intensity * 0.25;
    float k = 0.05 / length(uv) * pow(0.5 + 0.5 * sin(T * PI * pulseSpeed), 3.0);
    col = mix(k * tanh(c * c * c), pattern(p), 0.985);
    col *= reveal(st);

    // Glow central suave con colores Novacutan (más intenso en modo pequeño)
    float glowIntensity = mix(0.15 + intensity * 0.2, 0.25 + intensity * 0.3, smallMode);
    float glow = exp(-length(st) * (2.8 - intensity * 0.5)) * glowIntensity;
    vec3 glowColor = mix(
        vec3(0.4, 0.494, 0.918),  // blue
        vec3(0.463, 0.294, 0.635), // purple
        0.5 + 0.5 * sin(T * 0.2)  // transición muy lenta
    );
    col += glowColor * glow;

    // Máscara circular suave para eliminar esquinas oscuras (más suave en pequeño)
    float dist = length(st);
    float maskOuter = mix(0.5, 0.48, smallMode);
    float circleMask = 1.0 - smoothstep(0.35, maskOuter, dist);

    // Alpha: solo visible dentro del círculo, sin fondo cuadrado
    float baseAlpha = clamp(length(col) * 2.0, 0.0, 1.0);
    float alpha = baseAlpha * circleMask;

    // Color final con máscara
    O = vec4(col * circleMask, alpha);
}`;

    // Clase WebGL Orb
    class WebGLOrb {
        constructor(canvas, size) {
            this.canvas = canvas;
            this.size = size;
            this.intensity = 0;
            this.targetIntensity = 0;
            this.mood = 1.0; // default vibrante
            this.running = false;
            this.startTime = performance.now();

            // Setup canvas size
            const dpr = window.devicePixelRatio || 1;
            canvas.width = size * dpr;
            canvas.height = size * dpr;
            canvas.style.width = size + 'px';
            canvas.style.height = size + 'px';

            // Get WebGL2 context with transparency
            this.gl = canvas.getContext('webgl2', {
                alpha: true,
                premultipliedAlpha: true,
                antialias: true,
                preserveDrawingBuffer: false
            });

            if (!this.gl) {
                console.warn('WebGL2 not supported, falling back to 2D');
                this.fallback2D = true;
                return;
            }

            this.setupShaders();
            this.setupGeometry();
        }

        setupShaders() {
            const gl = this.gl;

            // Compile vertex shader
            const vs = gl.createShader(gl.VERTEX_SHADER);
            gl.shaderSource(vs, vertexShaderSource);
            gl.compileShader(vs);
            if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
                console.error('Vertex shader error:', gl.getShaderInfoLog(vs));
                return;
            }

            // Compile fragment shader
            const fs = gl.createShader(gl.FRAGMENT_SHADER);
            gl.shaderSource(fs, fragmentShaderSource);
            gl.compileShader(fs);
            if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
                console.error('Fragment shader error:', gl.getShaderInfoLog(fs));
                return;
            }

            // Create program
            this.program = gl.createProgram();
            gl.attachShader(this.program, vs);
            gl.attachShader(this.program, fs);
            gl.linkProgram(this.program);

            if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
                console.error('Program link error:', gl.getProgramInfoLog(this.program));
                return;
            }

            // Get uniform locations
            this.uniforms = {
                resolution: gl.getUniformLocation(this.program, 'resolution'),
                time: gl.getUniformLocation(this.program, 'time'),
                intensity: gl.getUniformLocation(this.program, 'intensity'),
                mood: gl.getUniformLocation(this.program, 'mood'),
                smallMode: gl.getUniformLocation(this.program, 'smallMode'),
            };

            // Detectar si es un orb pequeño (<80px)
            this.isSmall = this.size < 80;
        }

        setupGeometry() {
            const gl = this.gl;

            // Full-screen quad
            const vertices = new Float32Array([
                -1, 1, -1, -1, 1, 1, 1, -1
            ]);

            this.buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
            gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

            const position = gl.getAttribLocation(this.program, 'position');
            gl.enableVertexAttribArray(position);
            gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
        }

        start() {
            if (this.running || this.fallback2D) return;
            this.running = true;
            this.startTime = performance.now();
            this.loop();
        }

        stop() {
            this.running = false;
            if (this.animId) {
                cancelAnimationFrame(this.animId);
                this.animId = null;
            }
        }

        loop() {
            if (!this.running) return;

            // Smooth intensity transition (más suave, sync con voz)
            this.intensity += (this.targetIntensity - this.intensity) * 0.04;

            this.render();
            this.animId = requestAnimationFrame(() => this.loop());
        }

        render() {
            const gl = this.gl;
            const now = (performance.now() - this.startTime) / 1000;

            gl.viewport(0, 0, this.canvas.width, this.canvas.height);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);

            // Enable blending for transparency
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

            gl.useProgram(this.program);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);

            gl.uniform2f(this.uniforms.resolution, this.canvas.width, this.canvas.height);
            gl.uniform1f(this.uniforms.time, now);
            gl.uniform1f(this.uniforms.intensity, this.intensity);
            gl.uniform1f(this.uniforms.mood, this.mood);
            gl.uniform1f(this.uniforms.smallMode, this.isSmall ? 1.0 : 0.0);

            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }

        setListening(listening) {
            this.targetIntensity = listening ? 1.0 : 0.0;
        }

        setMood(moodKey) {
            // a=calma(0), b=moderado(0.5), c=vibrante(1)
            const moodValues = { 'a': 0.0, 'b': 0.5, 'c': 1.0 };
            this.mood = moodValues[moodKey] ?? 1.0;
        }

        destroy() {
            this.stop();
            if (this.gl && this.program) {
                this.gl.deleteProgram(this.program);
            }
        }
    }

    // Fallback 2D Canvas para navegadores sin WebGL2
    class Canvas2DOrb {
        constructor(canvas, size) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            this.size = size;
            this.time = 0;
            this.intensity = 0;
            this.targetIntensity = 0;
            this.mood = 1.0;
            this.running = false;

            const dpr = window.devicePixelRatio || 1;
            canvas.width = size * dpr;
            canvas.height = size * dpr;
            canvas.style.width = size + 'px';
            canvas.style.height = size + 'px';
            this.ctx.scale(dpr, dpr);

            this.centerX = size / 2;
            this.centerY = size / 2;
        }

        start() {
            if (this.running) return;
            this.running = true;
            this.lastTime = performance.now();
            this.loop();
        }

        stop() {
            this.running = false;
            if (this.animId) {
                cancelAnimationFrame(this.animId);
            }
        }

        loop() {
            if (!this.running) return;
            const now = performance.now();
            const dt = (now - this.lastTime) / 1000;
            this.lastTime = now;
            this.time += dt;
            this.intensity += (this.targetIntensity - this.intensity) * 0.1;
            this.draw();
            this.animId = requestAnimationFrame(() => this.loop());
        }

        draw() {
            const ctx = this.ctx;
            const { centerX, centerY, size, time, intensity } = this;

            ctx.clearRect(0, 0, size, size);

            // Gradiente animado simple
            const hue1 = (time * 30) % 360;
            const hue2 = (time * 30 + 60) % 360;

            const gradient = ctx.createRadialGradient(
                centerX, centerY, 0,
                centerX, centerY, size * 0.4
            );

            gradient.addColorStop(0, `hsla(${hue1}, 70%, 60%, ${0.8 + intensity * 0.2})`);
            gradient.addColorStop(0.5, `hsla(${hue2}, 60%, 50%, ${0.5 + intensity * 0.3})`);
            gradient.addColorStop(1, 'rgba(102, 126, 234, 0)');

            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(centerX, centerY, size * 0.4, 0, Math.PI * 2);
            ctx.fill();
        }

        setListening(listening) {
            this.targetIntensity = listening ? 1.0 : 0.0;
        }

        setMood(moodKey) {
            const moodValues = { 'a': 0.0, 'b': 0.5, 'c': 1.0 };
            this.mood = moodValues[moodKey] ?? 1.0;
        }

        destroy() {
            this.stop();
        }
    }

    // Factory function
    function createOrbInstance(canvas, size) {
        // Try WebGL2 first
        const testCanvas = document.createElement('canvas');
        const gl = testCanvas.getContext('webgl2');

        if (gl) {
            return new WebGLOrb(canvas, size);
        } else {
            return new Canvas2DOrb(canvas, size);
        }
    }

    // Crear orb en un contenedor
    function createOrb(containerId, defaultSize) {
        const container = document.getElementById(containerId);
        if (!container) return null;

        container.innerHTML = '';

        const w = container.offsetWidth;
        const h = container.offsetHeight;
        // Fallback to CSS computed size or defaultSize
        const style = getComputedStyle(container);
        const cssW = parseInt(style.width) || defaultSize;
        const cssH = parseInt(style.height) || defaultSize;
        const size = Math.min(w, h) || Math.min(cssW, cssH) || defaultSize;

        const canvas = document.createElement('canvas');
        canvas.style.display = 'block';
        container.appendChild(canvas);

        const orb = createOrbInstance(canvas, size);
        orb.setMood(currentMood);
        orb.start();

        return {
            id: containerId,
            container,
            orb,
            defaultSize
        };
    }

    // Crear mini orb en elemento
    function createOrbInElement(container, size) {
        container.innerHTML = '';
        const canvas = document.createElement('canvas');
        canvas.style.display = 'block';
        container.appendChild(canvas);
        const orb = createOrbInstance(canvas, size);
        orb.setMood(currentMood);
        orb.start();
        return orb;
    }

    // Init main orb
    function initMainOrb() {
        const container = document.getElementById('orb-container');
        if (container && container.offsetWidth > 0) {
            const mainOrb = createOrb('orb-container', 140);
            if (mainOrb) orbInstances.push(mainOrb);
        } else {
            requestAnimationFrame(initMainOrb);
        }
    }
    initMainOrb();

    // Init login orb
    function initLoginOrb() {
        const container = document.getElementById('login-orb-container');
        if (container) {
            const w = container.offsetWidth;
            const h = container.offsetHeight;
            // Use CSS dimensions if offsetWidth is 0
            const style = getComputedStyle(container);
            const cssW = parseInt(style.width) || 0;
            const cssH = parseInt(style.height) || 0;

            if (w > 0 || cssW > 0) {
                const loginOrb = createOrb('login-orb-container', 260);
                if (loginOrb) {
                    orbInstances.push(loginOrb);
                    console.log('[Orb] Login orb created:', w || cssW, 'x', h || cssH);
                }
            } else {
                requestAnimationFrame(initLoginOrb);
            }
        }
    }

    // Wait for DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initLoginOrb);
    } else {
        initLoginOrb();
    }

    // API pública
    window.orbSetListening = function(listening) {
        isListening = listening;
        orbInstances.forEach(inst => {
            if (inst && inst.orb) {
                inst.orb.setListening(listening);
            }
        });
    };

    window.orbSetMoodPreset = function(presetKey) {
        currentMood = presetKey;
        orbInstances.forEach(inst => {
            if (inst && inst.orb) {
                inst.orb.setMood(presetKey);
            }
        });
    };

    window.orbCreateMini = function() {
        const existing = orbInstances.find(o => o && o.id === 'orb-container-mini');
        if (existing) return;
        const miniOrb = createOrb('orb-container-mini', 56);
        if (miniOrb) orbInstances.push(miniOrb);
    };

    window.orbCreateChatHeader = function() {
        const existing = orbInstances.find(o => o && o.id === 'orb-container-chat-header');
        if (existing) return;
        const chatOrb = createOrb('orb-container-chat-header', 40);
        if (chatOrb) orbInstances.push(chatOrb);
    };

    window.orbCreateNav = function() {
        const existing = orbInstances.find(o => o && o.id === 'orb-container-nav');
        if (existing) return;
        const navOrb = createOrb('orb-container-nav', 56);
        if (navOrb) orbInstances.push(navOrb);
    };

    window.orbSetMoodTint = function(r, g, b) {
        // Compatibility - not used in shader version
    };

    window.orbCreateInElement = function(container, size) {
        return createOrbInElement(container, size || 28);
    };
})();
