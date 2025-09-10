/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import './visual-3d';

// Helper to convert stream to base64
function streamToBase64(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];

    function pump() {
      reader
        .read()
        .then(({done, value}) => {
          if (done) {
            const blob = new Blob(chunks);
            const fileReader = new FileReader();
            fileReader.onload = () => {
              const base64 = (fileReader.result as string).split(',')[1];
              resolve(base64);
            };
            fileReader.onerror = reject;
            fileReader.readAsDataURL(blob);
            return;
          }
          chunks.push(value);
          pump();
        })
        .catch(reject);
    }

    pump();
  });
}

const LANGUAGES = [
  {name: 'English', code: 'en-US'},
  {name: 'Hindi', code: 'hi-IN'},
  {name: 'Bengali', code: 'bn-IN'},
  {name: 'Tamil', code: 'ta-IN'},
  {name: 'Telugu', code: 'te-IN'},
  {name: 'Marathi', code: 'mr-IN'},
  {name: 'Spanish', code: 'es-ES'},
  {name: 'French', code: 'fr-FR'},
  {name: 'German', code: 'de-DE'},
  {name: 'Italian', code: 'it-IT'},
  {name: 'Japanese', code: 'ja-JP'},
  {name: 'Portuguese', code: 'pt-BR'},
  {name: 'Russian', code: 'ru-RU'},
  {name: 'Korean', code: 'ko-KR'},
  {name: 'Chinese (Mandarin)', code: 'zh-CN'},
];

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = 'Tap the mic to speak';
  @state() error = '';
  @state() private mediaRecorder: MediaRecorder | null = null;
  @state() private audioChunks: Blob[] = [];

  // Voice settings state
  @state() private settingsOpen = false;
  @state() private availableVoices: SpeechSynthesisVoice[] = [];
  @state() private selectedVoiceURI = '';
  @state() private voiceRate = 1;
  @state() private voicePitch = 1;

  // Language state
  @state() private selectedLanguage = 'English';
  @state() private selectedLanguageCode = 'en-US';

  // VAD state
  @state() private silenceDetectionHandle: number | null = null;
  @state() private lastSpeechTime = 0;
  private vadAnalyser: AnalyserNode | null = null;

  // Speech queue state
  @state() private sentenceQueue: string[] = [];
  @state() private isSpeaking = false;

  private client: GoogleGenAI;

  // FIX: Cast window to any to allow for webkitAudioContext, which is used for Safari compatibility.
  private inputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 16000});
  // FIX: Cast window to any to allow for webkitAudioContext, which is used for Safari compatibility.
  private outputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();

  static styles = css`
    @keyframes pulse-red {
      0% {
        box-shadow: 0 0 0 0 rgba(200, 0, 0, 0.7);
      }
      70% {
        box-shadow: 0 0 0 20px rgba(200, 0, 0, 0);
      }
      100% {
        box-shadow: 0 0 0 0 rgba(200, 0, 0, 0);
      }
    }

    .title-container {
      position: absolute;
      top: 5vh;
      left: 0;
      right: 0;
      text-align: center;
      color: white;
      z-index: 10;
      font-family: sans-serif;
    }

    .title-container h1 {
      font-size: 3rem;
      margin: 0;
      font-weight: 500;
      letter-spacing: 0.1em;
      text-shadow: 0 0 10px rgba(255, 255, 255, 0.3);
    }

    .title-container p {
      margin-top: 8px;
      font-size: 1rem;
      font-style: italic;
      opacity: 0.8;
    }

    #status {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
      color: white;
      font-family: sans-serif;
      font-size: 1rem;
      opacity: 0.8;
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 10vh;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .mic-button {
      outline: none;
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: white;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.1);
      width: 80px;
      height: 80px;
      cursor: pointer;
      font-size: 24px;
      padding: 0;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease-in-out;
    }

    .mic-button:hover {
      background: rgba(255, 255, 255, 0.2);
    }

    .mic-button.recording {
      background: #c80000;
      border-color: rgba(255, 100, 100, 0.5);
      transform: scale(1.1);
      animation: pulse-red 2s infinite;
    }

    .settings-toggle-button {
      position: absolute;
      bottom: 12vh;
      right: 5vw;
      z-index: 20;
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: white;
      width: 50px;
      height: 50px;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      justify-content: center;
      align-items: center;
      transition: all 0.2s ease-in-out;
    }

    .settings-toggle-button:hover {
      background: rgba(255, 255, 255, 0.2);
    }

    .settings-panel {
      position: absolute;
      bottom: 18vh;
      right: 5vw;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(10px);
      border-radius: 10px;
      padding: 20px;
      color: white;
      font-family: sans-serif;
      z-index: 20;
      width: 300px;
      border: 1px solid rgba(255, 255, 255, 0.2);
    }

    .settings-panel h3 {
      margin-top: 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.3);
      padding-bottom: 10px;
    }

    .settings-panel label {
      display: block;
      margin: 15px 0 5px;
    }

    .settings-panel select {
      width: 100%;
      background: black;
      border: 1px solid rgba(255, 255, 255, 0.3);
      color: white;
      border-radius: 5px;
      padding: 8px;
    }

    .settings-panel option {
      background: black;
      color: white;
    }

    .settings-panel input {
      width: 100%;
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.3);
      color: white;
      border-radius: 5px;
      padding: 8px;
    }

    .language-selector-container {
      position: absolute;
      bottom: 12vh;
      left: 5vw;
      z-index: 20;
    }

    .language-selector-container select {
      background: black;
      color: white;
      border: 1px solid rgba(255, 255, 255, 0.3);
      border-radius: 5px;
      padding: 10px;
      font-size: 1rem;
      cursor: pointer;
    }

    .language-selector-container option {
      background: black;
      color: white;
    }
  `;

  constructor() {
    super();
    this.client = new GoogleGenAI({
      apiKey: process.env.API_KEY,
    });
    this.outputNode.connect(this.outputAudioContext.destination);
    // Voices might load asynchronously
    speechSynthesis.onvoiceschanged = () => this.loadVoices();
    this.loadVoices();
  }

  private loadVoices() {
    this.availableVoices = speechSynthesis.getVoices();
    if (!this.selectedVoiceURI && this.availableVoices.length > 0) {
      // Prioritize high-quality voices if available
      const preferredVoices = this.availableVoices.filter(
        (v) =>
          v.name.includes('Google') ||
          v.name.includes('Microsoft') ||
          v.name.includes('Natural') ||
          v.name.includes('Neural'),
      );

      const defaultVoice = preferredVoices[0] || this.availableVoices[0];

      if (defaultVoice) {
        this.selectedVoiceURI = defaultVoice.voiceURI;
      }
    }
  }

  private updateStatus(msg: string) {
    this.status = msg;
    this.error = '';
  }

  private updateError(msg: string) {
    this.error = msg;
    this.status = '';
  }

  private handleMicClick() {
    if (this.isRecording) {
      this.stopRecordingAndSend();
    } else {
      this.startRecording();
    }
  }

  private async startRecording() {
    if (this.isRecording) return;
    this.audioChunks = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio: true});
      const sourceNode =
        this.inputAudioContext.createMediaStreamSource(stream);
      sourceNode.connect(this.inputNode);

      // Setup VAD
      this.vadAnalyser = this.inputAudioContext.createAnalyser();
      this.vadAnalyser.fftSize = 512;
      sourceNode.connect(this.vadAnalyser);

      this.inputAudioContext.resume();
      this.updateStatus("Listening... I'll respond when you pause.");
      this.isRecording = true;

      this.mediaRecorder = new MediaRecorder(stream);
      this.mediaRecorder.ondataavailable = (event) => {
        this.audioChunks.push(event.data);
      };
      this.mediaRecorder.start();

      this.lastSpeechTime = Date.now();
      this.monitorSilence();
    } catch (err) {
      this.updateError(`Error accessing microphone: ${err.message}`);
    }
  }

  private monitorSilence() {
    if (!this.isRecording || !this.vadAnalyser) return;

    const dataArray = new Uint8Array(this.vadAnalyser.frequencyBinCount);
    this.vadAnalyser.getByteFrequencyData(dataArray);

    let sum = 0;
    for (const amplitude of dataArray) {
      sum += amplitude * amplitude;
    }
    const volume = Math.sqrt(sum / dataArray.length);

    const SILENCE_THRESHOLD = 15; // Sensitivity for silence detection
    const SILENCE_DELAY_MS = 1500; // 1.5 seconds of silence to trigger response

    if (volume > SILENCE_THRESHOLD) {
      this.lastSpeechTime = Date.now();
    }

    if (Date.now() - this.lastSpeechTime > SILENCE_DELAY_MS) {
      this.stopRecordingAndSend();
    } else {
      this.silenceDetectionHandle = requestAnimationFrame(() =>
        this.monitorSilence(),
      );
    }
  }

  private async stopRecordingAndSend() {
    if (!this.isRecording || !this.mediaRecorder) return;

    if (this.silenceDetectionHandle) {
      cancelAnimationFrame(this.silenceDetectionHandle);
      this.silenceDetectionHandle = null;
    }

    this.isRecording = false;
    this.updateStatus('Thinking...');

    this.mediaRecorder.onstop = async () => {
      if (this.audioChunks.length === 0) {
        this.resetState();
        return;
      }
      const audioBlob = new Blob(this.audioChunks, {
        type: 'audio/webm',
      });
      const audioStream = audioBlob.stream();
      const base64Audio = await streamToBase64(audioStream);

      try {
        const audioPart = {
          inlineData: {
            data: base64Audio,
            mimeType: 'audio/webm',
          },
        };

        // Explicit language instruction
        const textPart = {
          text: `Please respond in ${this.selectedLanguage}.`,
        };

        // Get current date and time in IST
        const now = new Date();
        const istDate = now.toLocaleDateString('en-GB', {
          timeZone: 'Asia/Kolkata',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        });
        const istTime = now.toLocaleTimeString('en-US', {
          timeZone: 'Asia/Kolkata',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        });

        const systemInstruction = `You are Bharat Ai, an AI assistant developed by ArshXcoder. Keep your responses concise and conversational. The current date in India is ${istDate} and the current time is ${istTime} (Indian Standard Time). If asked about the date or time, provide this information.`;

        const stream = await this.client.models.generateContentStream({
          model: 'gemini-2.5-flash',
          contents: {parts: [textPart, audioPart]},
          config: {
            systemInstruction,
            thinkingConfig: {thinkingBudget: 0},
          },
        });

        // Clear previous speech queue
        window.speechSynthesis.cancel();
        this.sentenceQueue = [];
        this.isSpeaking = false;

        let accumulatedText = '';
        for await (const chunk of stream) {
          // If we get the first chunk, update status.
          if (!this.isSpeaking && this.sentenceQueue.length === 0) {
            this.updateStatus('Speaking...');
          }
          accumulatedText += chunk.text;

          // Split by sentence-ending punctuation. Using lookbehind to keep delimiter.
          const sentenceEnders = /(?<=[.?!])\s*/;
          const sentences = accumulatedText.split(sentenceEnders);

          // The last part might be an incomplete sentence, so we keep it for the next chunk.
          accumulatedText = sentences.pop() || '';

          for (const sentence of sentences) {
            if (sentence.trim()) {
              this.queueAndSpeak(sentence.trim());
            }
          }
        }
        // Queue any remaining text.
        if (accumulatedText.trim()) {
          this.queueAndSpeak(accumulatedText.trim());
        }

        // If nothing was ever queued to be spoken (e.g., empty response), reset.
        if (!this.isSpeaking && this.sentenceQueue.length === 0) {
          this.resetState();
        }
      } catch (e) {
        console.error(e);
        this.updateError('Sorry, I had trouble understanding that.');
        this.resetState();
      }
    };

    this.mediaRecorder.stop();
    this.mediaRecorder.stream.getTracks().forEach((track) => track.stop());
  }

  private queueAndSpeak(sentence: string) {
    this.sentenceQueue.push(sentence);
    if (!this.isSpeaking) {
      this.speakNextSentence();
    }
  }

  private speakNextSentence() {
    if (this.sentenceQueue.length === 0) {
      this.isSpeaking = false;
      // Short delay to allow visualizer to calm down before resetting status
      setTimeout(() => {
        if (!this.isSpeaking && this.sentenceQueue.length === 0) {
          this.resetState();
        }
      }, 500);
      return;
    }

    this.isSpeaking = true;
    const text = this.sentenceQueue.shift()!;
    const utterance = new SpeechSynthesisUtterance(text);

    // Set the language for the utterance for correct voice synthesis
    utterance.lang = this.selectedLanguageCode;

    // Apply voice settings
    if (this.selectedVoiceURI) {
      const selectedVoice = this.availableVoices.find(
        (voice) => voice.voiceURI === this.selectedVoiceURI,
      );
      // Only use the selected voice if its language matches the current language, otherwise let the browser decide
      if (
        selectedVoice &&
        selectedVoice.lang.startsWith(this.selectedLanguageCode.split('-')[0])
      ) {
        utterance.voice = selectedVoice;
      }
    }
    utterance.pitch = this.voicePitch;
    utterance.rate = this.voiceRate;

    utterance.onend = () => {
      this.speakNextSentence();
    };

    utterance.onerror = (e) => {
      console.error('Speech synthesis error:', e);
      this.updateError('Sorry, there was an error speaking the response.');
      // Clear queue and reset state on error
      this.sentenceQueue = [];
      this.isSpeaking = false;
      this.resetState();
    };

    window.speechSynthesis.speak(utterance);
  }

  private resetState() {
    this.updateStatus('Tap the mic to speak');
    this.isRecording = false;
  }

  private handleLanguageChange(e: Event) {
    const selectedIndex = (e.target as HTMLSelectElement).selectedIndex;
    const selectedLang = LANGUAGES[selectedIndex];
    this.selectedLanguage = selectedLang.name;
    this.selectedLanguageCode = selectedLang.code;

    // Stop any ongoing speech when language changes
    window.speechSynthesis.cancel();
    this.sentenceQueue = [];
    this.isSpeaking = false;
  }

  private renderSettings() {
    return html`
      <div class="settings-panel">
        <h3>Voice Settings</h3>
        <label for="voice-select">Voice</label>
        <select
          id="voice-select"
          .value=${this.selectedVoiceURI}
          @change=${(e: Event) =>
            (this.selectedVoiceURI = (e.target as HTMLSelectElement).value)}>
          ${this.availableVoices.map(
            (voice) =>
              html`<option value=${voice.voiceURI}
                >${voice.name} (${voice.lang})</option
              >`,
          )}
        </select>

        <label for="rate-slider">Rate: ${this.voiceRate.toFixed(1)}</label>
        <input
          type="range"
          id="rate-slider"
          min="0.1"
          max="2"
          step="0.1"
          .value=${this.voiceRate}
          @input=${(e: Event) =>
            (this.voiceRate = parseFloat(
              (e.target as HTMLInputElement).value,
            ))} />

        <label for="pitch-slider">Pitch: ${this.voicePitch.toFixed(1)}</label>
        <input
          type="range"
          id="pitch-slider"
          min="0"
          max="2"
          step="0.1"
          .value=${this.voicePitch}
          @input=${(e: Event) =>
            (this.voicePitch = parseFloat(
              (e.target as HTMLInputElement).value,
            ))} />
      </div>
    `;
  }

  render() {
    return html`
      <div>
        <div class="title-container">
          <h1>Bharat Ai</h1>
          <p>developed by ArshXcoder</p>
        </div>

        <div class="controls">
          <button
            id="micButton"
            class="mic-button ${this.isRecording ? 'recording' : ''}"
            @click=${this.handleMicClick}
            aria-label=${
              this.isRecording ? 'Stop recording' : 'Start recording'
            }>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="48px"
              viewBox="0 -960 960 960"
              width="48px"
              fill="#ffffff">
              <path
                d="M480-480q-17 0-28.5-11.5T440-520v-200q0-17 11.5-28.5T480-760q17 0 28.5 11.5T520-720v200q0 17-11.5 28.5T480-480ZM280-120q-17 0-28.5-11.5T240-160v-80q0-92 58-164.5T440-494v-126q-17 0-28.5-11.5T400-660v-120q0-17 11.5-28.5T440-820h80q17 0 28.5 11.5T560-780v120q0 17-11.5 28.5T520-620v126q94 28 152 100.5T730-240v80q0 17-11.5 28.5T680-120q-17 0-28.5-11.5T640-160v-80q0-66-47-113t-113-47q-66 0-113 47t-47 113v80q0 17-11.5 28.5T280-120Z" />
            </svg>
          </button>
        </div>

        <div class="language-selector-container">
          <select @change=${this.handleLanguageChange}>
            ${LANGUAGES.map(
              (lang) =>
                html`<option
                  value=${lang.code}
                  ?selected=${lang.name === this.selectedLanguage}
                  >${lang.name}</option
                >`,
            )}
          </select>
        </div>

        <button
          class="settings-toggle-button"
          @click=${() => (this.settingsOpen = !this.settingsOpen)}
          aria-label="Toggle voice settings">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            height="24px"
            viewBox="0 -960 960 960"
            width="24px"
            fill="#ffffff">
            <path
              d="m382-208-42-42 100-100-100-100 42-42 100 100 100-100 42 42-100 100 100 100-42 42-100-100-100 100ZM480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Z" />
          </svg>
        </button>

        ${this.settingsOpen ? this.renderSettings() : ''}

        <div id="status"> ${this.error || this.status} </div>
        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${
            this.outputNode
          }></gdm-live-audio-visuals-3d>
      </div>
    `;
  }
}