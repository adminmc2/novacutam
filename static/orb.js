/**
 * Novacutan - Orb 3D con partículas tipo gotas de agua
 * Esfera con puntos que cambian entre los colores corporativos
 */

(function() {
    // Colores corporativos Novacutan
    const COLORS = [
        { r: 49, g: 190, b: 239 },   // Tech Cyan #31BEEF
        { r: 153, g: 78, b: 149 },    // Visionary Violet #994E95
        { r: 161, g: 184, b: 242 },   // Soft Blue #A1B8F2
    ];

    // Presets de movimiento según estado de ánimo
    const MOOD_PRESETS = {
        // a) Brisa suave — calma (mood triste)
        a: {
            idlePhiAmp: 0.08, idlePhiSpeed: 0.6,
            idleThetaAmp: 0.06, idleThetaSpeed: 0.4,
            idleRotSpeed: 0.15, idleDropAmp: 0.05,
            listenPhiAmp: 0.2, listenPhiSpeed: 1.8,
            listenThetaSpeed: 1.0, listenThetaAmp: 0.15,
            listenRotSpeed: 0.7, listenDropAmp: 0.1,
        },
        // b) Oleaje vivo — moderado (mood neutral)
        b: {
            idlePhiAmp: 0.15, idlePhiSpeed: 0.9,
            idleThetaAmp: 0.12, idleThetaSpeed: 0.6,
            idleRotSpeed: 0.25, idleDropAmp: 0.08,
            listenPhiAmp: 0.3, listenPhiSpeed: 2.2,
            listenThetaSpeed: 1.4, listenThetaAmp: 0.2,
            listenRotSpeed: 1.0, listenDropAmp: 0.15,
        },
        // c) Tormenta líquida — vibrante (mood feliz, default)
        c: {
            idlePhiAmp: 0.25, idlePhiSpeed: 1.3,
            idleThetaAmp: 0.2, idleThetaSpeed: 0.9,
            idleRotSpeed: 0.4, idleDropAmp: 0.12,
            listenPhiAmp: 0.45, listenPhiSpeed: 2.8,
            listenThetaSpeed: 2.0, listenThetaAmp: 0.3,
            listenRotSpeed: 1.5, listenDropAmp: 0.2,
        }
    };

    // Estado global
    let isListening = false;
    let currentPreset = MOOD_PRESETS.c;
    let moodTint = null;          // { r, g, b } — color del mood actual
    const MOOD_TINT_MIX = 0.18;  // 18% de mezcla — sutil pero visible
    const orbInstances = [];

    // Interpolar entre dos colores
    function lerpColor(c1, c2, t) {
        return {
            r: Math.round(c1.r + (c2.r - c1.r) * t),
            g: Math.round(c1.g + (c2.g - c1.g) * t),
            b: Math.round(c1.b + (c2.b - c1.b) * t),
        };
    }

    // Obtener color cíclico basado en tiempo, con tintado sutil del mood
    function getCyclicColor(time, offset) {
        const speed = 0.3;
        const t = ((time * speed + offset) % 3 + 3) % 3;
        const idx = Math.floor(t);
        const frac = t - idx;
        const c1 = COLORS[idx % 3];
        const c2 = COLORS[(idx + 1) % 3];
        const base = lerpColor(c1, c2, frac);
        // Mezclar sutilmente con el tint del mood
        if (moodTint) {
            return lerpColor(base, moodTint, MOOD_TINT_MIX);
        }
        return base;
    }

    // Clase Partícula (punto en superficie de esfera)
    class Particle {
        constructor(index, total) {
            // Distribución uniforme en esfera (Fibonacci sphere)
            const phi = Math.acos(1 - 2 * (index + 0.5) / total);
            const theta = Math.PI * (1 + Math.sqrt(5)) * index;

            this.basePhi = phi;
            this.baseTheta = theta;
            this.phi = phi;
            this.theta = theta;

            // Offset de color único por partícula
            this.colorOffset = Math.random() * 3;

            // Tamaño base (variado para parecer gotas)
            this.baseSize = 1.5 + Math.random() * 2.5;

            // Opacidad base
            this.baseAlpha = 0.5 + Math.random() * 0.5;

            // Velocidad propia para movimiento orgánico
            this.phiSpeed = (Math.random() - 0.5) * 0.002;
            this.thetaSpeed = (Math.random() - 0.5) * 0.003;

            // Para efecto "gota de agua" - oscilación del radio
            this.radiusOffset = Math.random() * Math.PI * 2;
            this.radiusSpeed = 0.5 + Math.random() * 1.5;
        }

        update(time, listening) {
            const p = currentPreset;
            if (listening) {
                this.phi = this.basePhi + Math.sin(time * p.listenPhiSpeed + this.radiusOffset) * p.listenPhiAmp;
                this.theta = this.baseTheta + time * p.listenThetaSpeed + Math.cos(time * 2.5 + this.radiusOffset) * p.listenThetaAmp;
            } else {
                this.phi = this.basePhi + Math.sin(time * p.idlePhiSpeed + this.radiusOffset) * p.idlePhiAmp;
                this.theta = this.baseTheta + Math.sin(time * p.idleThetaSpeed + this.colorOffset) * p.idleThetaAmp;
            }
        }

        getPosition(radius) {
            const x = radius * Math.sin(this.phi) * Math.cos(this.theta);
            const y = radius * Math.cos(this.phi);
            const z = radius * Math.sin(this.phi) * Math.sin(this.theta);
            return { x, y, z };
        }
    }

    // Clase Orb
    class Orb {
        constructor(canvas, size) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            this.size = size;

            // Escala para retina
            const dpr = window.devicePixelRatio || 1;
            canvas.width = size * dpr;
            canvas.height = size * dpr;
            canvas.style.width = size + 'px';
            canvas.style.height = size + 'px';
            this.ctx.scale(dpr, dpr);

            this.centerX = size / 2;
            this.centerY = size / 2;
            this.radius = size * 0.36;

            // Crear partículas
            const numParticles = size > 100 ? 200 : 80;
            this.particles = [];
            for (let i = 0; i < numParticles; i++) {
                this.particles.push(new Particle(i, numParticles));
            }

            this.time = 0;
            this.rotationY = 0;
            this.animId = null;
            this.running = false;
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
                this.animId = null;
            }
        }

        loop() {
            if (!this.running) return;

            const now = performance.now();
            const dt = (now - this.lastTime) / 1000;
            this.lastTime = now;
            this.time += dt;

            // Rotación de la esfera (según preset de mood)
            const p = currentPreset;
            if (isListening) {
                this.rotationY += dt * p.listenRotSpeed;
            } else {
                this.rotationY += dt * p.idleRotSpeed;
            }

            this.draw();
            this.animId = requestAnimationFrame(() => this.loop());
        }

        draw() {
            const ctx = this.ctx;
            const { centerX, centerY, radius, size } = this;

            // Limpiar
            ctx.clearRect(0, 0, size, size);

            // Sombra oscura detrás de la esfera (contraste con fondo claro)
            const shadow = ctx.createRadialGradient(centerX + 2, centerY + 4, radius * 0.3, centerX + 2, centerY + 4, radius * 1.3);
            shadow.addColorStop(0, 'rgba(30, 20, 50, 0.18)');
            shadow.addColorStop(0.6, 'rgba(30, 20, 50, 0.06)');
            shadow.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = shadow;
            ctx.fillRect(0, 0, size, size);

            // Glow de color (resplandor de la esfera)
            const glowColor = getCyclicColor(this.time, 0);
            const glowAlpha = isListening ? 0.25 : 0.15;
            const glow = ctx.createRadialGradient(centerX, centerY, radius * 0.1, centerX, centerY, radius * 1.5);
            glow.addColorStop(0, `rgba(${glowColor.r}, ${glowColor.g}, ${glowColor.b}, ${glowAlpha})`);
            glow.addColorStop(0.5, `rgba(${glowColor.r}, ${glowColor.g}, ${glowColor.b}, ${glowAlpha * 0.3})`);
            glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = glow;
            ctx.fillRect(0, 0, size, size);

            // Calcular posiciones 3D → 2D de cada partícula
            const projected = [];
            const cosR = Math.cos(this.rotationY);
            const sinR = Math.sin(this.rotationY);

            for (const p of this.particles) {
                p.update(this.time, isListening);
                const pos = p.getPosition(radius);

                // Rotación en Y
                const rx = pos.x * cosR - pos.z * sinR;
                const rz = pos.x * sinR + pos.z * cosR;
                const ry = pos.y;

                // Efecto "gota": radio varía según preset de mood
                const dropEffect = 1 + Math.sin(this.time * p.radiusSpeed + p.radiusOffset) * (isListening ? currentPreset.listenDropAmp : currentPreset.idleDropAmp);

                const screenX = centerX + rx * dropEffect;
                const screenY = centerY + ry * dropEffect;

                // Profundidad para tamaño y opacidad
                const depth = (rz / radius + 1) / 2; // 0 (atrás) a 1 (frente)

                projected.push({
                    x: screenX,
                    y: screenY,
                    z: rz,
                    depth,
                    particle: p
                });
            }

            // Ordenar por profundidad (pintar los de atrás primero)
            projected.sort((a, b) => a.z - b.z);

            // Dibujar partículas
            for (const pp of projected) {
                const p = pp.particle;
                const color = getCyclicColor(this.time, p.colorOffset);

                // Tamaño según profundidad
                const depthScale = 0.4 + pp.depth * 0.6;
                const sizeMultiplier = isListening ? 1.3 : 1;
                const dotSize = p.baseSize * depthScale * sizeMultiplier;

                // Opacidad según profundidad
                const alpha = p.baseAlpha * (0.3 + pp.depth * 0.7) * (isListening ? 1 : 0.85);

                // Dibujar punto con brillo (efecto gota de agua)
                ctx.beginPath();
                ctx.arc(pp.x, pp.y, dotSize, 0, Math.PI * 2);

                // Gradiente radial para efecto gota brillante
                const gradient = ctx.createRadialGradient(
                    pp.x - dotSize * 0.3, pp.y - dotSize * 0.3, 0,
                    pp.x, pp.y, dotSize
                );
                gradient.addColorStop(0, `rgba(255, 255, 255, ${alpha * 0.9})`);
                gradient.addColorStop(0.3, `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`);
                gradient.addColorStop(1, `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha * 0.3})`);

                ctx.fillStyle = gradient;
                ctx.fill();
            }
        }

        destroy() {
            this.stop();
        }
    }

    // Crear orb en un contenedor
    function createOrb(containerId, defaultSize) {
        const container = document.getElementById(containerId);
        if (!container) return null;

        // Limpiar
        container.innerHTML = '';

        // Usar el tamaño real del contenedor (ancho o alto, el menor)
        const w = container.offsetWidth;
        const h = container.offsetHeight;
        const size = Math.min(w, h) || w || h || defaultSize;

        // Crear canvas
        const canvas = document.createElement('canvas');
        canvas.style.display = 'block';
        container.appendChild(canvas);

        const orb = new Orb(canvas, size);
        orb.start();

        return {
            id: containerId,
            container,
            orb,
            defaultSize
        };
    }

    // Crear mini orb directamente en un elemento DOM (para avatares de mensajes)
    function createOrbInElement(container, size) {
        container.innerHTML = '';
        const canvas = document.createElement('canvas');
        canvas.style.display = 'block';
        container.appendChild(canvas);
        const orb = new Orb(canvas, size);
        orb.start();
        return orb;
    }

    // Crear orb principal — esperar a que el layout esté listo
    function initMainOrb() {
        const container = document.getElementById('orb-container');
        if (container && container.offsetWidth > 0) {
            const mainOrb = createOrb('orb-container', 140);
            if (mainOrb) orbInstances.push(mainOrb);
        } else {
            // Layout aún no listo, reintentar
            requestAnimationFrame(initMainOrb);
        }
    }
    initMainOrb();

    // API pública: controlar estado listening
    window.orbSetListening = function(listening) {
        isListening = listening;
    };

    // API pública: cambiar preset según mood
    window.orbSetMoodPreset = function(presetKey) {
        if (MOOD_PRESETS[presetKey]) {
            currentPreset = MOOD_PRESETS[presetKey];
        }
    };

    // API pública: crear mini orb
    window.orbCreateMini = function() {
        const existing = orbInstances.find(o => o && o.id === 'orb-container-mini');
        if (existing) return;

        const miniOrb = createOrb('orb-container-mini', 56);
        if (miniOrb) orbInstances.push(miniOrb);
    };

    // API pública: crear orb en el header del chat
    window.orbCreateChatHeader = function() {
        const existing = orbInstances.find(o => o && o.id === 'orb-container-chat-header');
        if (existing) return;

        const chatOrb = createOrb('orb-container-chat-header', 40);
        if (chatOrb) orbInstances.push(chatOrb);
    };

    // API pública: crear orb en el nav del plan
    window.orbCreateNav = function() {
        const existing = orbInstances.find(o => o && o.id === 'orb-container-nav');
        if (existing) return;

        const navOrb = createOrb('orb-container-nav', 56);
        if (navOrb) orbInstances.push(navOrb);
    };

    // Crear orb del login — igual que el principal
    function initLoginOrb() {
        const container = document.getElementById('login-orb-container');
        if (container && container.offsetWidth > 0) {
            const loginOrb = createOrb('login-orb-container', 200);
            if (loginOrb) orbInstances.push(loginOrb);
        } else if (container) {
            requestAnimationFrame(initLoginOrb);
        }
    }
    initLoginOrb();

    // API pública: tintar colores del orb con el mood (sutil)
    window.orbSetMoodTint = function(r, g, b) {
        moodTint = { r, g, b };
    };

    // API pública: crear mini orb en un elemento DOM (para avatares de chat)
    window.orbCreateInElement = function(container, size) {
        return createOrbInElement(container, size || 28);
    };
})();
