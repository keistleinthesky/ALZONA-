import { useState, useRef, useEffect, useCallback } from "react";
import { markSpeaking, hearingSelf, followAudio } from "./selfVoice";
// Her name lives in wake.js because the singing panel has to recognise it
// too — that is how the microphone gets handed back.
import { NAME, NAME_CJK } from "./wake";

// Uses the browser's built-in speech recognition (Chrome/Edge). This returns the
// user's ACTUAL words — or nothing on silence — so it never hallucinates random
// text the way audio-to-Gemini transcription does. It's also free (no quota).
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// Recognition failures are invisible from the outside: a denied microphone, a
// network error and simply nobody speaking all look the same — nothing
// happens. Every one of those has been mistaken for "she is ignoring me", so
// the panel now records what it is doing where it can be read back.
const trace = (baseUrl, line) => {
  try {
    const fd = new FormData();
    fd.append("line", "VOICE " + line);
    fetch(`${baseUrl}/debug_log`, { method: "POST", body: fd }).catch(() => {});
  } catch { /* telemetry must never break the thing it watches */ }
};

// Greetings in CJK scripts (no \b word boundaries — they don't work for CJK).
const GREET_CJK =
  "(?:こんにちは|こんばんは|おはよう(?:ございます)?|やあ|ねえ|ハロー|ハイ|" +
  "안녕하세요|안녕|여보세요|" +
  "你好|您好|哈喽|哈囉|嗨|早上好|下午好|晚上好)";

// Wake phrase: ANY greeting followed by ALZONA's name, e.g. "Hi Alzona",
// "Kumusta Alzona", "こんにちは アルゾナ", "안녕 알조나", "你好 阿尔佐纳".
// Once heard, she accepts ALL voice input until the stop phrase.
const WAKE_RE = new RegExp(
  "\\b(?:hey|hi|hello|heya|yo|greetings|kumusta|kamusta|mabuhay|" +
  "good\\s+(?:morning|afternoon|evening|day)|" +
  "magandang\\s+(?:umaga|hapon|gabi|araw)|okay|ok)[ ,!.]*" + NAME + "\\b" +
  "|" + GREET_CJK + "[、。，,!！?？・\\s]*" + NAME_CJK,
  "i"
);

// Stop phrase: "Thank you, Alzona" (thanks/salamat/ありがとう/감사합니다/谢谢)
// -> back to standby.
const STOP_RE = new RegExp(
  "\\b(?:thank\\s*you|thanks|salamat)(?:\\s*po)?[ ,!.]*" + NAME + "\\b" +
  "|(?:ありがとう(?:ございます|ございました)?|どうも|" +
  "감사합니다|감사해요|고마워요?|고맙습니다|" +
  "谢谢|謝謝|多谢|多謝)[、。，,!！?？・\\s]*" + NAME_CJK,
  "i"
);

// Speech-recognition languages the user can pick from (the Web Speech API
// cannot auto-detect the spoken language — it needs to be told).
const SR_LANGS = [
  { code: "en-US", label: "English" },
  { code: "fil-PH", label: "Filipino" },
  { code: "ja-JP", label: "日本語" },
  { code: "ko-KR", label: "한국어" },
  { code: "zh-CN", label: "中文" },
];

