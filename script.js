/**
 * 漫画風リアルタイム字幕オーバーレイ（OBS向け）
 * ------------------------------------------------------------
 * - Web Speech API（webkitSpeechRecognition）で日本語連続認識
 * - ページ離脱時に認識を解放（メモリリーク対策）
 */

// -----------------------------------------------------------------------------
// 定数（チューニングはここをまとめて調整すると分かりやすい）
// -----------------------------------------------------------------------------

/** 音声認識の言語（日本語） */
const SPEECH_LANG = "ja-JP";

/** 字幕が最後の更新から消えるまでの時間（下限・上限・初期値は秒ベースで UI と対応） */
const SUBTITLE_HIDE_DELAY_MIN_MS = 1000;
const SUBTITLE_HIDE_DELAY_MAX_MS = 120000;

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

/** しっぽの向き（select の value・`data-tail-direction` と一致） */
const TAIL_DIRECTIONS = [
  "left",
  "right",
  "bottom",
  "top-left",
  "top-right",
  "side-left",
  "side-right",
  "side-top",
];

/** 折り返し文字数の許容範囲（幅は CSS の `N * 1ch` で近似） */
const WRAP_CHAR_MIN = 6;
const WRAP_CHAR_MAX = 80;

/** 初回表示時の見た目・挙動のデフォルト */
const DEFAULT_APPEARANCE = {
  fontPreset: "default",
  textColor: "#111111",
  bubbleBorderColor: "#111111",
  tailDirection: "left",
  subtitleHideDelayMs: 4000,
  wrapCharCount: 24,
  verticalTextEnabled: false,
};

/** 現在の「字幕が消えるまで」の待ち時間（設定パネルと同期） */
let subtitleHideDelayMs = DEFAULT_APPEARANCE.subtitleHideDelayMs;

// -----------------------------------------------------------------------------
// グローバル参照（クリーンアップ用に保持）
// -----------------------------------------------------------------------------

/** @type {SpeechRecognition | null} */
let recognition = null;

/** @type {ReturnType<typeof setTimeout> | null} */
let subtitleHideTimerId = null;

/** @type {ReturnType<typeof setTimeout> | null} */
let recognitionRestartTimerId = null;

let userStopped = false;

// DOM
const statusPanel = document.getElementById("status-panel");
const statusMessage = document.getElementById("status-message");
const startButton = document.getElementById("start-button");
const bubbleWrap = document.getElementById("bubble-wrap");
const subtitleEl = document.getElementById("subtitle");
const fontPresetSelect = document.getElementById("font-preset-select");
const textColorInput = document.getElementById("text-color-input");
const textColorHex = document.getElementById("text-color-hex");
const bubbleBorderColorInput = document.getElementById("bubble-border-color-input");
const bubbleBorderColorHex = document.getElementById("bubble-border-color-hex");
const tailDirectionSelect = document.getElementById("tail-direction-select");
const subtitleDurationInput = document.getElementById("subtitle-duration-input");
const wrapCharCountInput = document.getElementById("wrap-char-count-input");
const verticalTextEnabledInput = document.getElementById("vertical-text-enabled");

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
 * 字幕が消えるまでの待ち時間を許容範囲に収める
 * @param {number} ms
 * @returns {number}
 */
function clampSubtitleHideDelayMs(ms) {
  const n = Math.round(Number(ms));
  if (!Number.isFinite(n)) {
    return DEFAULT_APPEARANCE.subtitleHideDelayMs;
  }
  return Math.min(SUBTITLE_HIDE_DELAY_MAX_MS, Math.max(SUBTITLE_HIDE_DELAY_MIN_MS, n));
}

/**
 * 折り返し文字数を許容範囲に収める
 * @param {number} n
 * @returns {number}
 */
function clampWrapCharCount(n) {
  const rounded = Math.round(Number(n));
  if (!Number.isFinite(rounded)) {
    return DEFAULT_APPEARANCE.wrapCharCount;
  }
  return Math.min(WRAP_CHAR_MAX, Math.max(WRAP_CHAR_MIN, rounded));
}

