/**
 * ============================================================================
 * MERKI — Asistente de Voz y Avatar para MercAPP IS2 (v3.5 Hybrid Engine)
 * ============================================================================
 * 1. Grabador de Audio PCM nativo con Web Audio API (compatible con TODOS los navegadores)
 * 2. Transcripción robusta en backend (/api/merki/transcribe) sin fallas de red del navegador
 * 3. Detección continua de voz (VAD) y auto-envío al terminar de hablar
 * 4. Analizador de decibeles en tiempo real: Las ondas reaccionan físicamente a tu voz
 * 5. Síntesis de voz masculina en pesos colombianos (/api/merki/ask)
 * 6. Sugerencias dinámicas adaptadas al negocio (/api/merki/suggestions)
 */

(function () {
    'use strict';

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    const synth = window.speechSynthesis || null;

    // Función auxiliar para codificar PCM Float32 a WAV 16-bit 16kHz estándar
    function encodeWAV(samples, sampleRate) {
        const buffer = new ArrayBuffer(44 + samples.length * 2);
        const view = new DataView(buffer);

        const writeString = (offset, string) => {
            for (let i = 0; i < string.length; i++) {
                view.setUint8(offset + i, string.charCodeAt(i));
            }
        };

        /* RIFF identifier */
        writeString(0, 'RIFF');
        /* file length */
        view.setUint32(4, 36 + samples.length * 2, true);
        /* RIFF type */
        writeString(8, 'WAVE');
        /* format chunk identifier */
        writeString(12, 'fmt ');
        /* format chunk length */
        view.setUint32(16, 16, true);
        /* sample format (raw PCM) */
        view.setUint16(20, 1, true);
        /* channel count (mono) */
        view.setUint16(22, 1, true);
        /* sample rate */
        view.setUint32(24, sampleRate, true);
        /* byte rate (sample rate * block align) */
        view.setUint32(28, sampleRate * 2, true);
        /* block align (channel count * bytes per sample) */
        view.setUint16(32, 2, true);
        /* bits per sample */
        view.setUint16(34, 16, true);
        /* data chunk identifier */
        writeString(36, 'data');
        /* data chunk length */
        view.setUint32(40, samples.length * 2, true);

        // PCM 16-bit
        let offset = 44;
        for (let i = 0; i < samples.length; i++, offset += 2) {
            let s = Math.max(-1, Math.min(1, samples[i]));
            view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        }

        return new Blob([view], { type: 'audio/wav' });
    }

    const Merki = {
        state: 'idle', // 'idle' | 'listening' | 'thinking' | 'speaking'
        recognition: null,
        isRecognizing: false,
        shouldKeepListening: true,
        isSpeakingTTS: false,
        micStream: null,
        audioCtx: null,
        analyser: null,
        scriptProcessor: null,
        hasMicPermission: false,
        selectedVoice: null,
        silenceTimer: null,
        ignoreWakeWordUntil: 0,

        // Anti-eco y prevención de auto-escucha
        ttsCooldownUntil: 0,
        lastBotResponseText: '',
        noiseFloor: 12,

        // Grabador PCM en memoria con pre-buffer circular para capturar la primera sílaba
        isRecordingAudio: false,
        recordedChunks: [],
        ringBuffer: [],
        maxRingBufferLength: 4, // ~370ms de pre-buffer
        speechDetected: false,
        lastVoiceTime: 0,
        vadCheckInterval: null,

        dom: {},

        init() {
            this.buildDOM();
            this.cacheElements();
            this.initSpeechSynthesis();
            this.setupRecognition();
            this.bindEvents();
            this.startBlinkLoop();
            this.loadDynamicSuggestions();

            // Verificar permisos del micrófono al cargar la página
            this.checkInitialPermissions();

            console.log('🤖 [Merki] Asistente de voz híbrido inicializado con éxito.');
        },

        // ========================================================
        // CONSTRUCCIÓN DEL DOM
        // ========================================================
        buildDOM() {
            if (document.getElementById('merkiWidgetRoot')) return;

            const root = document.createElement('div');
            root.id = 'merkiWidgetRoot';
            root.innerHTML = `
                <!-- Botón Flotante Launcher -->
                <button type="button" class="merki-launcher" id="merkiLauncherBtn" title="Merki (Habla con tu asistente)">
                    <div class="merki-launcher-hint" id="merkiLauncherHint">
                        🎙️ Toca aquí para hablar con Merki
                    </div>
                    <div class="merki-launcher-avatar" id="merkiLauncherAvatar">
                        <div class="merki-mini-eyes">
                            <div class="merki-mini-eye"></div>
                            <div class="merki-mini-eye"></div>
                        </div>
                        <div class="merki-mini-mouth"></div>
                        <div class="merki-mini-mic" title="Micrófono">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                                <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                            </svg>
                        </div>
                    </div>
                </button>

                <!-- Overlay & Modal del Asistente -->
                <div class="merki-overlay" id="merkiOverlay" role="dialog" aria-modal="true">
                    <div class="merki-modal">
                        <button type="button" class="merki-btn-close" id="merkiCloseBtn" title="Cerrar">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                        </button>

                        <!-- Avatar: Pantalla Redonda Negra con Ojos y Boca Neón -->
                        <div class="merki-robot-container" id="merkiRobot">
                            <div class="merki-screen-round" id="merkiScreen">
                                <div class="merki-eyes-row" id="merkiEyes">
                                    <div class="merki-eye"></div>
                                    <div class="merki-eye"></div>
                                </div>
                                <div class="merki-mouth" id="merkiMouth"></div>
                            </div>
                        </div>

                        <!-- Estado y Ondas de Audio -->
                        <div class="merki-status-text" id="merkiStatus">
                            <span class="status-dot"></span>
                            <span id="merkiStatusLabel">TE ESCUCHO...</span>
                        </div>

                        <div class="merki-audio-wave" id="merkiAudioWave">
                            <div class="wave-bar"></div>
                            <div class="wave-bar"></div>
                            <div class="wave-bar"></div>
                            <div class="wave-bar"></div>
                            <div class="wave-bar"></div>
                        </div>

                        <!-- Alerta informativa de micrófono si está bloqueado -->
                        <div class="merki-mic-alert" id="merkiMicAlert">
                            <span style="font-size: 1.4rem;">🎙️</span>
                            <div id="merkiMicAlertMsg">
                                <strong>Micrófono desactivado:</strong> Por favor haz clic en el candado de la barra de dirección y activa el micrófono para hablar con Merki.
                            </div>
                        </div>

                        <!-- Conversación -->
                        <div class="merki-conversation-box" id="merkiConvo">
                            <div class="merki-bubble merki-bubble-bot">
                                ¡Hola! Soy <strong>Merki</strong>. Habla conmigo directamente o usa el botón de micrófono, responderé tu pregunta de inmediato.
                            </div>
                        </div>

                        <!-- Sugerencias dinámicas según la tienda -->
                        <div class="merki-suggestions" id="merkiSuggestions">
                            <!-- Se cargan dinámicamente desde /api/merki/suggestions -->
                        </div>

                        <!-- Input y Botones -->
                        <form class="merki-input-bar" id="merkiInputForm" onsubmit="return false;">
                            <input type="text" id="merkiTextInput" class="merki-text-input" placeholder="Habla o escribe tu pregunta..." autocomplete="off">
                            <button type="button" class="merki-btn-mic active" id="merkiMicBtn" title="Toca para grabar / enviar voz">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                                    <line x1="12" y1="19" x2="12" y2="23"></line>
                                    <line x1="8" y1="23" x2="16" y2="23"></line>
                                </svg>
                            </button>
                            <button type="submit" class="merki-btn-send" id="merkiSendBtn" title="Enviar pregunta">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <line x1="22" y1="2" x2="11" y2="13"></line>
                                    <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                                </svg>
                            </button>
                        </form>
                    </div>
                </div>
            `;
            document.body.appendChild(root);
        },

        cacheElements() {
            this.dom.launcher = document.getElementById('merkiLauncherBtn');
            this.dom.launcherHint = document.getElementById('merkiLauncherHint');
            this.dom.overlay = document.getElementById('merkiOverlay');
            this.dom.closeBtn = document.getElementById('merkiCloseBtn');
            this.dom.robot = document.getElementById('merkiRobot');
            this.dom.screen = document.getElementById('merkiScreen');
            this.dom.eyes = document.getElementById('merkiEyes');
            this.dom.mouth = document.getElementById('merkiMouth');
            this.dom.status = document.getElementById('merkiStatus');
            this.dom.statusLabel = document.getElementById('merkiStatusLabel');
            this.dom.audioWave = document.getElementById('merkiAudioWave');
            this.dom.waveBars = document.querySelectorAll('.merki-audio-wave .wave-bar');
            this.dom.micAlert = document.getElementById('merkiMicAlert');
            this.dom.micAlertMsg = document.getElementById('merkiMicAlertMsg');
            this.dom.convo = document.getElementById('merkiConvo');
            this.dom.suggestions = document.getElementById('merkiSuggestions');
            this.dom.inputForm = document.getElementById('merkiInputForm');
            this.dom.textInput = document.getElementById('merkiTextInput');
            this.dom.micBtn = document.getElementById('merkiMicBtn');
            this.dom.sendBtn = document.getElementById('merkiSendBtn');
        },

        // ========================================================
        // CHIME SÓNICO DE ACTIVACIÓN (Web Audio API)
        // ========================================================
        playActivationChime() {
            try {
                const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
                if (!AudioCtxClass) return;
                const ctx = new AudioCtxClass();
                const now = ctx.currentTime;

                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);

                osc.type = 'sine';
                osc.frequency.setValueAtTime(587.33, now);
                osc.frequency.setValueAtTime(880, now + 0.1);

                gain.gain.setValueAtTime(0.2, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);

                osc.start(now);
                osc.stop(now + 0.38);
            } catch (e) {}
        },

        // ========================================================
        // FLUJO DE MICRÓFONO Y GRABADOR DE AUDIO PCM (UNIVERSAL)
        // ========================================================
        async checkInitialPermissions() {
            if (navigator.permissions && navigator.permissions.query) {
                try {
                    const status = await navigator.permissions.query({ name: 'microphone' });
                    if (status.state === 'granted') {
                        this.hasMicPermission = true;
                        if (this.dom.launcherHint) this.dom.launcherHint.classList.remove('visible');
                        await this.initMicrophoneStream(false);
                    } else if (status.state === 'prompt') {
                        if (this.dom.launcherHint) this.dom.launcherHint.classList.add('visible');
                    } else if (status.state === 'denied') {
                        this.showMicAlert('<strong>⚠️ Micrófono bloqueado:</strong> Permite el acceso al micrófono en el candado de la barra del navegador.');
                    }

                    status.onchange = async () => {
                        if (status.state === 'granted') {
                            this.hasMicPermission = true;
                            if (this.dom.launcherHint) this.dom.launcherHint.classList.remove('visible');
                            await this.initMicrophoneStream(false);
                        }
                    };
                    return;
                } catch (e) {}
            }

            if (localStorage.getItem('merki_mic_granted') === 'true') {
                await this.initMicrophoneStream(false);
            } else if (this.dom.launcherHint) {
                this.dom.launcherHint.classList.add('visible');
            }
        },

        async initMicrophoneStream(userGesture = false) {
            if (this.micStream) return true;
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                console.warn('🤖 [Merki] getUserMedia no disponible.');
                return false;
            }

            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true
                    }
                });

                this.micStream = stream;
                this.hasMicPermission = true;
                localStorage.setItem('merki_mic_granted', 'true');
                if (this.dom.launcherHint) this.dom.launcherHint.classList.remove('visible');
                if (this.dom.micAlert) this.dom.micAlert.classList.remove('visible');

                // Conectar Web Audio: Analizador de Decibeles + Grabador PCM
                try {
                    const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
                    if (AudioCtxClass) {
                        this.audioCtx = new AudioCtxClass();
                        const source = this.audioCtx.createMediaStreamSource(stream);

                        // 1. Analizador para animación física de las ondas LED (sin retorno a parlantes)
                        this.analyser = this.audioCtx.createAnalyser();
                        this.analyser.fftSize = 64;
                        this.analyser.smoothingTimeConstant = 0.5;
                        source.connect(this.analyser);
                        this.startAudioVisualizerLoop();

                        // 2. Procesador PCM para grabación directa en memoria
                        const bufferSize = 4096;
                        this.scriptProcessor = this.audioCtx.createScriptProcessor(bufferSize, 1, 1);
                        source.connect(this.scriptProcessor);

                        // CRUCIAL: Conectar a un destino virtual en memoria (NUNCA a audioCtx.destination)
                        // Esto garantiza 100% que el audio del micrófono jamás saldrá por los altavoces de la computadora.
                        try {
                            const dummyDest = this.audioCtx.createMediaStreamDestination();
                            this.scriptProcessor.connect(dummyDest);
                        } catch (destErr) {
                            const zeroGain = this.audioCtx.createGain();
                            zeroGain.gain.setValueAtTime(0, this.audioCtx.currentTime);
                            this.scriptProcessor.connect(zeroGain);
                        }

                        this.scriptProcessor.onaudioprocess = (e) => {
                            // Si el bot está hablando o estamos en el periodo de enfriamiento anti-eco, descartar
                            if (this.isSpeakingTTS || Date.now() < this.ttsCooldownUntil) return;

                            const inputData = e.inputBuffer.getChannelData(0);
                            const chunk = new Float32Array(inputData.length);
                            chunk.set(inputData);

                            // Mantener siempre el pre-buffer circular para capturar la primera sílaba intacta
                            this.ringBuffer.push(chunk);
                            if (this.ringBuffer.length > this.maxRingBufferLength) {
                                this.ringBuffer.shift();
                            }

                            if (this.isRecordingAudio) {
                                this.recordedChunks.push(chunk);
                            }
                        };

                        this.startVADLoop();
                    }
                } catch (audioErr) {
                    console.warn('🤖 [Merki] Web Audio inicializado con advertencia:', audioErr);
                }

                // Iniciar reconocedor de navegador en segundo plano si está disponible
                this.startRecognition();
                return true;
            } catch (err) {
                console.warn('🤖 [Merki] Permiso micrófono no concedido:', err.name, err.message);
                if (userGesture) {
                    this.showMicAlert('<strong>⚠️ Micrófono no autorizado:</strong> Haz clic en el ícono de candado en la barra de tu navegador y activa el micrófono.');
                }
                return false;
            }
        },

        startAudioVisualizerLoop() {
            if (!this.analyser) return;
            const dataArray = new Uint8Array(this.analyser.frequencyBinCount);

            const tick = () => {
                // Si el bot está hablando o en enfriamiento, las barras se quedan al mínimo y no reaccionan al audio de Merki
                if (this.isSpeakingTTS || Date.now() < this.ttsCooldownUntil) {
                    if (this.dom.waveBars) {
                        this.dom.waveBars.forEach(b => b.style.height = '5px');
                    }
                    requestAnimationFrame(tick);
                    return;
                }

                if (this.analyser && this.dom.waveBars && this.dom.waveBars.length > 0 && this.state === 'listening') {
                    this.analyser.getByteFrequencyData(dataArray);

                    let sum = 0;
                    for (let i = 0; i < dataArray.length; i++) {
                        sum += dataArray[i];
                    }
                    const avg = sum / dataArray.length;

                    // Ajustar piso de ruido dinámicamente si no hay voz activa
                    if (!this.speechDetected) {
                        this.noiseFloor = this.noiseFloor * 0.95 + avg * 0.05;
                    }

                    // Mapear decibeles reales a la altura de las barras cian
                    this.dom.waveBars.forEach((bar, idx) => {
                        const val = dataArray[idx * 3] || avg;
                        const h = Math.max(5, Math.min(26, Math.round((val / 255) * 24) + 5));
                        bar.style.height = `${h}px`;
                    });

                    // Umbral dinámico adaptativo de voz humana (supera el ruido ambiental)
                    const voiceThreshold = Math.max(14, this.noiseFloor + 7);
                    if (avg > voiceThreshold) {
                        this.lastVoiceTime = Date.now();
                        if (!this.speechDetected) {
                            this.speechDetected = true;
                            if (!this.isRecordingAudio && this.state === 'listening') {
                                this.startRecordingPCM();
                            }
                        }
                        if (this.dom.statusLabel && this.dom.statusLabel.textContent !== 'TRANSCRIBIENDO...') {
                            this.dom.statusLabel.textContent = 'OYENDO TU VOZ...';
                        }
                    }
                }
                requestAnimationFrame(tick);
            };

            tick();
        },

        startVADLoop() {
            clearInterval(this.vadCheckInterval);
            this.vadCheckInterval = setInterval(() => {
                if (this.isRecordingAudio && this.speechDetected && !this.isSpeakingTTS && Date.now() >= this.ttsCooldownUntil) {
                    const elapsedSinceVoice = Date.now() - this.lastVoiceTime;
                    // Pausa de silencio recortada a 420ms para respuesta rápida sin retrasos
                    if (elapsedSinceVoice > 420 && this.state !== 'thinking') {
                        console.log('🤖 [Merki VAD] Fin de habla detectado -> Enviando audio...');
                        this.stopAndProcessRecordedAudio();
                    }
                }
            }, 75);
        },

        startRecordingPCM() {
            if (this.isSpeakingTTS || Date.now() < this.ttsCooldownUntil) return;
            this.isRecordingAudio = true;
            // Pre-cargar los ~370ms del ring buffer para que no se recorte el inicio de la pregunta
            this.recordedChunks = this.ringBuffer.map(c => new Float32Array(c));
            this.lastVoiceTime = Date.now();
            if (this.dom.micBtn) this.dom.micBtn.classList.add('active');
        },

        cancelRecordingPCM() {
            this.isRecordingAudio = false;
            this.recordedChunks = [];
            this.speechDetected = false;
        },

        async stopAndProcessRecordedAudio() {
            if (!this.isRecordingAudio) return;
            this.isRecordingAudio = false;
            this.speechDetected = false;

            if (this.recordedChunks.length === 0) return;

            // Concatenar todos los buffers Float32
            let totalLength = 0;
            for (let i = 0; i < this.recordedChunks.length; i++) {
                totalLength += this.recordedChunks[i].length;
            }

            const merged = new Float32Array(totalLength);
            let offset = 0;
            for (let i = 0; i < this.recordedChunks.length; i++) {
                merged.set(this.recordedChunks[i], offset);
                offset += this.recordedChunks[i].length;
            }
            this.recordedChunks = [];

            // Si es menor a 0.25 segundos, ignorar ruido accidental
            const sampleRate = (this.audioCtx && this.audioCtx.sampleRate) ? this.audioCtx.sampleRate : 44100;
            if (totalLength < sampleRate * 0.25) {
                return;
            }

            // Submuestrear a 16000 Hz si la tarjeta de audio graba a 44.1k o 48k
            const targetSampleRate = 16000;
            const downsampled = this.downsampleBuffer(merged, sampleRate, targetSampleRate);
            const wavBlob = encodeWAV(downsampled, targetSampleRate);

            console.log('🤖 [Merki Audio] WAV generado:', wavBlob.size, 'bytes. Enviando...');
            if (this.state === 'listening') {
                this.dom.statusLabel.textContent = 'CONSULTANDO...';
            }

            // Enviar a transcripción + respuesta 1-shot al backend
            try {
                const formData = new FormData();
                formData.append('audio', wavBlob, 'audio.wav');
                formData.append('store_id', window.MERKI_STORE_ID || 1);

                const res = await fetch('/api/merki/transcribe', {
                    method: 'POST',
                    body: formData
                });

                const data = await res.json();
                if (data.success && data.text && data.text.trim()) {
                    const transcribedText = data.text.trim();
                    console.log('🤖 [Merki Backend STT] Transcripción:', transcribedText);

                    // Descartar si coincide con la voz del bot (anti-eco)
                    if (this.isEchoOfBot(transcribedText)) {
                        if (this.state === 'listening') {
                            this.dom.statusLabel.textContent = 'TE ESCUCHO...';
                        }
                        return;
                    }

                    // Si es sólo la palabra de activación ("Oye Merki"), saludar cordialmente
                    if (this.isOnlyWakeWord(transcribedText)) {
                        this.dom.textInput.value = '';
                        const greeting = "¡Hola! ¿En qué te puedo colaborar hoy?";
                        this.addMessage(greeting, 'bot');
                        this.speak(greeting);
                        return;
                    }

                    this.dom.textInput.value = '';
                    this.addMessage(transcribedText, 'user');

                    // Si ya viene la respuesta procesada directamente del backend (ultra rápida)
                    if (data.response) {
                        this.addMessage(data.response, 'bot');
                        this.speak(data.response);
                    } else {
                        this.handleCapturedQuestion(transcribedText);
                    }
                } else {
                    if (this.state === 'listening') {
                        this.dom.statusLabel.textContent = 'TE ESCUCHO...';
                    }
                }
            } catch (err) {
                console.warn('🤖 [Merki] Error en transcripción backend:', err);
                if (this.state === 'listening') {
                    this.dom.statusLabel.textContent = 'TE ESCUCHO...';
                }
            }
        },

        downsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
            if (outputSampleRate === inputSampleRate) {
                return buffer;
            }
            const sampleRateRatio = inputSampleRate / outputSampleRate;
            const newLength = Math.round(buffer.length / sampleRateRatio);
            const result = new Float32Array(newLength);
            let offsetResult = 0;
            let offsetBuffer = 0;
            while (offsetResult < result.length) {
                const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
                let accum = 0, count = 0;
                for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
                    accum += buffer[i];
                    count++;
                }
                result[offsetResult] = count > 0 ? accum / count : buffer[offsetBuffer];
                offsetResult++;
                offsetBuffer = nextOffsetBuffer;
            }
            return result;
        },

        showMicAlert(htmlMsg) {
            if (this.dom.micAlert) {
                if (this.dom.micAlertMsg) this.dom.micAlertMsg.innerHTML = htmlMsg;
                this.dom.micAlert.classList.add('visible');
            }
        },

        // ========================================================
        // RECONOCIMIENTO DE VOZ EN TIEMPO REAL (NAVEGADOR)
        // ========================================================
        setupRecognition() {
            if (!SpeechRecognition) return;

            const rec = new SpeechRecognition();
            rec.continuous = true;
            rec.interimResults = true;
            rec.lang = 'es-419';
            rec.maxAlternatives = 1;

            rec.onstart = () => {
                this.isRecognizing = true;
                if (this.dom.launcher) this.dom.launcher.classList.add('listening');
                if (this.state === 'listening') {
                    this.dom.statusLabel.textContent = 'TE ESCUCHO...';
                }
            };

            rec.onresult = (event) => {
                if (this.isSpeakingTTS || Date.now() < this.ttsCooldownUntil) return;

                let interimTranscript = '';
                let finalTranscript = '';

                for (let i = event.resultIndex; i < event.results.length; ++i) {
                    const res = event.results[i];
                    if (res.isFinal) {
                        finalTranscript += res[0].transcript;
                    } else {
                        interimTranscript += res[0].transcript;
                    }
                }

                const spokenText = (finalTranscript || interimTranscript).trim();
                if (!spokenText) return;

                // Anti-eco: Si coincide con lo que el bot acaba de decir, ignorar
                if (this.isEchoOfBot(spokenText)) return;

                const isModalOpen = this.dom.overlay.classList.contains('active');

                // Si estamos dentro del período de enfriamiento tras la invocación, ignorar el residuo
                if (Date.now() < this.ignoreWakeWordUntil) {
                    return;
                }

                // CASO 1: Modal CERRADA -> Detección de Wake-Word ("Oye Merki")
                if (!isModalOpen) {
                    if (this.matchesWakeWord(spokenText)) {
                        console.log('🤖 [Merki] Wake-word detectada:', spokenText);
                        this.playActivationChime();
                        this.ignoreWakeWordUntil = Date.now() + 1500;
                        this.openModal();

                        const query = this.extractQueryFromWakeWord(spokenText);
                        if (query && query.length > 2 && !this.isOnlyWakeWord(query)) {
                            this.dom.textInput.value = query;
                            this.handleCapturedQuestion(query);
                        } else {
                            this.dom.textInput.value = '';
                            this.setState('listening');
                        }
                    }
                    return;
                }

                // CASO 2: Modal ABIERTA -> El usuario está hablando
                if (this.isOnlyWakeWord(spokenText)) {
                    this.dom.textInput.value = '';
                    this.setState('listening');
                    this.dom.statusLabel.textContent = 'TE ESCUCHO...';
                    return;
                }

                let queryText = spokenText;
                if (this.matchesWakeWord(spokenText)) {
                    const extracted = this.extractQueryFromWakeWord(spokenText);
                    if (extracted && extracted.length > 1) {
                        queryText = extracted;
                    }
                }

                if (this.isOnlyWakeWord(queryText)) {
                    this.dom.textInput.value = '';
                    return;
                }

                this.dom.textInput.value = queryText;
                this.setState('listening');
                this.dom.statusLabel.textContent = 'TRANSCRIBIENDO...';

                // Auto-envío ultra rápido (si ya es final, en solo 200ms)
                clearTimeout(this.silenceTimer);
                const delay = finalTranscript ? 200 : 750;
                this.silenceTimer = setTimeout(() => {
                    const textToSend = this.dom.textInput.value.trim();
                    if (textToSend && textToSend.length > 2 && !this.isOnlyWakeWord(textToSend) && !this.isSpeakingTTS && this.state !== 'thinking') {
                        if (this.isEchoOfBot(textToSend)) return;
                        console.log('🤖 [Merki] Fin de habla detectado (Browser STT):', textToSend);
                        this.cancelRecordingPCM();
                        this.dom.textInput.value = '';
                        this.handleCapturedQuestion(textToSend);
                    }
                }, delay);
            };

            rec.onerror = (event) => {
                // Silenciar error 'network' o 'no-speech' para no alarmar al usuario,
                // ya que el motor VAD y /api/merki/transcribe actúan como respaldo perfecto.
                if (event.error === 'network' || event.error === 'no-speech' || event.error === 'aborted') {
                    return;
                }

                if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                    this.hasMicPermission = false;
                    this.showMicAlert('<strong>⚠️ Permiso de micrófono requerido:</strong> Haz clic en el candado junto a la URL y selecciona "Permitir".');
                }
            };

            rec.onend = () => {
                this.isRecognizing = false;
                if (this.shouldKeepListening && !this.isSpeakingTTS) {
                    setTimeout(() => this.startRecognition(), 300);
                }
            };

            this.recognition = rec;
        },

        startRecognition() {
            if (!this.recognition || this.isRecognizing) return;
            try {
                this.recognition.start();
                this.isRecognizing = true;
            } catch (e) {}
        },

        stopRecognition() {
            if (!this.recognition || !this.isRecognizing) return;
            try {
                this.recognition.stop();
            } catch (e) {}
            this.isRecognizing = false;
        },

        isEchoOfBot(text) {
            if (!this.lastBotResponseText || !text) return false;
            const clean = text.toLowerCase()
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()¿?¡!]/g, ' ')
                .trim();
            if (clean.length < 3) return false;

            if (this.lastBotResponseText.includes(clean)) {
                console.log('🤖 [Merki Anti-Eco] Frase ignorada por coincidir con la respuesta de Merki:', clean);
                return true;
            }

            const words = clean.split(' ').filter(w => w.length > 3);
            if (words.length >= 2) {
                const matchCount = words.filter(w => this.lastBotResponseText.includes(w)).length;
                if (matchCount / words.length > 0.5) {
                    console.log('🤖 [Merki Anti-Eco] Frase ignorada por alta similitud con la voz de Merki:', clean);
                    return true;
                }
            }
            return false;
        },

        matchesWakeWord(text) {
            if (!text) return false;
            const clean = text.toLowerCase()
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()¿?¡!]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            const wakeWords = [
                'oye merki', 'oye merqui', 'oye merky', 'hola merki', 'hola merqui', 'hola merky',
                'hey merki', 'hey merqui', 'ey merki', 'ey merqui',
                'merki', 'merqui', 'merky', 'merck', 'merke', 'mequi'
            ];
            return wakeWords.some(w => clean.includes(w));
        },

        extractQueryFromWakeWord(text) {
            if (!text) return '';
            const clean = text.toLowerCase()
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()¿?¡!]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            const wakePrefix = /^(oye|hola|hey|ey|ok)?\s*(merki|merqui|merky|merck|merke|mequi)\s*/i;
            return clean.replace(wakePrefix, '').trim();
        },

        isOnlyWakeWord(text) {
            if (!text) return true;
            const query = this.extractQueryFromWakeWord(text);
            return !query || query.length <= 1;
        },

        // ========================================================
        // SÍNTESIS DE VOZ MASCULINA ATRACTIVA EN PESOS
        // ========================================================
        initSpeechSynthesis() {
            if (!synth) return;

            const pickVoice = () => {
                const voices = synth.getVoices();
                if (!voices || !voices.length) return;

                const spanishVoices = voices.filter(v => v.lang.startsWith('es'));
                const maleKeywords = ['jorge', 'alonso', 'raul', 'diego', 'pablo', 'carlos', 'mateo', 'miguel', 'david', 'male', 'hombre', 'natural'];

                let bestVoice = spanishVoices.find(v => {
                    const name = v.name.toLowerCase();
                    return maleKeywords.some(k => name.includes(k));
                });

                if (!bestVoice) {
                    bestVoice = spanishVoices.find(v => v.lang.includes('CO') || v.lang.includes('419') || v.lang.includes('MX'));
                }

                if (!bestVoice && spanishVoices.length > 0) {
                    bestVoice = spanishVoices[0];
                }

                this.selectedVoice = bestVoice || voices[0];
            };

            pickVoice();
            if (synth.onvoiceschanged !== undefined) {
                synth.onvoiceschanged = pickVoice;
            }
        },

        speak(text) {
            if (!synth || !text) return;

            synth.cancel();
            this.isSpeakingTTS = true;
            // Bloqueo de captura de audio y VAD mientras habla + cooldown
            this.ttsCooldownUntil = Date.now() + 60000;
            this.stopRecognition();
            this.cancelRecordingPCM();
            this.ringBuffer = [];

            // Guardar texto normalizado para el filtro anti-eco
            this.lastBotResponseText = text.toLowerCase()
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()¿?¡!]/g, ' ')
                .trim();

            // Sanitizar texto: Garantizar que todo valor se pronuncie en "pesos" y NUNCA en "dólares"
            let spokenText = text
                .replace(/<[^>]*>/g, '') // Quitar HTML
                .replace(/\$\s*(\d+([.,]\d+)*)\s*pesos?/gi, '$1 pesos')
                .replace(/\$\s*(\d+([.,]\d+)*)/g, '$1 pesos')
                .replace(/\$/g, ' pesos ');

            const utterance = new SpeechSynthesisUtterance(spokenText);
            if (this.selectedVoice) {
                utterance.voice = this.selectedVoice;
            }
            utterance.lang = this.selectedVoice ? this.selectedVoice.lang : 'es-CO';
            utterance.pitch = 1.05;
            utterance.rate = 1.05;

            utterance.onstart = () => {
                this.setState('speaking');
                this.cancelRecordingPCM();
                this.ringBuffer = [];
            };

            const resumeListening = () => {
                // Período de gracia de 700ms tras el fin físico del sonido para disipar eco y reverberación de parlantes
                this.ttsCooldownUntil = Date.now() + 700;
                setTimeout(() => {
                    this.isSpeakingTTS = false;
                    this.cancelRecordingPCM();
                    this.ringBuffer = [];
                    if (this.state === 'speaking') {
                        this.setState('listening');
                    }
                    if (this.shouldKeepListening) {
                        this.startRecognition();
                    }
                }, 700);
            };

            utterance.onend = resumeListening;
            utterance.onerror = resumeListening;

            synth.speak(utterance);
        },

        // ========================================================
        // SUGERENCIAS DINÁMICAS SEGÚN EL NEGOCIO ACTIVO
        // ========================================================
        async loadDynamicSuggestions() {
            const storeId = window.MERKI_STORE_ID || 1;
            try {
                const res = await fetch(`/api/merki/suggestions?store_id=${storeId}`);
                const data = await res.json();
                if (data.success && data.suggestions && data.suggestions.length > 0) {
                    this.dom.suggestions.innerHTML = '';
                    data.suggestions.forEach(item => {
                        const chip = document.createElement('span');
                        chip.className = 'merki-chip';
                        chip.setAttribute('data-q', item.q);
                        chip.textContent = item.label;
                        chip.addEventListener('click', () => {
                            this.handleCapturedQuestion(item.q);
                        });
                        this.dom.suggestions.appendChild(chip);
                    });
                }
            } catch (err) {
                console.warn('🤖 [Merki] Error cargando sugerencias dinámicas:', err);
            }
        },

        // ========================================================
        // MANEJO DE PREGUNTAS Y CONSULTA AL BACKEND
        // ========================================================
        async handleCapturedQuestion(rawQuestion) {
            if (!rawQuestion || !rawQuestion.trim() || this.isOnlyWakeWord(rawQuestion)) return;
            if (this.isEchoOfBot(rawQuestion)) return;

            this.cancelRecordingPCM();
            this.addMessage(rawQuestion, 'user');

            // Cierre o despedida por voz
            const lower = rawQuestion.toLowerCase();
            if (['adios', 'chao', 'hasta luego', 'cerrar', 'nos vemos', 'gracias'].some(w => lower.includes(w))) {
                const farewell = lower.includes('gracias')
                    ? "¡Con todo el gusto! Recuerda que siempre estoy aquí para apoyarte en la tienda."
                    : "¡Hasta luego! Estaré atento cada vez que me llames diciendo Oye Merki.";
                this.addMessage(farewell, 'bot');
                this.speak(farewell);
                setTimeout(() => this.closeModal(), 3500);
                return;
            }

            this.setState('thinking');

            const storeId = window.MERKI_STORE_ID || 1;

            try {
                const res = await fetch('/api/merki/ask', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        question: rawQuestion,
                        store_id: storeId
                    })
                });

                const data = await res.json();
                const replyText = data.response || "Disculpa, de momento no cuento con esa información pero puedes consultar con uno de nuestros administradores.";

                this.addMessage(replyText, 'bot');
                this.speak(replyText);
            } catch (err) {
                console.error('🤖 [Merki] Error en consulta al backend:', err);
                const fallback = "Disculpa, de momento no cuento con esa información pero puedes consultar con uno de nuestros administradores.";
                this.addMessage(fallback, 'bot');
                this.speak(fallback);
            }
        },

        addMessage(text, sender) {
            const bubble = document.createElement('div');
            bubble.className = `merki-bubble merki-bubble-${sender}`;
            bubble.innerHTML = text;
            this.dom.convo.appendChild(bubble);
            this.dom.convo.scrollTop = this.dom.convo.scrollHeight;
        },

        // ========================================================
        // GESTIÓN DE EVENTOS
        // ========================================================
        bindEvents() {
            // Click en el Launcher flotante
            this.dom.launcher.addEventListener('click', async () => {
                this.playActivationChime();
                await this.openModal();
            });

            // Click en el hint flotante
            if (this.dom.launcherHint) {
                this.dom.launcherHint.style.cursor = 'pointer';
                this.dom.launcherHint.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    this.playActivationChime();
                    await this.openModal();
                });
            }

            // Botón de micrófono dentro del modal (toggle / push-to-talk)
            this.dom.micBtn.addEventListener('click', async () => {
                if (this.isRecordingAudio) {
                    // Si ya estaba grabando, detener y procesar de inmediato
                    await this.stopAndProcessRecordedAudio();
                    this.dom.statusLabel.textContent = 'PROCESANDO...';
                } else {
                    await this.initMicrophoneStream(true);
                    this.startRecordingPCM();
                    this.setState('listening');
                    this.dom.statusLabel.textContent = 'TE ESCUCHO (HABLA AHORA)...';
                }
            });

            // Cerrar modal
            this.dom.closeBtn.addEventListener('click', () => this.closeModal());
            this.dom.overlay.addEventListener('click', (e) => {
                if (e.target === this.dom.overlay) this.closeModal();
            });

            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.dom.overlay.classList.contains('active')) {
                    this.closeModal();
                }
            });

            // Enviar formulario manual (input de texto)
            this.dom.inputForm.addEventListener('submit', (e) => {
                e.preventDefault();
                const q = this.dom.textInput.value.trim();
                if (!q) return;
                this.dom.textInput.value = '';
                this.handleCapturedQuestion(q);
            });

            if (this.dom.sendBtn) {
                this.dom.sendBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const q = this.dom.textInput.value.trim();
                    if (!q) return;
                    this.dom.textInput.value = '';
                    this.handleCapturedQuestion(q);
                });
            }

            // Al hacer clic o interactuar en cualquier parte de la pantalla, inicializar micrófono
            const enableMicOnFirstInteraction = async () => {
                if (!this.micStream && localStorage.getItem('merki_mic_granted') !== 'denied') {
                    await this.initMicrophoneStream(false);
                }
                document.removeEventListener('click', enableMicOnFirstInteraction);
                document.removeEventListener('touchstart', enableMicOnFirstInteraction);
                document.removeEventListener('keydown', enableMicOnFirstInteraction);
            };
            document.addEventListener('click', enableMicOnFirstInteraction);
            document.addEventListener('touchstart', enableMicOnFirstInteraction);
            document.addEventListener('keydown', enableMicOnFirstInteraction);
        },

        async openModal() {
            this.dom.overlay.classList.add('active');
            this.setState('listening');
            this.loadDynamicSuggestions();
            this.dom.textInput.focus();

            // Garantizar que el stream de micrófono esté activo
            if (!this.micStream) {
                await this.initMicrophoneStream(true);
            }
            this.shouldKeepListening = true;
            this.startRecordingPCM();
            this.startRecognition();
        },

        closeModal() {
            this.dom.overlay.classList.remove('active');
            if (synth) synth.cancel();
            this.isSpeakingTTS = false;
            this.isRecordingAudio = false;
            this.setState('idle');

            // Reanudar la escucha en segundo plano
            this.shouldKeepListening = true;
            this.startRecognition();
        },

        // ========================================================
        // ESTADOS DEL AVATAR (OJOS, BOCA, LABELS)
        // ========================================================
        setState(newState) {
            this.state = newState;
            this.dom.robot.className = `merki-robot-container ${newState}`;

            if (newState === 'listening') {
                this.dom.statusLabel.textContent = 'TE ESCUCHO...';
                this.dom.micBtn.classList.add('active');
            } else if (newState === 'thinking') {
                this.dom.statusLabel.textContent = 'CONSULTANDO...';
                this.dom.micBtn.classList.remove('active');
            } else if (newState === 'speaking') {
                this.dom.statusLabel.textContent = 'RESPONDIENDO...';
                this.dom.micBtn.classList.remove('active');
            } else {
                this.dom.statusLabel.textContent = 'LISTO';
                this.dom.micBtn.classList.remove('active');
            }
        },

        startBlinkLoop() {
            const blink = () => {
                if (this.state !== 'listening') {
                    this.dom.eyes.classList.add('blinking');
                    setTimeout(() => {
                        this.dom.eyes.classList.remove('blinking');
                    }, 140);
                }
                const nextBlink = Math.random() * 3500 + 2000;
                setTimeout(blink, nextBlink);
            };
            setTimeout(blink, 2500);
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => Merki.init());
    } else {
        Merki.init();
    }

    window.Merki = Merki;
})();