export default function VoiceRecorder({
  baseUrl = "http://localhost:5002",
  onResult = () => {},
  // True while the singing panel holds the microphone. Recognition insists on
  // owning the device, so it must actually STOP — not merely ignore what it
  // hears — or it restarts the singing side out of the microphone every second.
  suspended = false,
}) {

  const [recording, setRecording] = useState(false);
  const [responseText, setResponseText] = useState("");
  const [typedText, setTypedText] = useState("");
  const [sending, setSending] = useState(false);
  const [awake, setAwake] = useState(false);
  const [srLang, setSrLang] = useState("en-US");
  // Set when the browser refuses the microphone for THIS origin. Worth its
  // own state because it is not a transient error: nothing will ever be
  // heard until someone grants it, and the panel otherwise looks merely idle.
  const [micBlocked, setMicBlocked] = useState(false);

  // Ref mirrors so speech-recognition callbacks always see current values.
  const awakeRef = useRef(false);
  // Mirrored into a ref: the recognition callbacks and the 1s poll are both
  // closures created before a handover happens, and would otherwise keep
  // seeing the old value and grab the microphone straight back.
  const suspendedRef = useRef(false);
  const srLangRef = useRef("en-US");
  const lastPollTrace = useRef(0);

  const changeSrLang = (code) => {
    srLangRef.current = code;
    setSrLang(code);
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* restarts with new lang */ }
    }
  };

  const wakeUp = () => {
    awakeRef.current = true;
    setAwake(true);
  };

  const goToSleep = () => {
    awakeRef.current = false;
    setAwake(false);
  };

  const recognitionRef = useRef(null);
  // Blocks auto-listen while recording / processing / ALZONA is speaking, so the
  // mic can never pick up ALZONA's own voice.
  const busyRef = useRef(false);

  const finishBusy = () => {
    setTimeout(() => { busyRef.current = false; }, 800);    // cooldown after speaking
  };

  const sendText = async (text) => {
    try {
      const form = new FormData();
      form.append("text", text);
      form.append("skip_tts", "1");   // text now, audio in parallel via /say
      const res = await fetch(`${baseUrl}/command`, { method: "POST", body: form });
      const data = await res.json();
      const abs = (u) => (u ? `${baseUrl}${u}` : null);
      setResponseText(data.reply || text || "");
      onResult({
        transcript: data.transcript || text,
        reply: data.reply,
        mode: data.mode,
        image_url: abs(data.image_url),
        video_url: abs(data.video_url),
        command: data.command,
        // Forward these too. The backend answers a spoken or typed "harmonize
        // me in alto" with a sing directive and "identify this coin" with the
        // coin fields, and dropping them here meant the command was understood,
        // answered out loud, and then quietly had no effect on the panel it was
        // about. On the other console the singing panel has its own ear and
        // received them by another route, which is what hid this.
        sing: data.sing,
        coin: data.coin,
      });
      // Reply is already on screen; fetch and play the voice when it's ready.
      if (data.reply) {
        sayInAlzonaVoice(data.reply);
      } else {
        finishBusy();
      }
    } catch (err) {
      console.error("Command failed:", err);
      finishBusy();
    }
  };

  const startRecording = () => {
    if (!SR || recording || busyRef.current || suspendedRef.current) {
      trace(baseUrl, `blocked sr=${!!SR} rec=${recording} `
        + `busy=${busyRef.current} suspended=${suspendedRef.current}`);
      return;
    }
    busyRef.current = true;
    const r = new SR();
    r.lang = srLangRef.current;   // user-selected recognition language
    r.interimResults = true;   // react to quiet speech as it forms
    r.maxAlternatives = 5;     // quiet audio often has the wake phrase in a lower-ranked guess
    r.continuous = true;       // don't cut off at the first brief pause

    let finals = [];           // best transcript of each finished segment
    let alts = [];             // every alternative heard (checked for wake/stop phrases)
    let stopTimer = null;

    // Stop ~1.2s after the last recognition activity, so slow or soft
    // speakers aren't cut off mid-sentence.
    const scheduleStop = () => {
      clearTimeout(stopTimer);
      stopTimer = setTimeout(() => { try { r.stop(); } catch { /* already stopped */ } }, 1200);
    };

    r.onstart = () => {
      setRecording(true);
      setMicBlocked(false);
      trace(baseUrl, 'listening');
    };
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const seg = e.results[i];
        if (!seg.isFinal) continue;
        const best = (seg[0].transcript || "").trim();
        if (best) finals.push(best);
        for (let j = 0; j < seg.length; j++) {
          const t = (seg[j].transcript || "").trim();
          if (t) alts.push(t);
        }
      }
      scheduleStop();          // any activity (even interim) extends the window
    };
    // "no-speech" is ordinary and handled in onend; "not-allowed" means the
    // microphone was refused and nothing will ever work until that is fixed.
    r.onerror = (e) => {
      const err = e?.error || 'unknown';
      trace(baseUrl, `error ${err}`);
      // Permission is granted per ORIGIN — scheme, host AND port — so allowing
      // the microphone on one console grants nothing to the other, which runs
      // on a different port. That trips people up every time.
      if (err === 'not-allowed' || err === 'service-not-allowed') setMicBlocked(true);
    };
    r.onend = () => {
      clearTimeout(stopTimer);
      setRecording(false);

      const heard = finals.join(" ").trim();
      // Best transcript first, then recognition alternatives as fallbacks.
      const candidates = heard ? [heard, ...alts] : alts;
      trace(baseUrl, `heard=${JSON.stringify(heard)} `
        + `alts=${JSON.stringify(alts.slice(0, 4))} awake=${awakeRef.current}`);
      if (!candidates.length) {
        finishBusy();          // silence -> do nothing (no hallucination)
        return;
      }

      // "Thank you, Alzona" -> stop accepting voice input.
      if (awakeRef.current && candidates.some((t) => STOP_RE.test(t))) {
        goToSleep();
        sayInAlzonaVoice("You're welcome! Just greet me again when you need me.");
        return;
      }

      // Find the wake phrase in the best transcript OR any alternative.
      let wakeSource = null;
      let wakeMatch = null;
      for (const t of candidates) {
        const m = t.match(WAKE_RE);
        if (m) { wakeSource = t; wakeMatch = m; break; }
      }

      if (!awakeRef.current) {
        if (!wakeMatch) {
          finishBusy();        // asleep + no greeting -> ignore completely
          return;
        }
        // Greeting + name heard -> ALZONA is awake until the stop phrase.
        wakeUp();
        const command = wakeSource
          .slice(wakeMatch.index + wakeMatch[0].length)
          .replace(/^[\s,.!?]+/, "")
          .trim();
        if (command) {
          sendText(command);   // greeting + command in one breath
        } else {
          sayInAlzonaVoice("Hello! I'm listening. How can I help you?");
        }
        return;
      }

      // Awake: everything is a command (strip a repeated greeting if present).
      let command = heard || candidates[0];
      if (wakeMatch && wakeSource === command) {
        const rest = command
          .slice(wakeMatch.index + wakeMatch[0].length)
          .replace(/^[\s,.!?]+/, "")
          .trim();
        if (rest) command = rest;
      }
      sendText(command);
    };

    recognitionRef.current = r;
    try { r.start(); } catch { busyRef.current = false; }
  };

  const stopRecording = useCallback(() => {
    if (recognitionRef.current) recognitionRef.current.stop();
  }, []);

  // Hand the microphone over to the singing panel. Nothing here waits for
  // recognition to finish its sentence: the singer is already singing, and a
  // recogniser holding the device is exactly what stops the harmony hearing
  // them. Coming back the other way needs no action — the 1s poll re-arms on
  // its own once `suspended` clears.
  useEffect(() => {
    suspendedRef.current = suspended;
    if (suspended) {
      try { stopRecording(); } catch { /* already stopped */ }
    }
    // stopRecording is redefined every render; the body is idempotent, so
    // re-running it costs nothing and keeps the dependency list honest.
  }, [suspended, stopRecording]);

  // Speak a short phrase in ALZONA's own voice (backend /say). Falls back to
  // the browser voice only if the backend can't synthesize (e.g. TTS quota).
  const sayInAlzonaVoice = async (text) => {
    try {
      const form = new FormData();
      form.append("text", text);
      const res = await fetch(`${baseUrl}/say`, { method: "POST", body: form });
      const data = await res.json();
      if (data.tts_url) {
        // followAudio, not just a flag here: this plays out of the same
        // speakers the singing panel's microphone is listening to, and that
        // panel has no other way of knowing this reply is hers.
        const audio = followAudio(new Audio(`${baseUrl}${data.tts_url}?t=${Date.now()}`));
        audio.onended = finishBusy;
        audio.onerror = finishBusy;
        markSpeaking();          // cover the gap before the first timeupdate
        await audio.play();
        return;
      }
    } catch {
      // fall through to browser voice
    }
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(text);
      // Synthesis reports no progress events worth trusting, so hold the
      // window open on a timer and let it lapse the moment speaking stops.
      const holdOpen = setInterval(() => markSpeaking(), 250);
      const done = () => { clearInterval(holdOpen); markSpeaking(); finishBusy(); };
      u.onend = done;
      u.onerror = done;
      window.speechSynthesis.cancel();
      markSpeaking();
      window.speechSynthesis.speak(u);
    } else {
      finishBusy();
    }
  };

  // Typed input goes through the same /command path as voice.
  const handleTypedSubmit = async (e) => {
    e.preventDefault();
    const text = typedText.trim();
    if (!text || sending) return;
    busyRef.current = true;      // pause auto-listen while ALZONA responds
    setSending(true);
    setTypedText("");
    await sendText(text);
    setSending(false);
  };

  // Auto-listen when a face is present, but only when not busy.
  useEffect(() => {
    if (!SR) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${baseUrl}/state`);
        if (!res.ok) return;
        const data = await res.json();
        const ready =
          data.face_state === "ALZONA" &&
          !recording &&
          !busyRef.current &&
          !suspendedRef.current &&
          !hearingSelf(performance.now());
        if (ready) {
          startRecording();
        } else if (performance.now() - lastPollTrace.current > 5000) {
          // Throttled: one line every 5s is enough to see which gate is shut,
          // without burying the singing telemetry in the same log.
          lastPollTrace.current = performance.now();
          trace(baseUrl, `idle face=${data.face_state} rec=${recording} `
            + `busy=${busyRef.current} suspended=${suspendedRef.current} `
            + `self=${hearingSelf(performance.now())}`);
        }
      } catch {
        // silent
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [recording, baseUrl]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        {awake ? (
          <span className="text-sm font-semibold text-emerald-400">
            Awake — listening (say “Thank you, Alzona” to stop)
          </span>
        ) : recording ? (
          <span className="text-sm text-amber-400">
            Standby — greet ALZONA to activate
          </span>
        ) : micBlocked ? (
          <span className="text-sm font-semibold text-rose-300">
            Microphone blocked for this page — allow it from the icon in the
            address bar. Permission is per port, so allowing it on another
            console does not cover this one.
          </span>
        ) : (
          <span className="text-sm text-white/60">Microphone ready</span>
        )}
        {!SR && <span className="text-sm text-red-400">Use Chrome/Edge for voice</span>}
        <select
          value={srLang}
          onChange={(e) => changeSrLang(e.target.value)}
          title="Microphone language"
          className="ml-auto rounded-lg border border-white/15 bg-black/30 px-2 py-1 text-xs text-white/85 outline-none focus:border-sky-400/60"
        >
          {SR_LANGS.map((l) => (
            <option key={l.code} value={l.code} className="bg-[#171457]">
              {l.label}
            </option>
          ))}
        </select>
      </div>

      <form onSubmit={handleTypedSubmit} className="flex items-center gap-2">
        <input
          type="text"
          value={typedText}
          onChange={(e) => setTypedText(e.target.value)}
          placeholder="Type a message..."
          className="min-w-0 flex-1 rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white placeholder-white/40 outline-none focus:border-sky-400/60"
        />
        <button
          type="submit"
          disabled={sending || !typedText.trim()}
          className="rounded-lg border border-sky-400/30 bg-sky-400/10 px-4 py-2 text-sm font-semibold text-sky-200 transition hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {sending ? "..." : "Send"}
        </button>
      </form>

      {/* <div className="mt-2 rounded-lg bg-[rgba(0,0,0,0.18)] p-3">
        <p className="text-xs uppercase tracking-wider text-white/60">AI Response</p>
        <p className="mt-1 text-sm text-white/90">{responseText || 'No transcript yet.'}</p>
      </div> */}
    </div>
  );
}
