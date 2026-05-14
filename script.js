/**
 * 漫画風リアルタイム字幕オーバーレイ（OBS向け）
 * ------------------------------------------------------------
 * - Web Speech API（webkitSpeechRecognition）で日本語連続認識
 * - Web Audio API でマイク音量を解析し、吹き出しの見た目を3段階で変化
 * - requestAnimationFrame で音量ループ（無駄な setInterval を避ける）
 * - ページ離脱時にマイク・AudioContext・認識を解放（メモリリーク対策）
 */

// -----------------------------------------------------------------------------
// 定数（チューニングはここをまとめて調整すると分かりやすい）
// -----------------------------------------------------------------------------

/** 音声認識の言語（日本語） */
const SPEECH_LANG = "ja-JP";

/** 字幕が最後の更新から何 ms 無音扱いで消えるか */
const SUBTITLE_HIDE_DELAY_MS = 4000;

/** 音量の指数移動平均の係数（大きいほどなめらか・反応遅め） */
const VOLUME_SMOOTHING = 0.88;

/** 音量段階のしきい値（0〜1 正規化 RMS ベース。環境に合わせて調整） */
const VOLUME_TIER_THRESHOLDS = {
  /** これ未満は「通常」。それ以上は「大声」 */
  normalMax: 0.3,
};

/** AnalyserNode の時間領域バッファ長（小さめで軽量） */
const ANALYSER_FFT_SIZE = 512;

/** 連続認識が勝手に終了した場合の自動再開までの待ち ms */
const RECOGNITION_RESTART_MS = 400;

/** 表示設定（フォント・色）の localStorage キー */
const STORAGE_APPEARANCE_KEY = "comic_overlay_appearance_v1";

/**
 * フォントプリセット（select の value と対応）
 * OS にインストール済みのフォント名を優先したスタック
 */
const FONT_PRESETS = {
  default: '"Segoe UI","Hiragino Sans","Hiragino Kaku Gothic ProN",Meiryo,sans-serif',
  gothic: 'Meiryo,"Hiragino Kaku Gothic ProN","Hiragino Sans",sans-serif',
  yugo: '"Yu Gothic UI","Yu Gothic",YuGothic,"Meiryo",sans-serif',
  msgothic: '"MS PGothic","MS Gothic","Hiragino Kaku Gothic ProN",sans-serif',
  mincho: '"Yu Mincho","YuMincho","MS PMincho","Hiragino Mincho ProN",serif',
};

/** 初回表示時の見た目デフォルト */
const DEFAULT_APPEARANCE = {
  fontPreset: "default",
  textColor: "#111111",
};

// -----------------------------------------------------------------------------
// グローバル参照（クリーンアップ用に保持）
// -----------------------------------------------------------------------------

let mediaStream = null;
let audioContext = null;
let mediaSourceNode = null;
let analyserNode = null;
let timeDomainData = null;

/** @type {SpeechRecognition | null} */
let recognition = null;

/** @type {number | null} */
let volumeRafId = null;

/** @type {ReturnType<typeof setTimeout> | null} */
let subtitleHideTimerId = null;

/** @type {ReturnType<typeof setTimeout> | null} */
let recognitionRestartTimerId = null;

let smoothedLevel = 0;
let userStopped = false;
let volumeTier = "normal";

// DOM
const statusPanel = document.getElementById("status-panel");
const statusMessage = document.getElementById("status-message");
const startButton = document.getElementById("start-button");
const bubbleWrap = document.getElementById("bubble-wrap");
const subtitleEl = document.getElementById("subtitle");
const fontPresetSelect = document.getElementById("font-preset-select");
const textColorInput = document.getElementById("text-color-input");
const textColorHex = document.getElementById("text-color-hex");

// -----------------------------------------------------------------------------
// ユーティリティ
// -----------------------------------------------------------------------------