/**
 * #rrggbb 形式の色かどうか
 * @param {unknown} value
 * @returns {value is string}
 */
function isHexColor(value) {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

/**
 * localStorage から表示設定を読み込む（壊れた JSON はデフォルトへ）
 * @returns {{
 *   fontPreset: string,
 *   textColor: string,
 *   bubbleBorderColor: string,
 *   tailDirection: string,
 *   subtitleHideDelayMs: number,
 *   wrapCharCount: number,
 *   verticalTextEnabled: boolean
 * }}
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
    const textColor = isHexColor(parsed.textColor)
      ? parsed.textColor
      : DEFAULT_APPEARANCE.textColor;
    const bubbleBorderColor = isHexColor(parsed.bubbleBorderColor)
      ? parsed.bubbleBorderColor
      : DEFAULT_APPEARANCE.bubbleBorderColor;
    const tailDirection =
      typeof parsed.tailDirection === "string" && TAIL_DIRECTIONS.includes(parsed.tailDirection)
        ? parsed.tailDirection
        : DEFAULT_APPEARANCE.tailDirection;
    const subtitleHideDelayMs =
      typeof parsed.subtitleHideDelayMs === "number" && Number.isFinite(parsed.subtitleHideDelayMs)
        ? clampSubtitleHideDelayMs(parsed.subtitleHideDelayMs)
        : DEFAULT_APPEARANCE.subtitleHideDelayMs;
    const wrapCharCount =
      typeof parsed.wrapCharCount === "number" && Number.isFinite(parsed.wrapCharCount)
        ? clampWrapCharCount(parsed.wrapCharCount)
        : DEFAULT_APPEARANCE.wrapCharCount;
    const verticalTextEnabled =
      typeof parsed.verticalTextEnabled === "boolean"
        ? parsed.verticalTextEnabled
        : DEFAULT_APPEARANCE.verticalTextEnabled;
    return {
      fontPreset,
      textColor,
      bubbleBorderColor,
      tailDirection,
      subtitleHideDelayMs,
      wrapCharCount,
      verticalTextEnabled,
    };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

/**
 * 表示設定を localStorage に保存（失敗してもアプリは継続）
 * @param {{
 *   fontPreset: string,
 *   textColor: string,
 *   bubbleBorderColor: string,
 *   tailDirection: string,
 *   subtitleHideDelayMs: number,
 *   wrapCharCount: number,
 *   verticalTextEnabled: boolean
 * }} state
 */
function saveAppearance(state) {
  try {
    localStorage.setItem(STORAGE_APPEARANCE_KEY, JSON.stringify(state));
  } catch {
    // プライベートモード等では保存できない場合がある
  }
}

/**
 * CSS 変数・吹き出し属性・字幕タイマー用の待ち時間へ反映
 * @param {{
 *   fontPreset: string,
 *   textColor: string,
 *   bubbleBorderColor: string,
 *   tailDirection: string,
 *   subtitleHideDelayMs: number,
 *   wrapCharCount: number,
 *   verticalTextEnabled: boolean
 * }} state
 */
function applyAppearanceToDocument(state) {
  const stack = FONT_PRESETS[state.fontPreset] || FONT_PRESETS.default;
  document.documentElement.style.setProperty("--subtitle-font-family", stack);
  document.documentElement.style.setProperty("--subtitle-color", state.textColor);
  document.documentElement.style.setProperty(
    "--bubble-border-color",
    isHexColor(state.bubbleBorderColor)
      ? state.bubbleBorderColor
      : DEFAULT_APPEARANCE.bubbleBorderColor,
  );
  document.documentElement.style.setProperty(
    "--subtitle-wrap-ch",
    String(clampWrapCharCount(state.wrapCharCount ?? DEFAULT_APPEARANCE.wrapCharCount)),
  );
  document.documentElement.classList.toggle(
    "vertical-text-mode",
    Boolean(state.verticalTextEnabled),
  );

  if (bubbleWrap) {
    const tail =
      typeof state.tailDirection === "string" && TAIL_DIRECTIONS.includes(state.tailDirection)
        ? state.tailDirection
        : DEFAULT_APPEARANCE.tailDirection;
    bubbleWrap.setAttribute("data-tail-direction", tail);
  }

  subtitleHideDelayMs = clampSubtitleHideDelayMs(
    state.subtitleHideDelayMs ?? DEFAULT_APPEARANCE.subtitleHideDelayMs,
  );
}

/**
 * フォームの値を表示設定オブジェクトにそろえる
 * @returns {{
 *   fontPreset: string,
 *   textColor: string,
 *   bubbleBorderColor: string,
 *   tailDirection: string,
 *   subtitleHideDelayMs: number,
 *   wrapCharCount: number,
 *   verticalTextEnabled: boolean
 * }}
 */
function readAppearanceFromForm() {
  const fontPreset =
    fontPresetSelect && fontPresetSelect.value in FONT_PRESETS
      ? fontPresetSelect.value
      : DEFAULT_APPEARANCE.fontPreset;
  const textColor = textColorInput && isHexColor(textColorInput.value)
    ? textColorInput.value
    : DEFAULT_APPEARANCE.textColor;
  const bubbleBorderColor = bubbleBorderColorInput && isHexColor(bubbleBorderColorInput.value)
    ? bubbleBorderColorInput.value
    : DEFAULT_APPEARANCE.bubbleBorderColor;
  const tailDirection =
    tailDirectionSelect && TAIL_DIRECTIONS.includes(tailDirectionSelect.value)
      ? tailDirectionSelect.value
      : DEFAULT_APPEARANCE.tailDirection;

  let seconds = DEFAULT_APPEARANCE.subtitleHideDelayMs / 1000;
  if (subtitleDurationInput && subtitleDurationInput.value !== "") {
    const n = Number(subtitleDurationInput.value);
    if (Number.isFinite(n)) {
      seconds = n;
    }
  }
  const subtitleHideDelayMs = clampSubtitleHideDelayMs(seconds * 1000);

  let wrapChars = DEFAULT_APPEARANCE.wrapCharCount;
  if (wrapCharCountInput && wrapCharCountInput.value !== "") {
    const w = Number(wrapCharCountInput.value);
    if (Number.isFinite(w)) {
      wrapChars = w;
    }
  }
  const wrapCharCount = clampWrapCharCount(wrapChars);
  const verticalTextEnabled = Boolean(verticalTextEnabledInput?.checked);

  return {
    fontPreset,
    textColor,
    bubbleBorderColor,
    tailDirection,
    subtitleHideDelayMs,
    wrapCharCount,
    verticalTextEnabled,
  };
}

/**
 * 保存済み設定をフォームに流し込む
 * @param {{
 *   fontPreset: string,
 *   textColor: string,
 *   bubbleBorderColor: string,
 *   tailDirection: string,
 *   subtitleHideDelayMs: number,
 *   wrapCharCount: number,
 *   verticalTextEnabled: boolean
 * }} state
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
  if (bubbleBorderColorInput) {
    bubbleBorderColorInput.value = isHexColor(state.bubbleBorderColor)
      ? state.bubbleBorderColor
      : DEFAULT_APPEARANCE.bubbleBorderColor;
  }
  if (bubbleBorderColorHex) {
    bubbleBorderColorHex.textContent = isHexColor(state.bubbleBorderColor)
      ? state.bubbleBorderColor
      : DEFAULT_APPEARANCE.bubbleBorderColor;
  }
  if (tailDirectionSelect) {
    tailDirectionSelect.value = TAIL_DIRECTIONS.includes(state.tailDirection)
      ? state.tailDirection
      : DEFAULT_APPEARANCE.tailDirection;
  }
  if (subtitleDurationInput) {
    const sec = clampSubtitleHideDelayMs(state.subtitleHideDelayMs) / 1000;
    subtitleDurationInput.value = String(Math.round(sec));
  }
  if (wrapCharCountInput) {
    wrapCharCountInput.value = String(clampWrapCharCount(state.wrapCharCount));
  }
  if (verticalTextEnabledInput) {
    verticalTextEnabledInput.checked = Boolean(state.verticalTextEnabled);
  }
}

/**
 * 字幕表示中に「消えるまで」の秒数だけ変えたとき、残り時間を張り直す
 */
function reapplySubtitleTimerIfVisible() {
  if (!bubbleWrap || bubbleWrap.classList.contains("bubble-wrap--hidden")) {
    return;
  }
  if (!subtitleEl || !subtitleEl.textContent.trim()) {
    return;
  }
  armSubtitleHideTimer();
}

/**
 * 下部パネル：見た目設定の変更を監視して即時反映＆保存
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

  if (bubbleBorderColorInput) {
    bubbleBorderColorInput.addEventListener("input", () => {
      const state = readAppearanceFromForm();
      applyAppearanceToDocument(state);
      if (bubbleBorderColorHex) {
        bubbleBorderColorHex.textContent = state.bubbleBorderColor;
      }
    });

    bubbleBorderColorInput.addEventListener("change", () => {
      saveAppearance(readAppearanceFromForm());
    });
  }

  if (tailDirectionSelect) {
    tailDirectionSelect.addEventListener("change", () => {
      const state = readAppearanceFromForm();
      applyAppearanceToDocument(state);
      saveAppearance(state);
    });
  }

  if (subtitleDurationInput) {
    subtitleDurationInput.addEventListener("input", () => {
      const state = readAppearanceFromForm();
      applyAppearanceToDocument(state);
      reapplySubtitleTimerIfVisible();
    });
    subtitleDurationInput.addEventListener("change", () => {
      const state = readAppearanceFromForm();
      applyAppearanceToDocument(state);
      syncFormFromAppearance(state);
      saveAppearance(state);
      reapplySubtitleTimerIfVisible();
    });
  }

  if (wrapCharCountInput) {
    wrapCharCountInput.addEventListener("input", () => {
      const state = readAppearanceFromForm();
      applyAppearanceToDocument(state);
    });
    wrapCharCountInput.addEventListener("change", () => {
      const state = readAppearanceFromForm();
      applyAppearanceToDocument(state);
      syncFormFromAppearance(state);
      saveAppearance(state);
    });
  }

  if (verticalTextEnabledInput) {
    verticalTextEnabledInput.addEventListener("change", () => {
      const state = readAppearanceFromForm();
      applyAppearanceToDocument(state);
      saveAppearance(state);
    });
  }
}

/**
 * ステータス文言を更新（配信前のエラー表示など）
 * @param {string} message
 */
function setStatusMessage(message) {
  statusMessage.textContent = message;
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
  }, subtitleHideDelayMs);
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
 * （マイクはブラウザ・OS の既定入力を使用）
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

  try {
    recognition.start();
  } catch (e) {
    setStatusMessage(`音声認識を開始できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    startButton.disabled = false;
  }
}

/**
 * メイン開始処理：音声認識のみ開始
 */
function handleStartClick() {
  userStopped = false;
  startButton.disabled = true;
  setStatusMessage("音声認識を開始しています…");

  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    setStatusMessage("このブラウザは Web Speech API（音声認識）に非対応です。Chrome を使用してください。");
    startButton.disabled = false;
    return;
  }

  startSpeechRecognition();
}

/**
 * ユーザーが明示的に停止（キーボードなど）
 */
function handleUserStopAll() {
  userStopped = true;
  teardownSpeechRecognition();
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
  startButton.addEventListener("click", handleStartClick);

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

  setStatusMessage("準備完了です。「認識を開始」を押すと音声認識が始まります（マイク許可を求められることがあります）。");
}

document.addEventListener("DOMContentLoaded", init);