/**
 * Web Speech API のコンストラクタを取得（Chrome / Edge 系は webkit 接頭辞）
 * @returns {typeof SpeechRecognition | null}
 */
function getSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

/**
 * localStorage から表示設定を読み込む（壊れた JSON はデフォルトへ）
 * @returns {{ fontPreset: string, textColor: string }}
 */
function loadAppearance() {
  try {
    const raw = localStorage.getItem(STORAGE_APPEARANCE_KEY);
    if (!raw) {
      return { ...DEFAULT_APPEARANCE };
    }
    const parsed = JSON.parse(raw);
    const fontPreset =
      typeof parsed.fontPreset === "string" && parsed.fontPreset in FONT_PRESETS
        ? parsed.fontPreset
        : DEFAULT_APPEARANCE.fontPreset;
    const textColor =
      typeof parsed.textColor === "string" && /^#[0-9a-fA-F]{6}$/.test(parsed.textColor)
        ? parsed.textColor
        : DEFAULT_APPEARANCE.textColor;
    return { fontPreset, textColor };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

/**
 * 表示設定を localStorage に保存（失敗してもアプリは継続）
 * @param {{ fontPreset: string, textColor: string }} state
 */
function saveAppearance(state) {
  try {
    localStorage.setItem(STORAGE_APPEARANCE_KEY, JSON.stringify(state));
  } catch {
    // プライベートモード等では保存できない場合がある
  }
}

/**
 * CSS 変数へ反映（字幕の font-family / color）
 * @param {{ fontPreset: string, textColor: string }} state
 */
function applyAppearanceToDocument(state) {
  const stack = FONT_PRESETS[state.fontPreset] || FONT_PRESETS.default;
  document.documentElement.style.setProperty("--subtitle-font-family", stack);
  document.documentElement.style.setProperty("--subtitle-color", state.textColor);
}

/**
 * フォームの値を表示設定オブジェクトにそろえる
 * @returns {{ fontPreset: string, textColor: string }}
 */
function readAppearanceFromForm() {
  const fontPreset =
    fontPresetSelect && fontPresetSelect.value in FONT_PRESETS
      ? fontPresetSelect.value
      : DEFAULT_APPEARANCE.fontPreset;
  const textColor = textColorInput && /^#[0-9a-fA-F]{6}$/.test(textColorInput.value)
    ? textColorInput.value
    : DEFAULT_APPEARANCE.textColor;
  return { fontPreset, textColor };
}

/**
 * 保存済み設定をフォームに流し込む
 * @param {{ fontPreset: string, textColor: string }} state
 */
function syncFormFromAppearance(state) {
  if (fontPresetSelect) {
    fontPresetSelect.value = state.fontPreset in FONT_PRESETS ? state.fontPreset : "default";
  }
  if (textColorInput) {
    textColorInput.value = state.textColor;
  }
  if (textColorHex) {
    textColorHex.textContent = state.textColor;
  }
}

/**
 * 下部パネル：フォント・文字色の変更を監視して即時反映＆保存
 */
function initAppearanceControls() {
  if (!fontPresetSelect || !textColorInput) {
    return;
  }

  const initial = loadAppearance();
  applyAppearanceToDocument(initial);
  syncFormFromAppearance(initial);

  fontPresetSelect.addEventListener("change", () => {
    const state = readAppearanceFromForm();
    applyAppearanceToDocument(state);
    saveAppearance(state);
  });

  textColorInput.addEventListener("input", () => {
    const state = readAppearanceFromForm();
    applyAppearanceToDocument(state);
    if (textColorHex) {
      textColorHex.textContent = state.textColor;
    }
  });

  textColorInput.addEventListener("change", () => {
    saveAppearance(readAppearanceFromForm());
  });
}

/**
 * ステータス文言を更新（配信前のエラー表示など）
 * @param {string} message
 */
function setStatusMessage(message) {
  statusMessage.textContent = message;
}

/**
 * 音量段階を決定
 * @param {number} level 0〜1
 * @returns {"quiet" | "normal" | "loud"}
 */
function resolveVolumeTier(level) {
  if (level < VOLUME_TIER_THRESHOLDS.normalMax) return "normal";
  return "loud";
}

/**
 * 吹き出しの data 属性を更新（CSS が見た目を切り替える）
 * @param {"quiet" | "normal" | "loud"} tier
 */
function applyVolumeTier(tier) {
  if (tier === volumeTier) return;
  volumeTier = tier;
  bubbleWrap.setAttribute("data-volume-tier", tier);
}

/**
 * 吹き出し出現アニメを再発火（同じ文言でも「弾ける」見た目を維持したい場合に使える）
 */
function replayBubbleEntrance() {
  bubbleWrap.classList.remove("bubble-wrap--animating-in");
  // 再フローでアニメーションをリセット
  void bubbleWrap.offsetWidth;
  bubbleWrap.classList.add("bubble-wrap--animating-in");
}

/**
 * 字幕を表示状態へ
 * @param {string} text
 * @param {boolean} isFinal 確定結果か（未確定は薄く扱うなど拡張用。現状は見た目共通）
 */
function showSubtitle(text, isFinal) {
  void isFinal; // 将来：未確定のみ斜体などに使える
  subtitleEl.textContent = text;
  bubbleWrap.classList.remove("bubble-wrap--hidden");
  bubbleWrap.setAttribute("aria-hidden", "false");
  replayBubbleEntrance();
  armSubtitleHideTimer();
}

/**
 * 字幕を非表示へ（一定時間後に呼ばれる）
 */
function hideSubtitle() {
  if (subtitleHideTimerId !== null) {
    clearTimeout(subtitleHideTimerId);
    subtitleHideTimerId = null;
  }
  subtitleEl.textContent = "";
  bubbleWrap.classList.add("bubble-wrap--hidden");
  bubbleWrap.classList.remove("bubble-wrap--animating-in");
  bubbleWrap.setAttribute("aria-hidden", "true");
}

/**
 * 字幕自動消去タイマーを張り直す（発話が続くたびに延長）
 */
function armSubtitleHideTimer() {
  if (subtitleHideTimerId !== null) {
    clearTimeout(subtitleHideTimerId);
  }
  subtitleHideTimerId = setTimeout(() => {
    subtitleHideTimerId = null;
    hideSubtitle();
  }, SUBTITLE_HIDE_DELAY_MS);
}

/**
 * 音量解析ループ（requestAnimationFrame）
 * メモリ：バッファは一度だけ生成し使い回す
 */
function volumeLoop() {
  if (!analyserNode || !timeDomainData) {
    volumeRafId = null;
    return;
  }

  analyserNode.getByteTimeDomainData(timeDomainData);

  let sumSquares = 0;
  for (let i = 0; i < timeDomainData.length; i += 1) {
    const v = (timeDomainData[i] - 128) / 128;
    sumSquares += v * v;
  }
  const rms = Math.sqrt(sumSquares / timeDomainData.length);

  // 0〜1 に正規化（実マイクではおおむね 0〜0.35 程度に収まることが多い）
  const instant = Math.min(1, rms * 4.2);
  smoothedLevel = smoothedLevel * VOLUME_SMOOTHING + instant * (1 - VOLUME_SMOOTHING);

  applyVolumeTier(resolveVolumeTier(smoothedLevel));

  volumeRafId = window.requestAnimationFrame(volumeLoop);
}

/**
 * Web Audio 周りの初期化
 * @param {MediaStream} stream
 */
async function setupWebAudio(stream) {
  teardownWebAudio();

  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  // ユーザー操作後でも suspended になりうるため明示的に再開
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
  mediaSourceNode = audioContext.createMediaStreamSource(stream);
  analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = ANALYSER_FFT_SIZE;
  analyserNode.smoothingTimeConstant = 0.65;

  mediaSourceNode.connect(analyserNode);
  // スピーカーへは接続しない（OBS では不要＆ハウリング防止）

  timeDomainData = new Uint8Array(analyserNode.fftSize);

  if (volumeRafId !== null) {
    cancelAnimationFrame(volumeRafId);
  }
  volumeRafId = window.requestAnimationFrame(volumeLoop);
}

/**
 * Web Audio の後始末
 */
function teardownWebAudio() {
  if (volumeRafId !== null) {
    cancelAnimationFrame(volumeRafId);
    volumeRafId = null;
  }
  if (analyserNode) {
    try {
      analyserNode.disconnect();
    } catch {
      // 既に切断済みでも安全に進める
    }
    analyserNode = null;
  }
  if (mediaSourceNode) {
    try {
      mediaSourceNode.disconnect();
    } catch {
      // noop
    }
    mediaSourceNode = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  timeDomainData = null;
  smoothedLevel = 0;
  applyVolumeTier("normal");
}

/**
 * マイクストリームのトラック停止
 */
function stopMediaTracks() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        // noop
      }
    });
    mediaStream = null;
  }
}

/**
 * 音声認識の停止とイベント解除
 */
function teardownSpeechRecognition() {
  if (recognitionRestartTimerId !== null) {
    clearTimeout(recognitionRestartTimerId);
    recognitionRestartTimerId = null;
  }
  if (!recognition) return;
  try {
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    recognition.onstart = null;
    recognition.stop();
  } catch {
    // noop
  }
  recognition = null;
}

/**
 * ページ離脱などで一括解放
 */
function disposeAll() {
  userStopped = true;
  teardownSpeechRecognition();
  teardownWebAudio();
  stopMediaTracks();
  if (subtitleHideTimerId !== null) {
    clearTimeout(subtitleHideTimerId);
    subtitleHideTimerId = null;
  }
}

/**
 * 音声認識のエラーコードを人間向けメッセージへ
 * @param {string} code
 */
function mapSpeechErrorToMessage(code) {
  switch (code) {
    case "not-allowed":
      return "マイクまたは音声認識がブラウザにより拒否されました。アドレスバーの許可設定を確認してください。";
    case "no-speech":
      return "音声が検出できませんでした（無音が続いた可能性）。マイク入力を確認してください。";
    case "aborted":
      return "音声認識が中断されました。";
    case "audio-capture":
      return "マイクが利用できません。他アプリの占有やデバイス切断を確認してください。";
    case "network":
      return "ネットワークエラーにより音声認識が利用できませんでした。";
    case "service-not-allowed":
      return "音声認識サービスが利用できません（ブラウザ設定やポリシーを確認）。";
    default:
      return `音声認識でエラーが発生しました（コード: ${code}）。`;
  }
}

/**
 * 音声認識をセットアップして開始
 * （マイクは getUserMedia で取得済み。認識エンジンはブラウザ既定の入力を使うことが多い）
 */
function startSpeechRecognition() {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    setStatusMessage("このブラウザは Web Speech API に対応していません。Chrome 系を推奨します。");
    startButton.disabled = false;
    return;
  }

  teardownSpeechRecognition();
  recognition = new Ctor();
  recognition.lang = SPEECH_LANG;
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onstart = () => {
    setStatusMessage("音声認識が動作中です。このパネルは非表示にして配信できます。");
    statusPanel.classList.add("status-panel--hidden");
  };

  recognition.onresult = (event) => {
    let interim = "";
    let finalText = "";

    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const res = event.results[i];
      const chunk = res[0].transcript;
      if (res.isFinal) {
        finalText += chunk;
      } else {
        interim += chunk;
      }
    }

    const composed = (finalText + interim).trim();
    if (composed) {
      showSubtitle(composed, finalText.length > 0);
    }
  };

  recognition.onerror = (event) => {
    const code = event.error || "unknown";
    // no-speech は無音時に頻発しうるため、致命的扱いにしない
    if (code === "no-speech") {
      return;
    }
    statusPanel.classList.remove("status-panel--hidden");
    setStatusMessage(mapSpeechErrorToMessage(code));
    if (code === "not-allowed" || code === "service-not-allowed") {
      userStopped = true;
      teardownSpeechRecognition();
      teardownWebAudio();
      stopMediaTracks();
      startButton.disabled = false;
    }
  };

  recognition.onend = () => {
    // ユーザーが明示停止していなければ、Chrome の仕様で切れても自動再開
    if (userStopped) return;
    if (recognitionRestartTimerId !== null) {
      clearTimeout(recognitionRestartTimerId);
    }
    recognitionRestartTimerId = setTimeout(() => {
      recognitionRestartTimerId = null;
      try {
        if (recognition && !userStopped) {
          recognition.start();
        }
      } catch {
        // 既に start 済みなどは無視
      }
    }, RECOGNITION_RESTART_MS);
  };

  // 注意: Chrome の SpeechRecognition はデフォルト入力デバイスを使うことが多いです。
  // getUserMedia で選んだマイクと一致しない場合は、OS の既定マイクを揃えてください。

  try {
    recognition.start();
  } catch (e) {
    setStatusMessage(`音声認識を開始できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    startButton.disabled = false;
  }
}

/**
 * メイン開始処理：マイク取得 → Web Audio → 音声認識
 */
async function handleStartClick() {
  userStopped = false;
  startButton.disabled = true;
  setStatusMessage("マイクへのアクセスを要求しています…");

  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    setStatusMessage("このブラウザは Web Speech API（音声認識）に非対応です。Chrome を使用してください。");
    startButton.disabled = false;
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      },
      video: false,
    });
  } catch (err) {
    statusPanel.classList.remove("status-panel--hidden");
    if (err && typeof err === "object" && "name" in err && err.name === "NotAllowedError") {
      setStatusMessage("マイクの使用が拒否されました。ブラウザのサイト設定でマイクを許可してください。");
    } else {
      setStatusMessage(`マイクの取得に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    }
    startButton.disabled = false;
    return;
  }

  try {
    await setupWebAudio(mediaStream);
    startSpeechRecognition();
  } catch (e) {
    setStatusMessage(`オーディオ初期化に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    stopMediaTracks();
    teardownWebAudio();
    startButton.disabled = false;
  }
}

/**
 * ユーザーが明示的に停止（キーボードなど）
 */
function handleUserStopAll() {
  userStopped = true;
  teardownSpeechRecognition();
  teardownWebAudio();
  stopMediaTracks();
  hideSubtitle();
  statusPanel.classList.remove("status-panel--hidden");
  setStatusMessage("停止しました。再開する場合は「認識を開始」を押してください。");
  startButton.disabled = false;
}

/**
 * タブを閉じる直前にリソースを解放
 */
function handleBeforeUnload() {
  disposeAll();
}

// -----------------------------------------------------------------------------
// 初期化
// -----------------------------------------------------------------------------

function init() {
  startButton.addEventListener("click", () => {
    void handleStartClick();
  });

  window.addEventListener("beforeunload", handleBeforeUnload);

  /** 配信中に止めたいとき用（OBS のブラウザソース上でフォーカスがある状態で押す） */
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      handleUserStopAll();
    }
  });

  initAppearanceControls();

  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    setStatusMessage("非対応ブラウザです。Chrome（PC）を推奨します。音声認識は開始できません。");
    startButton.disabled = true;
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatusMessage("getUserMedia に対応していません。HTTPS または localhost で開いてください。");
    startButton.disabled = true;
    return;
  }

  setStatusMessage("準備完了です。「認識を開始」を押すとマイク許可と音声認識が始まります。");
}

document.addEventListener("DOMContentLoaded", init);
